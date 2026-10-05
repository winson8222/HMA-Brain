// Elasticsearch storage for Jira: chunk docs (`brain-jira`) and sync state (`brain-jira-state`).
// Separate from Slack's `brain` and Drive's `brain-drive`, so one source's backfill never touches another's data.
import { config } from "../../config.js";
import { embeddingConfigured, withVectors } from "../../embeddings.js";
import { es } from "../../es.js";
import { jiraConfig } from "./config.js";
import type { JiraDoc, ProjectAcl } from "./docs.js";

const INDEX = jiraConfig.index;
const STATE = jiraConfig.stateIndex;

const docMappings = {
  properties: {
    doc_id: { type: "keyword" },
    source: { type: "keyword" },
    issue_id: { type: "keyword" },
    issue_key: { type: "keyword" },
    project_id: { type: "keyword" },
    project_key: { type: "keyword" },
    project_name: { type: "keyword" },
    chunk_index: { type: "integer" },
    summary: { type: "text", fields: { keyword: { type: "keyword" } } },
    status: { type: "keyword" },
    issue_type: { type: "keyword" },
    text: { type: "text" },
    reporter_id: { type: "keyword" },
    reporter_name: { type: "keyword" },
    assignee_id: { type: "keyword" },
    assignee_name: { type: "keyword" },
    created_at: { type: "date" },
    updated_at: { type: "date" },
    ts: { type: "date" },
    permalink: { type: "keyword", index: false },
    acl_container: { type: "keyword" },
    restricted: { type: "boolean" },
    acl_item: { type: "keyword" },
    security_level: { type: "keyword" },
    content_hash: { type: "keyword" },
    ...(config.embeddingDims
      ? { text_vector: { type: "dense_vector", dims: config.embeddingDims, index: true, similarity: "cosine" } as const }
      : {}),
  },
} as const;

export async function ensureJiraIndices() {
  if (!(await es.indices.exists({ index: INDEX }))) await es.indices.create({ index: INDEX, mappings: docMappings });
  if (!(await es.indices.exists({ index: STATE }))) await es.indices.create({ index: STATE, mappings: { dynamic: false, properties: { kind: { type: "keyword" } } } });
}

export async function resetJiraIndices() {
  await es.indices.delete({ index: [INDEX, STATE], ignore_unavailable: true });
  await ensureJiraIndices();
}

// ---- chunk docs ----

// Upsert first, then remove leftover chunks of the previous version, so an issue is never missing mid-update.
export async function writeIssueDocs(issueId: string, docs: JiraDoc[]): Promise<boolean> {
  const withVec = await withVectors(docs);
  const r = await es.bulk({ operations: withVec.flatMap((d) => [{ index: { _index: INDEX, _id: d.doc_id } }, d]), refresh: true });
  if (r.errors) throw new Error("Bulk index had errors: " + JSON.stringify(r.items.find((i) => i.index?.error)));
  await es.deleteByQuery({
    index: INDEX,
    refresh: true,
    conflicts: "proceed",
    query: {
      bool: {
        filter: [{ term: { issue_id: issueId } }],
        should: [{ range: { chunk_index: { gte: docs.length } } }, { bool: { must_not: { term: { content_hash: docs[0].content_hash } } } }],
        minimum_should_match: 1,
      },
    },
  });
  return !embeddingConfigured() || withVec.every((d) => "text_vector" in d);
}

export async function deleteIssueDocs(issueIds: string[]) {
  if (!issueIds.length) return;
  await es.deleteByQuery({ index: INDEX, refresh: true, conflicts: "proceed", query: { terms: { issue_id: issueIds } } });
}

export async function deleteProjectDocs(projectId: string) {
  await es.deleteByQuery({ index: INDEX, refresh: true, conflicts: "proceed", query: { term: { project_id: projectId } } });
}

// Issue ID → content hash, for one project (or all), to skip unchanged issues and find deleted ones.
export async function indexedIssues(projectId?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after: Record<string, string> | undefined;
  for (;;) {
    const r = await es.search({
      index: INDEX,
      size: 0,
      query: projectId ? { term: { project_id: projectId } } : { match_all: {} },
      aggs: {
        issues: {
          composite: { size: 1000, sources: [{ id: { terms: { field: "issue_id" } } }], ...(after ? { after } : {}) },
          aggs: { hash: { terms: { field: "content_hash", size: 1 } } },
        },
      },
    });
    const agg = r.aggregations?.issues as any;
    for (const b of agg?.buckets ?? []) out.set(String(b.key.id), String(b.hash.buckets[0]?.key ?? ""));
    if (!agg?.after_key || !agg.buckets.length) return out;
    after = agg.after_key;
  }
}

export const countDocs = async () => (await es.count({ index: INDEX })).count;

// ---- sync state ----

async function getState<T>(id: string): Promise<T | undefined> {
  try {
    return (await es.get<T>({ index: STATE, id }))._source;
  } catch (e: any) {
    if (e?.meta?.statusCode === 404) return undefined;
    throw e;
  }
}

export type ProjectState = ProjectAcl & { kind: "project"; synced_at: string };
export const getProjectState = (id: string) => getState<ProjectState>(`project:${id}`);
export const putProjectState = (p: ProjectAcl) =>
  es.index({ index: STATE, id: `project:${p.project_id}`, document: { kind: "project", ...p, synced_at: new Date().toISOString() }, refresh: true });
export async function allProjectStates(): Promise<ProjectState[]> {
  const r = await es.search<ProjectState>({ index: STATE, size: 1000, query: { term: { kind: "project" } } });
  return r.hits.hits.map((h) => h._source!);
}
export async function deleteProjectState(id: string) {
  await es.delete({ index: STATE, id: `project:${id}`, refresh: true }, { ignore: [404] });
}

export type ConnectorState = { kind: "connector"; account_id: string | null; last_backfill_at: string | null; last_poll_at: string | null; cursor: string | null };
export const getConnector = () => getState<ConnectorState>("connector");
export async function putConnector(patch: Partial<ConnectorState>) {
  await es.update({ index: STATE, id: "connector", doc: { kind: "connector", ...patch }, doc_as_upsert: true, refresh: true });
}

// ---- person → Atlassian account, set by "Connect Jira" ----

export type LinkState = { kind: "link"; person_id: string; account_id: string; account_name: string | null; linked_at: string };
const linkKey = (personId: string) => `link:${personId}`;
export const getLink = (personId: string) => getState<LinkState>(linkKey(personId));
export async function allLinks(): Promise<LinkState[]> {
  const r = await es.search<LinkState>({ index: STATE, size: 10000, query: { term: { kind: "link" } } });
  return r.hits.hits.map((h) => h._source!);
}
// One Atlassian account belongs to one person: linking it again moves it.
export async function putLink(personId: string, accountId: string, accountName: string | null) {
  for (const l of await allLinks()) if (l.account_id === accountId && l.person_id !== personId) await deleteLink(l.person_id);
  const doc: LinkState = { kind: "link", person_id: personId, account_id: accountId, account_name: accountName, linked_at: new Date().toISOString() };
  await es.index({ index: STATE, id: linkKey(personId), document: doc, refresh: true });
}
export async function deleteLink(personId: string) {
  await es.delete({ index: STATE, id: linkKey(personId), refresh: true }, { ignore: [404] });
}
