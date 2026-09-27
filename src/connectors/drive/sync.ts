// Drive ingestion: backfill everything under the Company A root, then keep it current from
// Drive's changes feed. Every kind of change (content, sharing, folder sharing, move, trash)
// produces an entry per affected file, so each file is handled the same way: re-read it and
// update whatever changed. See docs in the team workspace: drive-spike-findings.md.
import type { drive_v3 } from "googleapis";
import { aclHash, permsToAcl } from "./acl.js";
import {
  accountEmail,
  downloadText,
  explain,
  exportText,
  findFolder,
  getMeta,
  httpStatus,
  isAuthError,
  listChanges,
  listChildren,
  startPageToken,
} from "./client.js";
import { driveConfig } from "./config.js";
import { contentHash, contentSignal, fileToDocs, mustFetchContent, planUpdate } from "./docs.js";
import { extractionFor, FOLDER, normalise, TITLE_ONLY, type Extracted, type Extraction } from "./extract.js";
import {
  allFileStates,
  allFolderStates,
  countDocs,
  countFileStates,
  deleteFileDocs,
  deleteFileState,
  descendantStates,
  ensureDriveIndices,
  getConnector,
  getFileState,
  indexedFileIds,
  putConnector,
  putFileState,
  relabelFile,
  resetDriveIndices,
  writeFileDocs,
} from "./store.js";
import { cachedFolder, forgetFolder, loadFolders, locate, rememberFolder } from "./tree.js";

type Root = { id: string; name: string };
export type Outcome = "indexed" | "relabelled" | "unchanged" | "deleted" | "skipped" | "error";
export type Counts = Record<Outcome, number>;
type Run = { root: Root; counts: Counts; maxLagMs: number; measureLag: boolean };

const newCounts = (): Counts => ({ indexed: 0, relabelled: 0, unchanged: 0, deleted: 0, skipped: 0, error: 0 });

export const summary = (c: Counts) =>
  (Object.entries(c) as [Outcome, number][])
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ") || "nothing to do";

// Shown in /api/status.
export const driveStatus = {
  account: null as string | null,
  rootFolder: null as string | null,
  files: 0,
  chunks: 0,
  lastBackfillAt: null as string | null,
  lastPollAt: null as string | null,
  lastRun: null as null | { kind: "backfill" | "poll"; at: string; counts: Counts; maxLagSeconds: number | null },
  lastError: null as string | null,
};

const MAX_TEXT_CHARS = 2_000_000;

async function extract(meta: drive_v3.Schema$File, how: Extraction): Promise<Extracted> {
  if (how.kind === "title" || how.kind === "skip") return TITLE_ONLY;
  const raw = how.kind === "export" ? await exportText(meta.id!, how.exportMime) : await downloadText(meta.id!);
  const text = normalise(raw, how.format);
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), format: how.format, titleOnly: false, note: "truncated" }
    : { text, format: how.format, titleOnly: false };
}

export async function resolveRoot(): Promise<Root> {
  if (driveConfig.rootFolderId) {
    const m = await getMeta(driveConfig.rootFolderId);
    if (!m || m.mimeType !== FOLDER || m.trashed) {
      throw new Error(`DRIVE_ROOT_FOLDER_ID=${driveConfig.rootFolderId} is not a folder the admin account can see.`);
    }
    return { id: m.id!, name: m.name! };
  }
  const f = await findFolder(driveConfig.rootFolderName);
  if (!f) {
    throw new Error(
      `No folder named "${driveConfig.rootFolderName}" in the admin's My Drive. Run \`npm run seed:drive\`, or set DRIVE_ROOT_FOLDER_ID.`,
    );
  }
  return { id: f.id!, name: f.name! };
}

// Files outside Company A also show up in the changes feed; they were never indexed, so there's nothing to do.
// (Chunks without state, e.g. after a crash mid-write, are cleaned up by backfill.)
async function deleteFile(fileId: string): Promise<Outcome> {
  if (!(await getFileState(fileId))) return "skipped";
  await deleteFileDocs(fileId);
  await deleteFileState(fileId);
  return "deleted";
}

async function processItem(fileId: string, run: Run) {
  let outcome: Outcome;
  try {
    outcome = await processFile(fileId, run);
  } catch (e) {
    if (isAuthError(e)) throw e; // stop the whole run: nothing else will work either
    console.error(`  drive ${fileId}: ${explain(e)}`);
    outcome = "error";
  }
  run.counts[outcome]++;
}

