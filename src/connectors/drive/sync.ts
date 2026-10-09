// Drive ingestion: backfill everything under the Company A root, then keep it current from
// Drive's changes feed. Every kind of change (content, sharing, folder sharing, move, trash)
// produces an entry per affected file, so each file is handled the same way: re-read it and
// update whatever changed. See docs in the team workspace: drive-spike-findings.md.
import type { drive_v3 } from "googleapis";
import type { SyncVia } from "../../audit/chain.js";
import { access, type Snapshot } from "../../audit/events.js";
import { recordBackfill, recordItemChange, recordItemDeleted } from "../../audit/record.js";
import { aclHash, permsToAcl } from "./acl.js";
import {
  accountEmail,
  downloadBytes,
  downloadText,
  explain,
  exportText,
  findFolder,
  getMeta,
  httpStatus,
  isAuthError,
  isConnected,
  listChanges,
  listChildren,
  startPageToken,
} from "./client.js";
import { driveConfig } from "./config.js";
import { embeddingConfigured } from "../../embeddings.js";
import { contentHash, contentSignal, fileToDocs, mustFetchContent, planUpdate, stillEditing } from "./docs.js";
import { extractionFor, FOLDER, normalise, TITLE_ONLY, type Extracted, type Extraction } from "./extract.js";
import {
  allFileStates,
  allFolderStates,
  allPending,
  countPending,
  countDocs,
  countFileStates,
  deleteFileDocs,
  deleteFileState,
  deletePending,
  descendantStates,
  ensureDriveIndices,
  getConnector,
  getFileState,
  indexedFileIds,
  putConnector,
  putFileState,
  putPending,
  relabelFile,
  resetDriveIndices,
  storedAcl,
  writeFileDocs,
} from "./store.js";
import { cachedFolder, forgetFolder, loadFolders, locate, rememberFolder } from "./tree.js";
import { MAX_PDF_BYTES, pdfText } from "./pdf.js";

type Root = { id: string; name: string };
export type Outcome = "indexed" | "relabelled" | "unchanged" | "deleted" | "skipped" | "deferred" | "error";
export type Counts = Record<Outcome, number>;
// quietMs: the debounce window for this run (0 = re-index edited files right away).
// via: what to call this run in the audit log. initial: a first backfill, audited as one summary record.
// changeTimes: for a poll, when Drive's change feed says each file changed (the audit's changed_at), and
// listedAt: when the poll read the feed (its detected_at). A backfill has neither: only detection is known.
type Run = {
  root: Root;
  counts: Counts;
  maxLagMs: number;
  measureLag: boolean;
  quietMs: number;
  via: SyncVia;
  initial: boolean;
  changeTimes?: Map<string, string>;
  listedAt?: string;
};

const changedAt = (run: Run, fileId: string) => run.changeTimes?.get(fileId) ?? null;
const detectedAt = (run: Run, fileId: string) => (run.changeTimes?.has(fileId) ? run.listedAt : undefined);

const newCounts = (): Counts => ({ indexed: 0, relabelled: 0, unchanged: 0, deleted: 0, skipped: 0, deferred: 0, error: 0 });

export const summary = (c: Counts) =>
  (Object.entries(c) as [Outcome, number][])
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ") || "nothing to do";

// Shown in /api/status and /api/drive/status.
export const driveStatus = {
  connected: false,
  authError: false, // token expired or revoked: an admin must reconnect
  polling: false,
  pollSeconds: driveConfig.pollSeconds,
  reconcileMinutes: driveConfig.reconcileMinutes,
  account: null as string | null,
  rootFolder: null as string | null,
  files: 0,
  chunks: 0,
  pending: 0, // edited files waiting to be quiet before re-indexing
  quietSeconds: driveConfig.quietSeconds,
  lastBackfillAt: null as string | null,
  lastPollAt: null as string | null,
  lastRun: null as null | { kind: "backfill" | "poll"; at: string; counts: Counts; maxLagSeconds: number | null },
  lastError: null as string | null,
};

const MAX_TEXT_CHARS = 2_000_000;

