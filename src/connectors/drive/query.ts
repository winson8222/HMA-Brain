// Permission-aware Search and Ask over Drive.
//
// 1. The asker's keys come from their email (acl.ts driveKeysFor).
// 2. Elasticsearch filters by those keys inside the query, so other files are never scored or returned.
// 3. Each file that matched is re-read from Drive right now; anything no longer shared is dropped
//    (covers the gap until the next poll relabels it, which also happens right away here).
// 4. Only chunks that pass both checks are shown or given to the LLM.
// 5. Every search and answer is written to the tamper-evident audit log before anything is returned.
import type { estypes } from "@elastic/elasticsearch";
import { canSee } from "../../acl.js";
import { appendAudit } from "../../audit/store.js";
import type { AuditDoc, AuditRecord, Decision } from "../../audit/chain.js";
import { config } from "../../config.js";
import { embedQuery } from "../../embeddings.js";
import { es } from "../../es.js";
import { knnQuery, resolveRetrievalMode, rrfFuse } from "../../hybrid.js";
import { chat } from "../../llm.js";
import { withSpan } from "../../tracing.js";
import { aclHash, driveKeysFor, permsToAcl, recheck, type LiveCheck } from "./acl.js";
import { explain, getMeta, isAuthError } from "./client.js";
import { driveConfig } from "./config.js";
import type { DriveDoc } from "./docs.js";
import { ANSWER_RULES, bodyOf, buildContext, citedNumbers, KEYWORD_RULES, NO_INFO } from "./prompt.js";
import { relabelFile } from "./store.js";
import { access } from "../../audit/events.js";
import { recordItemChange } from "../../audit/record.js";
import { driveStatus } from "./sync.js";

type Hit = estypes.SearchHit<DriveDoc>;

// What a person gets back: content fields only. No labels, no counts, nothing about withheld files.
export type DriveResult = {
  title: string;
  path: string;
  heading: string | null;
  snippet: string; // HTML: escaped text with <mark> highlights
  modified_at: string | null;
  permalink: string;
  mime_type: string;
};

export type DriveAnswer = { answer: string; keywords: string; sources: (DriveResult & { n: number })[] };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// keys = null only for the server-side audit query below.
function driveQuery(q: string, keys: string[] | null, size: number, onePerFile: boolean) {
  return {
    index: driveConfig.index,
    size,
    query: {
      bool: {
        must: { multi_match: { query: q, fields: ["title^3", "text"] } },
        filter: keys ? [{ terms: { acl_container: keys } }] : [],
      },
    },
    ...(onePerFile ? { collapse: { field: "file_id" } } : {}),
  };
}

const highlight = {
  fields: { text: { fragment_size: 220, number_of_fragments: 2 } },
  encoder: "html" as const,
  pre_tags: ["<mark>"],
  post_tags: ["</mark>"],
};

async function liveChecks(fileIds: string[]): Promise<Map<string, LiveCheck>> {
  const out = new Map<string, LiveCheck>();
  await Promise.all(
    fileIds.map(async (id) => {
      try {
        const m = await getMeta(id);
        out.set(id, !m ? { state: "gone" } : m.trashed ? { state: "trashed" } : { state: "ok", acl: permsToAcl(m.permissions) });
      } catch (e) {
        out.set(id, { state: "error", error: explain(e) }); // withheld: fail closed
        if (isAuthError(e)) Object.assign(driveStatus, { authError: true, lastError: explain(e) }); // show "reconnect"
      }
    }),
  );
  return out;
}

const auditDoc = (d: DriveDoc, decision: Decision, reason?: string): AuditDoc => ({
  doc_id: d.doc_id,
  source: "drive",
  title: d.title,
  path: d.path,
  decision,
  ...(reason ? { reason } : {}),
});

