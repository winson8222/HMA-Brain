// Elasticsearch storage for Drive: chunk docs (`brain-drive`) and sync state (`brain-drive-state`).
// Separate from Slack's `brain` index, so a Slack backfill never touches Drive data.
import { es } from "../../es.js";
import { aclHash } from "./acl.js";
import { driveConfig } from "./config.js";
import type { DriveDoc, FileState } from "./docs.js";

const INDEX = driveConfig.index;
const STATE = driveConfig.stateIndex;

const docMappings = {
  properties: {
    doc_id: { type: "keyword" },
    source: { type: "keyword" },
    file_id: { type: "keyword" },
    chunk_index: { type: "integer" },
    title: { type: "text", fields: { keyword: { type: "keyword" } } },
    path: { type: "keyword" },
    ancestor_ids: { type: "keyword" },
    mime_type: { type: "keyword" },
    heading: { type: "keyword" },
    text: { type: "text" },
    owner_email: { type: "keyword" },
    modified_at: { type: "date" },
    ts: { type: "date" },
    permalink: { type: "keyword", index: false },
    acl_container: { type: "keyword" },
    content_hash: { type: "keyword" },
    title_only: { type: "boolean" },
  },
} as const;

const stateMappings = {
  dynamic: false as const,
  properties: {
    kind: { type: "keyword" }, // file | folder | connector
    file_id: { type: "keyword" },
    folder_id: { type: "keyword" },
    ancestor_ids: { type: "keyword" },
    status: { type: "keyword" },
    indexed_at: { type: "date" },
  },
} as const;

export async function ensureDriveIndices() {
  if (!(await es.indices.exists({ index: INDEX }))) await es.indices.create({ index: INDEX, mappings: docMappings });
  if (!(await es.indices.exists({ index: STATE }))) await es.indices.create({ index: STATE, mappings: stateMappings });
}

export async function resetDriveIndices() {
  await es.indices.delete({ index: [INDEX, STATE], ignore_unavailable: true });
  await ensureDriveIndices();
}

// ---- chunk docs ----

// Upsert the new chunks first, then remove leftovers from the previous version,
// so a file never has zero chunks while it is being updated.
export async function writeFileDocs(fileId: string, docs: DriveDoc[]) {
  const operations = docs.flatMap((d) => [{ index: { _index: INDEX, _id: d.doc_id } }, d]);
  const r = await es.bulk({ operations, refresh: true });
  if (r.errors) throw new Error("Bulk index had errors: " + JSON.stringify(r.items.find((i) => i.index?.error)));
  await es.deleteByQuery({
    index: INDEX,
    refresh: true,
    conflicts: "proceed",
    query: {
      bool: {
        filter: [{ term: { file_id: fileId } }],
        should: [{ range: { chunk_index: { gte: docs.length } } }, { bool: { must_not: { term: { content_hash: docs[0].content_hash } } } }],
        minimum_should_match: 1,
      },
    },
  });
}

// Sharing changed but content didn't: rewrite only the labels.
// Also records the new sharing in the file's state. Otherwise, after the live re-check relabels a file,
// sharing it back exactly as before would look "unchanged" to the poller and the labels would stay stale.
export async function relabelFile(fileId: string, acl: string[]) {
  await es.updateByQuery({
    index: INDEX,
    refresh: true,
    conflicts: "proceed",
    query: { term: { file_id: fileId } },
    script: { source: "ctx._source.acl_container = params.acl", params: { acl } },
  });
  await es
    .update({ index: STATE, id: fileKey(fileId), doc: { acl_hash: aclHash(acl) }, refresh: true })
    .catch((e) => {
      if (e?.meta?.statusCode !== 404) throw e; // no state yet: the next poll writes it
    });
}

export async function deleteFileDocs(fileId: string) {
  await es.deleteByQuery({ index: INDEX, refresh: true, conflicts: "proceed", query: { term: { file_id: fileId } } });
}

export async function docsForFile(fileId: string): Promise<DriveDoc[]> {
  const r = await es.search<DriveDoc>({ index: INDEX, size: 1000, query: { term: { file_id: fileId } } });
  return r.hits.hits.map((h) => h._source!);
}

export async function indexedFileIds(): Promise<string[]> {
  const r = await es.search({
    index: INDEX,
    size: 0,
    aggs: { files: { terms: { field: "file_id", size: 10000 } } },
  });
  return ((r.aggregations?.files as any)?.buckets ?? []).map((b: any) => String(b.key));
}

export async function countDocs(): Promise<number> {
  return (await es.count({ index: INDEX })).count;
}

// ---- sync state ----

const fileKey = (id: string) => `file:${id}`;
const folderKey = (id: string) => `folder:${id}`;

async function getState<T>(id: string): Promise<T | undefined> {
  try {
    return (await es.get<T>({ index: STATE, id }))._source;
  } catch (e: any) {
    if (e?.meta?.statusCode === 404) return undefined;
    throw e;
  }
}

async function allOfKind<T>(kind: string, extra: object[] = []): Promise<T[]> {
  const r = await es.search<T>({ index: STATE, size: 10000, query: { bool: { filter: [{ term: { kind } }, ...extra] } } });
  return r.hits.hits.map((h) => h._source!);
}

export const getFileState = (id: string) => getState<FileState>(fileKey(id));
export const putFileState = (s: FileState) => es.index({ index: STATE, id: fileKey(s.file_id), document: s, refresh: true });
export const allFileStates = () => allOfKind<FileState>("file");
export const countFileStates = async () => (await es.count({ index: STATE, query: { term: { kind: "file" } } })).count;
export const descendantStates = (folderId: string) => allOfKind<FileState>("file", [{ term: { ancestor_ids: folderId } }]);

export async function deleteFileState(id: string) {
  await es.delete({ index: STATE, id: fileKey(id), refresh: true }, { ignore: [404] });
}

export type FolderState = { kind: "folder"; folder_id: string; name: string; parent_id: string | null };
export const putFolderState = (f: FolderState) => es.index({ index: STATE, id: folderKey(f.folder_id), document: f, refresh: true });
export const allFolderStates = () => allOfKind<FolderState>("folder");
export async function deleteFolderState(id: string) {
  await es.delete({ index: STATE, id: folderKey(id), refresh: true }, { ignore: [404] });
}

export type ConnectorState = {
  kind: "connector";
  page_token: string | null;
  root_folder_id: string | null;
  root_name: string | null;
  account_email: string | null;
  last_backfill_at: string | null;
  last_poll_at: string | null;
};

export const getConnector = () => getState<ConnectorState>("connector");
export async function putConnector(patch: Partial<ConnectorState>) {
  await es.update({ index: STATE, id: "connector", doc: { kind: "connector", ...patch }, doc_as_upsert: true, refresh: true });
}
