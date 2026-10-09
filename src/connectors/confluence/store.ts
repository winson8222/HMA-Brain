// Elasticsearch storage for Confluence: chunk docs (`brain-confluence`) and sync state (`brain-confluence-state`).
// Separate from the Slack, Drive and Jira indexes, so one source's backfill never touches another's data.
import { config } from "../../config.js";
import { embeddingConfigured, withVectors } from "../../embeddings.js";
import { es } from "../../es.js";
import { confluenceConfig } from "./config.js";
import type { ConfluenceDoc, SpaceAcl } from "./docs.js";

const INDEX = confluenceConfig.index;
const STATE = confluenceConfig.stateIndex;

const docMappings = {
  properties: {
    doc_id: { type: "keyword" },
    source: { type: "keyword" },
    page_id: { type: "keyword" },
    space_id: { type: "keyword" },
    space_key: { type: "keyword" },
    space_name: { type: "keyword" },
    parent_id: { type: "keyword" },
    chunk_index: { type: "integer" },
    title: { type: "text", fields: { keyword: { type: "keyword" } } },
    text: { type: "text" },
    author_id: { type: "keyword" },
    author_name: { type: "keyword" },
    created_at: { type: "date" },
    updated_at: { type: "date" },
    version: { type: "integer" },
    ts: { type: "date" },
    permalink: { type: "keyword", index: false },
    acl_container: { type: "keyword" },
    restricted: { type: "boolean" },
    acl_item: { type: "keyword" },
    content_hash: { type: "keyword" },
    ...(config.embeddingDims
      ? { text_vector: { type: "dense_vector", dims: config.embeddingDims, index: true, similarity: "cosine" } as const }
      : {}),
  },
} as const;

const stateMappings = {
  dynamic: false,
  properties: { kind: { type: "keyword" }, space_id: { type: "keyword" }, page_id: { type: "keyword" }, parent_id: { type: "keyword" } },
} as const;

export async function ensureConfluenceIndices() {
  if (!(await es.indices.exists({ index: INDEX }))) await es.indices.create({ index: INDEX, mappings: docMappings });
  if (!(await es.indices.exists({ index: STATE }))) await es.indices.create({ index: STATE, mappings: stateMappings });
}

export async function resetConfluenceIndices() {
  await es.indices.delete({ index: [INDEX, STATE], ignore_unavailable: true });
  await ensureConfluenceIndices();
}

// ---- chunk docs ----

// Upsert first, then remove leftover chunks of the previous version, so a page is never missing mid-update.
export async function writePageDocs(pageId: string, docs: ConfluenceDoc[]): Promise<boolean> {
  const withVec = await withVectors(docs);
  const r = await es.bulk({ operations: withVec.flatMap((d) => [{ index: { _index: INDEX, _id: d.doc_id } }, d]), refresh: true });
  if (r.errors) throw new Error("Bulk index had errors: " + JSON.stringify(r.items.find((i) => i.index?.error)));
  await es.deleteByQuery({
    index: INDEX,
    refresh: true,
    conflicts: "proceed",
    query: {
      bool: {
        filter: [{ term: { page_id: pageId } }],
        should: [{ range: { chunk_index: { gte: docs.length } } }, { bool: { must_not: { term: { content_hash: docs[0].content_hash } } } }],
        minimum_should_match: 1,
      },
    },
  });
  return !embeddingConfigured() || withVec.every((d) => "text_vector" in d);
}

// Each page as indexed now (its first chunk), for the audit log.
export type PageSnapshot = Pick<ConfluenceDoc, "page_id" | "title" | "space_name" | "acl_container" | "restricted" | "acl_item" | "updated_at">;
export async function pageSnapshots(pageIds: string[]): Promise<Map<string, PageSnapshot>> {
  if (!pageIds.length) return new Map();
  const r = await es.search<PageSnapshot>({
    index: INDEX,
    size: pageIds.length,
    _source: ["page_id", "title", "space_name", "acl_container", "restricted", "acl_item", "updated_at"],
    query: { bool: { filter: [{ terms: { page_id: pageIds } }, { term: { chunk_index: 0 } }] } },
  });
  return new Map(r.hits.hits.map((h) => [h._source!.page_id, h._source!]));
}

export async function deletePageDocs(pageIds: string[]) {
  if (!pageIds.length) return;
  await es.deleteByQuery({ index: INDEX, refresh: true, conflicts: "proceed", query: { terms: { page_id: pageIds } } });
}

export async function deleteSpaceDocs(spaceId: string) {
  await es.deleteByQuery({ index: INDEX, refresh: true, conflicts: "proceed", query: { term: { space_id: spaceId } } });
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

export type SpaceState = SpaceAcl & { kind: "space"; synced_at: string };
export const getSpaceState = (id: string) => getState<SpaceState>(`space:${id}`);
export const putSpaceState = (s: SpaceAcl) =>
  es.index({ index: STATE, id: `space:${s.space_id}`, document: { kind: "space", ...s, synced_at: new Date().toISOString() }, refresh: true });
export async function allSpaceStates(): Promise<SpaceState[]> {
  const r = await es.search<SpaceState>({ index: STATE, size: 1000, query: { term: { kind: "space" } } });
  return r.hits.hits.map((h) => h._source!);
}
export async function deleteSpaceState(id: string) {
  await es.delete({ index: STATE, id: `space:${id}`, refresh: true }, { ignore: [404] });
}

// One per indexed page: its place in the tree and its restrictions, so a parent's change can fan out
// to descendants without re-reading them from Confluence.
export type PageState = {
  kind: "page";
  page_id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  own: string[] | null; // the page's own view restriction labels
  effective: string[] | null; // own, else the nearest restricted ancestor's
  content_hash: string;
  synced_at: string;
};
export const putPageState = (p: Omit<PageState, "kind" | "synced_at">) =>
  es.index({ index: STATE, id: `page:${p.page_id}`, document: { kind: "page", ...p, synced_at: new Date().toISOString() }, refresh: true });
export async function pageStates(spaceId: string): Promise<Map<string, PageState>> {
  const out = new Map<string, PageState>();
  const r = await es.search<PageState>({ index: STATE, size: 10000, query: { bool: { filter: [{ term: { kind: "page" } }, { term: { space_id: spaceId } }] } } });
  for (const h of r.hits.hits) out.set(h._source!.page_id, h._source!);
  return out;
}
export async function deletePageStates(pageIds: string[]) {
  if (!pageIds.length) return;
  await es.deleteByQuery({ index: STATE, refresh: true, conflicts: "proceed", query: { terms: { page_id: pageIds } } });
}

export type ConnectorState = { kind: "connector"; account_id: string | null; last_backfill_at: string | null; last_poll_at: string | null; cursor: string | null };
export const getConnector = () => getState<ConnectorState>("connector");
export async function putConnector(patch: Partial<ConnectorState>) {
  await es.update({ index: STATE, id: "connector", doc: { kind: "connector", ...patch }, doc_as_upsert: true, refresh: true });
}
