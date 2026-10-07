// Permission-aware retrieval over Confluence, used by the Confluence connector (index.ts).
//
// 1. The asker's keys come from the Atlassian account they linked with Connect Jira (people.ts).
// 2. Elasticsearch filters by both permission layers inside the query (space View AND page restriction),
//    so other pages are never scored or returned.
// 3. Every matching page is re-checked with Confluence's own permission check, as the asker, right now.
//    Anything unconfirmed is withheld.
import type { estypes } from "@elastic/elasticsearch";
import type { AuditDoc, Decision } from "../../audit/chain.js";
import { config } from "../../config.js";
import { embedQuery } from "../../embeddings.js";
import { es } from "../../es.js";
import { resolveRetrievalMode, rrfFuse } from "../../hybrid.js";
import { withSpan } from "../../tracing.js";
import { canSeeConfluence, confluenceFilter, recheck, type LiveCheck } from "./acl.js";
import { canRead, explain, isAuthError } from "./client.js";
import { confluenceConfig } from "./config.js";
import type { ConfluenceDoc } from "./docs.js";
import { confluenceAccess } from "./people.js";
import { confluenceStatus } from "./sync.js";

export type Hit = estypes.SearchHit<ConfluenceDoc>;

// Keyword leg. keys = null only for the server-side audit query.
function confluenceQuery(q: string, keys: string[] | null, size: number, onePerPage: boolean) {
  return {
    index: confluenceConfig.index,
    size,
    query: { bool: { must: [{ multi_match: { query: q, fields: ["title^3", "text"] } }], filter: keys ? confluenceFilter(keys) : [] } },
    ...(onePerPage ? { collapse: { field: "page_id" } } : {}),
  };
}

const highlight = {
  fields: { text: { fragment_size: 220, number_of_fragments: 2 } },
  encoder: "html" as const,
  pre_tags: ["<mark>"],
  post_tags: ["</mark>"],
};

// Semantic leg, with both permission layers INSIDE the knn clause (never a post_filter).
async function vectorHits(q: string, keys: string[]): Promise<Hit[]> {
  if (resolveRetrievalMode() !== "hybrid") return [];
  try {
    const vector = await withSpan("confluence.embed.query", { text: q }, () => embedQuery(q));
    const k = config.hybridCandidates;
    const r = await es.search<ConfluenceDoc>({
      index: confluenceConfig.index,
      knn: { field: "text_vector", query_vector: vector, k, num_candidates: k * 2, filter: confluenceFilter(keys) },
      size: k,
      _source: { excludes: ["text_vector"] },
    });
    return r.hits.hits;
  } catch (e) {
    console.warn("Confluence vector search failed, using keyword search only:", String((e as any)?.message ?? e));
    return [];
  }
}

async function candidates(q: string, keys: string[], opts: { size: number; onePerPage: boolean; vectorQuery?: string }): Promise<Hit[]> {
  const hybrid = resolveRetrievalMode() === "hybrid";
  const [bm25, knn] = await Promise.all([
    es.search<ConfluenceDoc>({
      ...confluenceQuery(q, keys, hybrid ? config.hybridCandidates : opts.size, opts.onePerPage && !hybrid),
      highlight,
      _source: { excludes: ["text_vector"] },
    }),
    vectorHits(opts.vectorQuery ?? q, keys),
  ]);
  if (!hybrid) return bm25.hits.hits;

  const byId = new Map<string, Hit>();
  for (const h of [...knn, ...bm25.hits.hits]) byId.set(h._id!, h); // BM25 copy wins: it carries the highlight
  const fused = rrfFuse([bm25.hits.hits.map((h) => h._id!), knn.map((h) => h._id!)]).map((f) => byId.get(f.id)!);
  const seen = new Set<string>();
  const out = opts.onePerPage ? fused.filter((h) => !seen.has(h._source!.page_id) && !!seen.add(h._source!.page_id)) : fused;
  return out.slice(0, opts.size);
}

// One permission check per page (Confluence has no bulk form), a few in parallel. A failed check withholds that page.
async function liveChecks(accountId: string, pageIds: string[]): Promise<Map<string, LiveCheck>> {
  const out = new Map<string, LiveCheck>();
  const queue = [...pageIds];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        out.set(id, (await canRead(accountId, id)) ? { state: "ok" } : { state: "denied" });
      } catch (e) {
        out.set(id, { state: "error", error: explain(e) });
        if (isAuthError(e)) Object.assign(confluenceStatus, { authError: true, lastError: explain(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  return out;
}

const auditDoc = (d: ConfluenceDoc, decision: Decision, reason?: string): AuditDoc => ({
  doc_id: d.doc_id,
  source: "confluence",
  title: d.title,
  path: `${d.space_key}/${d.title}`,
  decision,
  ...(reason ? { reason } : {}),
});

export async function retrieve(personId: string, q: string, opts: { size: number; onePerPage: boolean; vectorQuery?: string }) {
  const access = await confluenceAccess(personId);
  if (!access) return { allowed: [] as Hit[], audit: [] as AuditDoc[] }; // not linked: nothing (fail closed)

  const hits = await candidates(q, access.keys, opts);
  const live = await liveChecks(access.accountId, [...new Set(hits.map((h) => h._source!.page_id))]);
  const allowed: Hit[] = [];
  const dropped: AuditDoc[] = [];
  for (const h of hits) {
    const d = recheck(live.get(h._source!.page_id));
    if (d.ok) allowed.push(h);
    else dropped.push(auditDoc(h._source!, "dropped", d.reason));
  }

  // Admin audit only: pages that matched but this person can't read. Never returned to them.
  const shadow = await es.search<ConfluenceDoc>({
    ...confluenceQuery(q, null, 50, true),
    _source: ["doc_id", "page_id", "title", "space_key", "acl_container", "restricted", "acl_item"],
  });
  const denied = shadow.hits.hits
    .map((h) => h._source!)
    .filter((d) => !canSeeConfluence(d, access.keys))
    .map((d) => auditDoc(d, "denied", d.restricted ? "not in this page's view restriction" : "no View permission on this space"));

  return { allowed, audit: [...allowed.map((h) => auditDoc(h._source!, "allowed")), ...dropped, ...denied] };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Chunk text starts with the title line for search; results and prompts carry the title separately.
export function bodyOf(d: Pick<ConfluenceDoc, "title" | "text">): string {
  return d.text.startsWith(d.title) ? d.text.slice(d.title.length).trimStart() : d.text;
}

export function snippetOf(h: Hit): string {
  const d = h._source!;
  const fragments = h.highlight?.text?.filter(Boolean);
  return fragments?.length ? fragments.join(" … ") : escapeHtml(bodyOf(d).slice(0, 300));
}
