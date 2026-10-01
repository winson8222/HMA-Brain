// Drive file → Elasticsearch chunk docs, and the "what needs doing" decision. Pure functions, unit-tested.
import { sha256 } from "./acl.js";
import { chunkText } from "./chunk.js";
import type { Extracted } from "./extract.js";

export type DriveDoc = {
  doc_id: string; // drive:<fileId>:<chunk>
  source: "drive";
  file_id: string;
  chunk_index: number;
  title: string;
  path: string; // containing folders, e.g. "Company A / Engineering / Runbooks"
  ancestor_ids: string[]; // root → parent folder IDs
  mime_type: string;
  heading: string | null;
  text: string;
  owner_email: string | null;
  modified_at: string | null;
  ts: string;
  permalink: string;
  acl_container: string[]; // permission label, see acl.ts
  content_hash: string;
  title_only: boolean;
};

export type FileInfo = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string | null;
  webViewLink?: string | null;
  owners?: { emailAddress?: string | null }[] | null;
};

export type Location = { path: string; ancestorIds: string[] };

export const driveDocId = (fileId: string, n: number) => `drive:${fileId}:${n}`;

export const contentHash = (e: Extracted) => sha256(`${e.titleOnly ? "title-only" : e.format}\n${e.text}`);

export function fileToDocs(file: FileInfo, e: Extracted, acl: string[], loc: Location): DriveDoc[] {
  const header = `${file.name} (${loc.path})`;
  const chunks = e.titleOnly ? [] : chunkText(e.text, e.format);
  const base = {
    source: "drive" as const,
    file_id: file.id,
    title: file.name,
    path: loc.path,
    ancestor_ids: loc.ancestorIds,
    mime_type: file.mimeType,
    owner_email: file.owners?.[0]?.emailAddress?.toLowerCase() ?? null,
    modified_at: file.modifiedTime ?? null,
    ts: file.modifiedTime ?? new Date().toISOString(),
    permalink: file.webViewLink ?? `https://drive.google.com/open?id=${file.id}`,
    acl_container: acl,
    content_hash: contentHash(e),
  };
  // Title-only and empty files still get one doc, so they can be found by name.
  if (!chunks.length) return [{ ...base, doc_id: driveDocId(file.id, 0), chunk_index: 0, heading: null, text: header, title_only: true }];
  return chunks.map((c, i) => ({
    ...base,
    doc_id: driveDocId(file.id, i),
    chunk_index: i,
    heading: c.heading,
    text: `${header}\n\n${c.text}`,
    title_only: false,
  }));
}

// ---- sync state ----

export type FileState = {
  kind: "file";
  file_id: string;
  name: string;
  mime_type: string;
  path: string;
  ancestor_ids: string[];
  content_signal: string | null; // md5 (or size+modifiedTime) for stored files; null for Google-native files
  content_hash: string | null;
  acl_hash: string;
  chunk_count: number;
  status: "indexed" | "title_only" | "error";
  error: string | null;
  modified_at: string | null;
  indexed_at: string;
  vectors?: boolean; // false: written without embeddings (the embed call failed), so retried on the next pass
};

// Stored files can be compared without downloading. Google-native files can't (their modifiedTime
// also changes on sharing changes), so they are exported and compared by text hash instead.
export function contentSignal(f: { mimeType: string; md5Checksum?: string | null; size?: string | null; modifiedTime?: string | null }): string | null {
  if (f.mimeType.startsWith("application/vnd.google-apps.")) return null;
  return f.md5Checksum ?? `${f.size ?? "?"}:${f.modifiedTime ?? "?"}`;
}

type Kind = "export" | "download" | "title";

export function mustFetchContent(prev: FileState | undefined, kind: Kind, signal: string | null, name: string, path: string, wantVectors = false): boolean {
  if (kind === "title") return false;
  if (kind === "export") return true;
  if (wantVectors && prev?.vectors === false) return true;
  return !prev || prev.status === "error" || prev.content_signal !== signal || prev.name !== name || prev.path !== path;
}

// Debounce: was the file edited so recently that someone is probably still typing?
export function stillEditing(modifiedTime: string | null | undefined, now: number, quietMs: number): boolean {
  if (!quietMs || !modifiedTime) return false;
  const t = Date.parse(modifiedTime);
  return Number.isFinite(t) && now - t < quietMs;
}

export type Decision = "reindex" | "relabel" | "none";

// Content, title or folder changed → rewrite the chunks (they carry title and path).
// Only sharing changed → relabel the existing chunks, no re-download.
export function planUpdate(
  prev: FileState | undefined,
  next: { name: string; path: string; aclHash: string; contentHash: string | null; wantVectors?: boolean },
): Decision {
  if (!prev || prev.status === "error") return "reindex";
  if (next.wantVectors && prev.vectors === false) return "reindex"; // embeddings failed last time
  if (next.contentHash !== null && next.contentHash !== prev.content_hash) return "reindex";
  if (prev.name !== next.name || prev.path !== next.path) return "reindex";
  if (prev.acl_hash !== next.aclHash) return "relabel";
  return "none";
}