async function extract(meta: drive_v3.Schema$File, how: Extraction): Promise<Extracted> {
  if (how.kind === "title" || how.kind === "skip") return TITLE_ONLY;
  let raw: string;
  if (how.kind === "export") raw = await exportText(meta.id!, how.exportMime);
  else if (how.parser === "pdf") {
    if (Number(meta.size ?? 0) > MAX_PDF_BYTES) return { ...TITLE_ONLY, note: "PDF too large" };
    raw = await pdfText(await downloadBytes(meta.id!));
  } else raw = await downloadText(meta.id!);
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
async function deleteFile(fileId: string, run: Run): Promise<Outcome> {
  await deletePending(fileId);
  const prev = await getFileState(fileId);
  if (!prev) return "skipped";
  await deleteFileDocs(fileId);
  await deleteFileState(fileId);
  await recordItemDeleted("drive", run.via, { id: driveItemId(fileId), source: "drive", title: prev.name, path: prev.path }, changedAt(run, fileId), detectedAt(run, fileId));
  return "deleted";
}

export const driveItemId = (fileId: string) => `drive:${fileId}`;

// The file as the index had it before this change, for the audit record. The labels come from its chunks;
// if those are missing (a crash mid-write), the old access is recorded as unknown.
async function before(prev: NonNullable<Awaited<ReturnType<typeof getFileState>>>, newAclHash: string, newAcl: string[]): Promise<Snapshot> {
  const old = prev.acl_hash === newAclHash ? newAcl : await storedAcl(prev.file_id);
  return { title: prev.name, path: prev.path, access: access(old ?? ["(unknown)"]), modified_at: prev.modified_at };
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
  // Handled (or nothing to do): it's no longer waiting. Errors stay pending, so they're retried.
  if (outcome !== "deferred" && outcome !== "error") await deletePending(fileId);
}

async function processFile(fileId: string, run: Run): Promise<Outcome> {
  const meta = await getMeta(fileId);
  if (!meta) {
    if (cachedFolder(fileId)) await dropFolder(fileId, run);
    return deleteFile(fileId, run);
  }
  if (meta.mimeType === FOLDER) {
    await processFolder(meta, run);
    return "skipped";
  }
  if (meta.trashed) return deleteFile(fileId, run);
  const how = extractionFor(meta.mimeType!);
  if (how.kind === "skip") return deleteFile(fileId, run);
  const loc = await locate(meta.parents?.[0], run.root);
  if (!loc) return deleteFile(fileId, run); // not (or no longer) under Company A

  const name = meta.name ?? fileId;
  const acl = permsToAcl(meta.permissions);
  const aHash = aclHash(acl);
  const prev = await getFileState(fileId);
  const signal = contentSignal({ mimeType: meta.mimeType!, md5Checksum: meta.md5Checksum, size: meta.size, modifiedTime: meta.modifiedTime });
  const wantVectors = embeddingConfigured();

  // Debounce: someone is probably still editing. Wait until the file has been quiet before re-exporting
  // and re-embedding it. Sharing can't wait (it decides who may see the file), so it's applied now.
  if (how.kind !== "title" && stillEditing(meta.modifiedTime, Date.now(), run.quietMs)) {
    if (prev && prev.status !== "error" && prev.acl_hash !== aHash) {
      const old = await before(prev, aHash, acl); // labels as stored, before relabelling
      await relabelFile(fileId, acl);
      await putFileState({ ...prev, acl_hash: aHash });
      await recordItemChange("drive", run.via, driveItemId(fileId), old, { ...old, access: access(acl) }, {
        contentChanged: false,
        permissionChangedAt: changedAt(run, fileId),
        detectedAt: detectedAt(run, fileId),
      });
    }
    await putPending(fileId, new Date(Date.parse(meta.modifiedTime!) + run.quietMs).toISOString());
    return "deferred";
  }

  let extracted: Extracted | null = null;
  let error: string | null = null;
  if (mustFetchContent(prev, how.kind, signal, name, loc.path, wantVectors)) {
    try {
      extracted = await extract(meta, how);
    } catch (e) {
      if (isAuthError(e) || (prev && prev.status !== "error")) throw e; // keep the good copy; retried next time
      error = explain(e);
      extracted = TITLE_ONLY; // first sight and unreadable: index the title so it can still be found
    }
  }
  const cHash = extracted ? contentHash(extracted) : (prev?.content_hash ?? null);
  const decision = planUpdate(prev, { name, path: loc.path, aclHash: aHash, contentHash: cHash, wantVectors });
  if (decision === "none") return "unchanged";

  const old = prev && prev.status !== "error" ? await before(prev, aHash, acl) : null;
  let chunkCount = prev?.chunk_count ?? 0;
  let finalHash = cHash;
  let vectors = prev?.vectors;
  if (decision === "reindex") {
    const e = extracted ?? TITLE_ONLY; // title-only files are never fetched
    const file = { id: fileId, name, mimeType: meta.mimeType!, modifiedTime: meta.modifiedTime, webViewLink: meta.webViewLink, owners: meta.owners };
    const docs = fileToDocs(file, e, acl, loc);
    vectors = await writeFileDocs(fileId, docs);
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
    ...(vectors !== undefined ? { vectors } : {}),
  });
  await recordItemChange(
    "drive",
    run.via,
    driveItemId(fileId),
    old,
    { title: name, path: loc.path, access: access(acl), modified_at: meta.modifiedTime ?? null },
    {
      quietAdd: run.initial,
      contentChanged: prev?.content_hash !== finalHash,
      permissionChangedAt: changedAt(run, fileId),
      detectedAt: detectedAt(run, fileId),
    },
  );
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
    pending: await countPending(),
    lastRun: { kind, at: new Date().toISOString(), counts: run.counts, maxLagSeconds: run.maxLagMs ? Math.round(run.maxLagMs / 1000) : null },
    lastError: null,
    authError: false,
    connected: true,
  });
}

