// Permission-aware retrieval over Jira, used by the Jira connector (index.ts).
//
// 1. The asker's keys come from the Atlassian account they linked with Connect Jira (people.ts).
// 2. Elasticsearch filters by both permission layers inside the query (project browse AND security level),
//    so other issues are never scored or returned.
// 3. Every matching issue is re-checked with Jira's own bulk permission check, as the asker, right now.
//    That catches anything the labels approximate or haven't caught up with yet; anything unconfirmed is withheld.
import type { estypes } from "@elastic/elasticsearch";
import type { AuditDoc, Decision } from "../../audit/chain.js";
import { config } from "../../config.js";
import { embedQuery } from "../../embeddings.js";
import { es } from "../../es.js";
import { resolveRetrievalMode, rrfFuse } from "../../hybrid.js";
import { withSpan } from "../../tracing.js";
import { canSeeJira, jiraFilter, recheck, type LiveCheck } from "./acl.js";
import { browsableIssues, explain, isAuthError } from "./client.js";
import { jiraConfig } from "./config.js";
import type { JiraDoc } from "./docs.js";
import { jiraAccess } from "./people.js";
import { jiraStatus } from "./sync.js";

export type Hit = estypes.SearchHit<JiraDoc>;

const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

// Keyword leg. An issue key in the question ("what happened in PAY-240?") matches that issue exactly.
// keys = null only for the server-side audit query.
function jiraQuery(q: string, keys: string[] | null, size: number, onePerIssue: boolean) {
  const issueKeys = [...new Set(q.toUpperCase().match(ISSUE_KEY) ?? [])];
  return {
    index: jiraConfig.index,
    size,
    query: {
      bool: {
        should: [
          { multi_match: { query: q, fields: ["summary^3", "text"] } },
          ...(issueKeys.length ? [{ terms: { issue_key: issueKeys, boost: 10 } }] : []),
        ],
        minimum_should_match: 1,
        filter: keys ? jiraFilter(keys) : [],
      },
    },
    ...(onePerIssue ? { collapse: { field: "issue_id" } } : {}),
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
    const vector = await withSpan("jira.embed.query", { text: q }, () => embedQuery(q));
    const k = config.hybridCandidates;
    const r = await es.search<JiraDoc>({
      index: jiraConfig.index,
      knn: { field: "text_vector", query_vector: vector, k, num_candidates: k * 2, filter: jiraFilter(keys) },
      size: k,
      _source: { excludes: ["text_vector"] },
    });
    return r.hits.hits;
  } catch (e) {
    console.warn("Jira vector search failed, using keyword search only:", String((e as any)?.message ?? e));
    return [];
  }
}

async function candidates(q: string, keys: string[], opts: { size: number; onePerIssue: boolean; vectorQuery?: string }): Promise<Hit[]> {
  const hybrid = resolveRetrievalMode() === "hybrid";
  const [bm25, knn] = await Promise.all([
    es.search<JiraDoc>({
      ...jiraQuery(q, keys, hybrid ? config.hybridCandidates : opts.size, opts.onePerIssue && !hybrid),
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
  const out = opts.onePerIssue ? fused.filter((h) => !seen.has(h._source!.issue_id) && !!seen.add(h._source!.issue_id)) : fused;
  return out.slice(0, opts.size);
}

// One call for all matching issues. Any failure withholds all of them (fail closed).
async function liveChecks(accountId: string, issueIds: string[]): Promise<Map<string, LiveCheck>> {
  const out = new Map<string, LiveCheck>();
  if (!issueIds.length) return out;
  try {
    const ok = await browsableIssues(accountId, issueIds);
    for (const id of issueIds) out.set(id, ok.has(id) ? { state: "ok" } : { state: "denied" });
  } catch (e) {
    for (const id of issueIds) out.set(id, { state: "error", error: explain(e) });
    if (isAuthError(e)) Object.assign(jiraStatus, { authError: true, lastError: explain(e) });
  }
  return out;
}

const auditDoc = (d: JiraDoc, decision: Decision, reason?: string): AuditDoc => ({
  doc_id: d.doc_id,
  source: "jira",
  title: `${d.issue_key}: ${d.summary}`,
  path: d.project_name,
  decision,
  ...(reason ? { reason } : {}),
});

export async function retrieve(personId: string, q: string, opts: { size: number; onePerIssue: boolean; vectorQuery?: string }) {
  const access = await jiraAccess(personId);
  if (!access) return { allowed: [] as Hit[], audit: [] as AuditDoc[] }; // Jira not connected: nothing (fail closed)

  const hits = await candidates(q, access.keys, opts);
  const live = await liveChecks(access.accountId, [...new Set(hits.map((h) => h._source!.issue_id))]);
  const allowed: Hit[] = [];
  const dropped: AuditDoc[] = [];
  for (const h of hits) {
    const d = recheck(live.get(h._source!.issue_id));
    if (d.ok) allowed.push(h);
    else dropped.push(auditDoc(h._source!, "dropped", d.reason));
  }

  // Admin audit only: issues that matched but this person can't browse. Never returned to them.
  const shadow = await es.search<JiraDoc>({
    ...jiraQuery(q, null, 50, true),
    _source: ["doc_id", "issue_id", "issue_key", "summary", "project_name", "acl_container", "restricted", "acl_item"],
  });
  const denied = shadow.hits.hits
    .map((h) => h._source!)
    .filter((d) => !canSeeJira(d, access.keys))
    .map((d) => auditDoc(d, "denied", d.restricted ? "not in this issue's project or security level" : "no Browse permission on this project"));

  return { allowed, audit: [...allowed.map((h) => auditDoc(h._source!, "allowed")), ...dropped, ...denied] };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Chunk text starts with a "KEY: summary" line for search; results and prompts carry that separately.
export function bodyOf(d: Pick<JiraDoc, "issue_key" | "summary" | "text">): string {
  const header = `${d.issue_key}: ${d.summary}`;
  return d.text.startsWith(header) ? d.text.slice(header.length).trimStart() : d.text;
}

export function snippetOf(h: Hit): string {
  const d = h._source!;
  const fragments = h.highlight?.text?.filter(Boolean);
  return fragments?.length ? fragments.join(" … ") : escapeHtml(bodyOf(d).slice(0, 300));
}