async function processFile(fileId: string, run: Run): Promise<Outcome> {
  const meta = await getMeta(fileId);
  if (!meta) {
    if (cachedFolder(fileId)) await dropFolder(fileId, run);
    return deleteFile(fileId);
  }
  if (meta.mimeType === FOLDER) {
    await processFolder(meta, run);
    return "skipped";
  }
  if (meta.trashed) return deleteFile(fileId);
  const how = extractionFor(meta.mimeType!);
  if (how.kind === "skip") return deleteFile(fileId);
  const loc = await locate(meta.parents?.[0], run.root);
  if (!loc) return deleteFile(fileId); // not (or no longer) under Company A

  const name = meta.name ?? fileId;
  const acl = permsToAcl(meta.permissions);
  const aHash = aclHash(acl);
  const prev = await getFileState(fileId);
  const signal = contentSignal({ mimeType: meta.mimeType!, md5Checksum: meta.md5Checksum, size: meta.size, modifiedTime: meta.modifiedTime });

  let extracted: Extracted | null = null;
  let error: string | null = null;
  if (mustFetchContent(prev, how.kind, signal, name, loc.path)) {
    try {
      extracted = await extract(meta, how);
    } catch (e) {
      if (isAuthError(e) || (prev && prev.status !== "error")) throw e; // keep the good copy; retried next time
      error = explain(e);
      extracted = TITLE_ONLY; // first sight and unreadable: index the title so it can still be found
    }
  }
  const cHash = extracted ? contentHash(extracted) : (prev?.content_hash ?? null);
  const decision = planUpdate(prev, { name, path: loc.path, aclHash: aHash, contentHash: cHash });
  if (decision === "none") return "unchanged";

  let chunkCount = prev?.chunk_count ?? 0;
  let finalHash = cHash;
  if (decision === "reindex") {
    const e = extracted ?? TITLE_ONLY; // title-only files are never fetched
    const file = { id: fileId, name, mimeType: meta.mimeType!, modifiedTime: meta.modifiedTime, webViewLink: meta.webViewLink, owners: meta.owners };
    const docs = fileToDocs(file, e, acl, loc);
    await writeFileDocs(fileId, docs);
    chunkCount = docs.length;
    finalHash = contentHash(e);
    if (run.measureLag && meta.modifiedTime) run.maxLagMs = Math.max(run.maxLagMs, Date.now() - Date.parse(meta.modifiedTime));
  } else {
    await relabelFile(fileId, acl);
  }

  await putFileState({
    kind: "file",
    file_id: fileId,
    name,
    mime_type: meta.mimeType!,
    path: loc.path,
    ancestor_ids: loc.ancestorIds,
    content_signal: signal,
    content_hash: finalHash,
    acl_hash: aHash,
    chunk_count: chunkCount,
    status: error ? "error" : how.kind === "title" ? "title_only" : "indexed",
    error,
    modified_at: meta.modifiedTime ?? null,
    indexed_at: new Date().toISOString(),
  });
  return decision === "reindex" ? "indexed" : "relabelled";
}

async function processFolder(meta: drive_v3.Schema$File, run: Run) {
  const id = meta.id!;
  const name = meta.name ?? id;
  const old = cachedFolder(id);
  if (meta.trashed) return dropFolder(id, run);

  if (id === run.root.id) {
    await rememberFolder({ id, name, parentId: null });
    run.root.name = name;
    if (old && old.name !== name) await refreshDescendants(id, run);
    return;
  }

  const parentId = meta.parents?.[0] ?? null;
  if (!(await locate(parentId, run.root))) return dropFolder(id, run); // moved out of Company A
  await rememberFolder({ id, name, parentId });
  if (!old) {
    // New to us: created here, or moved in from outside. Index whatever it already contains.
    const fileIds: string[] = [];
    await walk(id, fileIds, new Set());
    for (const f of fileIds) await processItem(f, run);
  } else if (old.name !== name || old.parentId !== parentId) {
    await refreshDescendants(id, run); // their paths changed
  }
}

async function dropFolder(id: string, run: Run) {
  await forgetFolder(id);
  await refreshDescendants(id, run); // each will be found outside Company A (or trashed) and removed
}

async function refreshDescendants(folderId: string, run: Run) {
  for (const s of await descendantStates(folderId)) await processItem(s.file_id, run);
}