// ---- backfill ----

let busy = false; // one backfill or poll at a time in this process

// quietMs: debounce for files edited moments ago (the server's periodic reconcile); 0 for an explicit backfill.
export async function backfill(opts: { reset?: boolean; quietMs?: number; via?: SyncVia } = {}): Promise<Counts> {
  if (busy) throw new Error("A Drive sync is already running.");
  busy = true;
  try {
    return await backfillInner(opts);
  } catch (e) {
    noteError(e);
    throw e;
  } finally {
    busy = false;
  }
}

function noteError(e: unknown) {
  driveStatus.lastError = explain(e);
  driveStatus.authError = isAuthError(e);
}

async function backfillInner(opts: { reset?: boolean; quietMs?: number; via?: SyncVia }): Promise<Counts> {
  // The first backfill (or one after a reset) adds everything: one summary record, not one per file.
  const initial = !!opts.reset || !(await getConnector().catch(() => undefined))?.page_token;
  if (opts.reset) await resetDriveIndices();
  else await ensureDriveIndices();
  await loadFolders();

  // Take the sync position BEFORE listing, so anything edited during the backfill is picked up by the next poll.
  const token = await startPageToken();
  const root = await resolveRoot();
  await rememberFolder({ id: root.id, name: root.name, parentId: null });
  const run: Run = { root, counts: newCounts(), maxLagMs: 0, measureLag: false, quietMs: opts.quietMs ?? 0, via: initial ? "backfill" : (opts.via ?? "reconcile"), initial };

  const fileIds: string[] = [];
  const folderIds = new Set<string>();
  await walk(root.id, fileIds, folderIds);
  await pool(fileIds, 4, (id) => processItem(id, run));

  // Remove anything indexed earlier that is no longer under the root.
  const seen = new Set(fileIds);
  if (!run.quietMs) for (const p of await allPending()) if (!seen.has(p.file_id)) await deletePending(p.file_id); // left the folder
  for (const s of await allFileStates()) if (!seen.has(s.file_id)) run.counts[await deleteFile(s.file_id, run)]++;
  for (const id of await indexedFileIds()) if (!seen.has(id)) await deleteFileDocs(id); // chunks without state
  for (const f of await allFolderStates()) if (!folderIds.has(f.folder_id)) await forgetFolder(f.folder_id);

  await putConnector({
    page_token: token,
    root_folder_id: root.id,
    root_name: root.name,
    account_email: await accountEmail(),
    last_backfill_at: new Date().toISOString(),
  });
  if (initial) await recordBackfill("drive", "backfill", run.counts.indexed, `Drive "${root.name}": ${summary(run.counts)}`);
  await refreshStatus("backfill", run);
  return run.counts;
}

// ---- poll ----