// Semantic leg: the question's vector against chunk vectors, with the same permission keys INSIDE the knn
// clause. Empty (keyword search only) when embeddings are off, the index has no vectors, or embedding fails.
async function vectorHits(q: string, keys: string[]): Promise<Hit[]> {
  if (resolveRetrievalMode() !== "hybrid") return [];
  try {
    const vector = await withSpan("drive.embed.query", { text: q }, () => embedQuery(q));
    const r = await es.search<DriveDoc>({ ...knnQuery(vector, keys, undefined, undefined, driveConfig.index), _source: { excludes: ["text_vector"] } });
    return r.hits.hits;
  } catch (e) {
    console.warn("Drive vector search failed, using keyword search only:", String((e as any)?.message ?? e));
    return [];
  }
}

// Filtered search: other people's files never leave Elasticsearch. Keyword (BM25) and, when configured,
// vector search run in parallel and are merged with reciprocal rank fusion, like Slack's hybrid search.
async function candidates(q: string, keys: string[], opts: { size: number; onePerFile: boolean; vectorQuery?: string }): Promise<Hit[]> {
  const hybrid = resolveRetrievalMode() === "hybrid";
  const [bm25, knn] = await Promise.all([
    es.search<DriveDoc>({
      ...driveQuery(q, keys, hybrid ? config.hybridCandidates : opts.size, opts.onePerFile && !hybrid),
      highlight,
      _source: { excludes: ["text_vector"] },
    }),
    vectorHits(opts.vectorQuery ?? q, keys),
  ]);
  if (!hybrid) return bm25.hits.hits;

  const byId = new Map<string, Hit>();
  for (const h of [...knn, ...bm25.hits.hits]) byId.set(h._id!, h); // BM25 copy wins: it carries the highlight
  const fused = rrfFuse([bm25.hits.hits.map((h) => h._id!), knn.map((h) => h._id!)]).map((f) => byId.get(f.id)!);
  const seenFiles = new Set<string>();
  const out = opts.onePerFile ? fused.filter((h) => !seenFiles.has(h._source!.file_id) && !!seenFiles.add(h._source!.file_id)) : fused;
  return out.slice(0, opts.size);
}

export async function retrieve(email: string, q: string, opts: { size: number; onePerFile: boolean; vectorQuery?: string }) {
  const keys = driveKeysFor(email);
  const hits = await candidates(q, keys, opts);

  // Live re-check with Drive, one call per matching file.
  const live = await liveChecks([...new Set(hits.map((h) => h._source!.file_id))]);
  const allowed: Hit[] = [];
  const dropped: AuditDoc[] = [];
  for (const h of hits) {
    const d = recheck(live.get(h._source!.file_id), keys);
    if (d.ok) allowed.push(h);
    else dropped.push(auditDoc(h._source!, "dropped", d.reason));
  }

  // Admin audit only: files that matched but aren't shared with this person. Never returned to them.
  const shadow = await es.search<DriveDoc>({
    ...driveQuery(q, null, 50, true),
    _source: ["doc_id", "file_id", "title", "path", "acl_container"],
  });
  const denied = shadow.hits.hits
    .map((h) => h._source!)
    .filter((d) => !canSee(d.acl_container, keys))
    .map((d) => auditDoc(d, "denied", "not shared with this person"));

  // The index was behind Drive: fix the labels now instead of waiting for the next poll.
  for (const [fileId, l] of live) {
    const doc = hits.find((h) => h._source!.file_id === fileId)!._source!;
    const stored = doc.acl_container;
    if (l.state === "ok" && aclHash(l.acl) !== aclHash([...stored].sort())) {
      const was = { title: doc.title, path: doc.path, access: access(stored), modified_at: null };
      relabelFile(fileId, l.acl)
        .then(() => recordItemChange("drive", "live-recheck", `drive:${fileId}`, was, { ...was, access: access(l.acl) }, { contentChanged: false }))
        .catch((e) => console.error(`Drive relabel ${fileId}: ${explain(e)}`));
    }
  }

  return { allowed, audit: [...allowed.map((h) => auditDoc(h._source!, "allowed")), ...dropped, ...denied] };
}