// Collect every file under a folder and remember the folders on the way.
async function walk(folderId: string, fileIds: string[], folderIds: Set<string>) {
  const queue = [folderId];
  while (queue.length) {
    const id = queue.shift()!;
    folderIds.add(id);
    for (const c of await listChildren(id)) {
      if (c.mimeType === FOLDER) {
        await rememberFolder({ id: c.id!, name: c.name ?? c.id!, parentId: id });
        queue.push(c.id!);
      } else fileIds.push(c.id!);
    }
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function refreshStatus(kind: "backfill" | "poll", run: Run) {
  const conn = await getConnector();
  Object.assign(driveStatus, {
    account: conn?.account_email ?? null,
    rootFolder: conn?.root_name ?? null,
    lastBackfillAt: conn?.last_backfill_at ?? null,
    lastPollAt: conn?.last_poll_at ?? null,
    files: await countFileStates(),
    chunks: await countDocs(),
    lastRun: { kind, at: new Date().toISOString(), counts: run.counts, maxLagSeconds: run.maxLagMs ? Math.round(run.maxLagMs / 1000) : null },
    lastError: null,
  });
}

// ---- backfill ----

let busy = false; // one backfill or poll at a time in this process

export async function backfill(opts: { reset?: boolean } = {}): Promise<Counts> {
  if (busy) throw new Error("A Drive sync is already running.");
  busy = true;
  try {
    return await backfillInner(opts);
  } catch (e) {
    driveStatus.lastError = explain(e);
    throw e;
  } finally {
    busy = false;
  }
}

async function backfillInner(opts: { reset?: boolean }): Promise<Counts> {
  if (opts.reset) await resetDriveIndices();
  else await ensureDriveIndices();
  await loadFolders();

  // Take the sync position BEFORE listing, so anything edited during the backfill is picked up by the next poll.
  const token = await startPageToken();
  const root = await resolveRoot();
  await rememberFolder({ id: root.id, name: root.name, parentId: null });
  const run: Run = { root, counts: newCounts(), maxLagMs: 0, measureLag: false };

  const fileIds: string[] = [];
  const folderIds = new Set<string>();
  await walk(root.id, fileIds, folderIds);
  await pool(fileIds, 4, (id) => processItem(id, run));

  // Remove anything indexed earlier that is no longer under the root.
  const seen = new Set(fileIds);
  for (const s of await allFileStates()) if (!seen.has(s.file_id)) run.counts[await deleteFile(s.file_id)]++;
  for (const id of await indexedFileIds()) if (!seen.has(id)) await deleteFileDocs(id); // chunks without state
  for (const f of await allFolderStates()) if (!folderIds.has(f.folder_id)) await forgetFolder(f.folder_id);

  await putConnector({
    page_token: token,
    root_folder_id: root.id,
    root_name: root.name,
    account_email: await accountEmail(),
    last_backfill_at: new Date().toISOString(),
  });
  await refreshStatus("backfill", run);
  return run.counts;
}

// ---- poll ----

// Returns null if another sync is still running.
export async function pollOnce(): Promise<Counts | null> {
  if (busy) return null;
  busy = true;
  try {
    await ensureDriveIndices();
    const conn = await getConnector();
    if (!conn?.page_token || !conn.root_folder_id) {
      console.log("Drive: no sync position yet, running a backfill first");
      return await backfillInner({});
    }
    await loadFolders();
    const root = { id: conn.root_folder_id, name: conn.root_name ?? driveConfig.rootFolderName };
    if (!cachedFolder(root.id)) await rememberFolder({ ...root, parentId: null });

    // 1. Everything that changed since the saved position. A file can appear several times; keep the last entry.
    const latest = new Map<string, { removed: boolean; folder: boolean }>();
    let token = conn.page_token;
    let newStart: string | undefined;
    try {
      while (!newStart) {
        const page = await listChanges(token);
        for (const c of page.changes) {
          if (c.changeType === "drive" || !c.fileId) continue;
          latest.set(c.fileId, { removed: !!c.removed, folder: c.file?.mimeType === FOLDER || !!cachedFolder(c.fileId) });
        }
        if (page.nextPageToken) token = page.nextPageToken;
        else newStart = page.newStartPageToken;
      }
    } catch (e) {
      if (!isAuthError(e) && [400, 404, 410].includes(httpStatus(e))) {
        console.warn(`Drive: saved sync position rejected (${explain(e)}); running a full backfill`);
        return await backfillInner({});
      }
      throw e;
    }

    // 2. Apply. Folders first, so files get the right paths.
    const run: Run = { root, counts: newCounts(), maxLagMs: 0, measureLag: true };
    const entries = [...latest].sort((a, b) => Number(b[1].folder) - Number(a[1].folder));
    for (const [id, c] of entries) {
      if (c.removed) {
        if (cachedFolder(id)) await dropFolder(id, run);
        run.counts[await deleteFile(id)]++;
      } else await processItem(id, run);
    }

    // 3. Save the new position only after everything is applied. A crash before this just redoes the batch.
    await putConnector({ page_token: newStart!, root_name: run.root.name, last_poll_at: new Date().toISOString() });
    await refreshStatus("poll", run);
    return run.counts;
  } catch (e) {
    driveStatus.lastError = explain(e);
    throw e;
  } finally {
    busy = false;
  }
}

export function startPolling(): NodeJS.Timeout {
  const tick = () =>
    pollOnce()
      .then((c) => {
        if (c && (c.indexed || c.relabelled || c.deleted || c.error)) console.log(`Drive: ${summary(c)}`);
      })
      .catch((e) => console.error(`Drive poll failed: ${explain(e)}`));
  void tick();
  return setInterval(tick, driveConfig.pollSeconds * 1000);
}

export async function loadStatus() {
  const conn = await getConnector();
  if (!conn) return driveStatus;
  Object.assign(driveStatus, {
    account: conn.account_email,
    rootFolder: conn.root_name,
    lastBackfillAt: conn.last_backfill_at,
    lastPollAt: conn.last_poll_at,
    files: await countFileStates(),
    chunks: await countDocs(),
  });
  return driveStatus;
}