// Returns null if another sync is still running. force: skip the debounce ("Sync now", `drive:poll`).
export async function pollOnce(opts: { force?: boolean } = {}): Promise<Counts | null> {
  const quietMs = opts.force ? 0 : driveConfig.quietSeconds * 1000;
  if (busy) return null;
  busy = true;
  try {
    await ensureDriveIndices();
    const conn = await getConnector();
    if (!conn?.page_token || !conn.root_folder_id) {
      console.log("Drive: no sync position yet, running a backfill first");
      return await backfillInner({});
    }
    // The feed position belongs to the account that took it. After connecting a different admin, start over.
    const account = await accountEmail();
    if (conn.account_email && account && conn.account_email.toLowerCase() !== account) {
      console.log(`Drive: connected account changed (${conn.account_email} → ${account}); running a full backfill`);
      return await backfillInner({});
    }
    await loadFolders();
    const root = { id: conn.root_folder_id, name: conn.root_name ?? driveConfig.rootFolderName };
    if (!cachedFolder(root.id)) await rememberFolder({ ...root, parentId: null });

    // 1. Everything that changed since the saved position. A file can appear several times; keep the last entry.
    const latest = new Map<string, { removed: boolean; folder: boolean; time?: string }>();
    let token = conn.page_token;
    let newStart: string | undefined;
    try {
      while (!newStart) {
        const page = await listChanges(token);
        for (const c of page.changes) {
          if (c.changeType === "drive" || !c.fileId) continue;
          latest.set(c.fileId, { removed: !!c.removed, folder: c.file?.mimeType === FOLDER || !!cachedFolder(c.fileId), time: c.time ?? undefined });
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
    const changeTimes = new Map([...latest].filter(([, c]) => c.time).map(([id, c]) => [id, c.time!]));
    const run: Run = { root, counts: newCounts(), maxLagMs: 0, measureLag: true, quietMs, via: "poll", initial: false, changeTimes, listedAt: new Date().toISOString() };
    const entries = [...latest].sort((a, b) => Number(b[1].folder) - Number(a[1].folder));
    for (const [id, c] of entries) {
      if (c.removed) {
        if (cachedFolder(id)) await dropFolder(id, run);
        run.counts[await deleteFile(id, run)]++;
      } else await processItem(id, run);
    }

    // 3. Files that were being edited earlier and have been quiet long enough (all of them when forced).
    //    Re-read now; one that is still being edited is pushed back again.
    const now = Date.now();
    for (const p of await allPending()) {
      if (latest.has(p.file_id)) continue; // just handled above
      if (opts.force || Date.parse(p.due_at) <= now) await processItem(p.file_id, run);
    }

    // 4. Save the new position only after everything is applied. A crash before this just redoes the batch.
    await putConnector({ page_token: newStart!, root_name: run.root.name, last_poll_at: new Date().toISOString() });
    await refreshStatus("poll", run);
    return run.counts;
  } catch (e) {
    noteError(e);
    throw e;
  } finally {
    busy = false;
  }
}

const changed = (c: Counts | null) => !!c && !!(c.indexed || c.relabelled || c.deleted || c.error);

// Poll every DRIVE_POLL_SECONDS, and reconcile every DRIVE_RECONCILE_MINUTES in case a poll missed something.
export function startPolling() {
  driveStatus.polling = true;
  const tick = () =>
    pollOnce()
      .then((c) => changed(c) && console.log(`Drive: ${summary(c!)}`))
      .catch((e) => console.error(`Drive poll failed: ${explain(e)}`));
  void tick();
  setInterval(tick, driveConfig.pollSeconds * 1000);

  if (driveConfig.reconcileMinutes > 0) {
    setInterval(() => {
      if (busy || !isConnected()) return;
      backfill({ quietMs: driveConfig.quietSeconds * 1000 })
        .then((c) => changed(c) && console.log(`Drive reconcile: ${summary(c)}`))
        .catch((e) => console.error(`Drive reconcile failed: ${explain(e)}`));
    }, driveConfig.reconcileMinutes * 60_000);
  }
}

export async function loadStatus() {
  driveStatus.connected = isConnected();
  const conn = await getConnector();
  if (!conn) return driveStatus;
  Object.assign(driveStatus, {
    account: conn.account_email,
    rootFolder: conn.root_name,
    lastBackfillAt: conn.last_backfill_at,
    lastPollAt: conn.last_poll_at,
    files: await countFileStates(),
    chunks: await countDocs(),
    pending: await countPending(),
  });
  return driveStatus;
}