// ES's HTML encoder also escapes "/" and "'"; undo that to compare with the plain header.
const unescapeHtml = (s: string) =>
  s.replace(/&#x2F;/g, "/").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Highlight fragments can start with the chunk's "Title (path)" line; the result already shows both.
function dropHeader(fragment: string, d: DriveDoc): string {
  const nl = fragment.indexOf("\n");
  if (nl < 0) return fragment;
  const first = unescapeHtml(fragment.slice(0, nl).replace(/<\/?mark>/g, ""));
  return `${d.title} (${d.path})`.endsWith(first.trim()) ? fragment.slice(nl + 1).trimStart() : fragment;
}

export function toResult(h: Hit): DriveResult {
  const d = h._source!;
  const fragments = h.highlight?.text?.map((f) => dropHeader(f, d)).filter(Boolean);
  return {
    title: d.title,
    path: d.path,
    heading: d.heading,
    snippet: fragments?.length ? fragments.join(" … ") : escapeHtml(bodyOf(d).slice(0, 300)),
    modified_at: d.modified_at,
    permalink: d.permalink,
    mime_type: d.mime_type,
  };
}

// Returns the audit record too, for the admin CLI; the web API sends only `results`.
export async function driveSearch(email: string, q: string, via = "web"): Promise<{ results: DriveResult[]; record: AuditRecord }> {
  const { allowed, audit } = await retrieve(email, q, { size: 10, onePerFile: true });
  const record = await appendAudit({ actor: email, kind: "search", via, sources: ["drive"], query: q, docs: audit });
  return { results: allowed.map(toResult), record };
}

// Questions are full of words like "what" and "the"; turn them into search keywords first.
async function toKeywords(question: string): Promise<string> {
  try {
    const k = await chat(
      [
        { role: "system", content: KEYWORD_RULES },
        { role: "user", content: question },
      ],
      { maxTokens: 1500, timeoutMs: 10_000, attempts: 2 },
    );
    const kw = k.replace(/[\n"]/g, " ").trim();
    return kw && kw.split(/\s+/).length <= 20 ? kw : question; // a long reply is prose (e.g. a refusal), not keywords
  } catch {
    return question;
  }
}

// Returns the audit record too, for the admin CLI; the web API sends only `answer`.
export async function driveAsk(email: string, question: string, via = "web"): Promise<{ answer: DriveAnswer; record: AuditRecord }> {
  const keywords = await toKeywords(question);
  const { allowed, audit } = await retrieve(email, keywords, { size: 8, onePerFile: false, vectorQuery: question });

  let answer = NO_INFO;
  let failure: string | null = null;
  if (allowed.length) {
    try {
      // Only chunks this person may see right now are ever put in the prompt.
      answer = await chat([
        { role: "system", content: ANSWER_RULES },
        { role: "user", content: `Excerpts:\n\n${buildContext(allowed.map((h) => h._source!))}\n\nQuestion: ${question}` },
      ], { timeoutMs: 25_000, attempts: 3 });
    } catch (e: any) {
      failure = String(e?.message ?? e);
    }
  }

  const cited = citedNumbers(answer);
  let n = 0;
  for (const d of audit) if (d.decision === "allowed" && cited.has(++n)) d.cited = true;
  // No answer goes out without its audit record.
  const record = await appendAudit({
    actor: email,
    kind: "ask",
    via,
    sources: ["drive"],
    query: question,
    keywords,
    answer: failure ? `(no answer: ${failure})` : answer,
    docs: audit,
  });
  if (failure) throw new Error(failure);

  const sources = allowed.map((h, i) => ({ n: i + 1, ...toResult(h) })).filter((s) => cited.has(s.n));
  return { answer: { answer, keywords, sources }, record };
}
