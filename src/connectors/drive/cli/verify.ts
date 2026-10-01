// npm run drive:verify [-- --deep] — checks the Drive index matches Drive: same files, right labels, current content.
// --deep also re-exports Google Docs/Sheets/Slides to compare their text. Exits 1 on any mismatch.
import { aclHash, permsToAcl } from "../acl.js";
import { exportText, getMeta, listChildren } from "../client.js";
import { contentHash, contentSignal } from "../docs.js";
import { extractionFor, FOLDER, normalise } from "../extract.js";
import { docsForFile, ensureDriveIndices, getFileState, indexedFileIds } from "../store.js";
import { locate, rememberFolder } from "../tree.js";
import { resolveRoot } from "../sync.js";

const deep = process.argv.includes("--deep");
await ensureDriveIndices();
const root = await resolveRoot();
await rememberFolder({ id: root.id, name: root.name, parentId: null }, false);

// Everything under the root, straight from Drive.
const fileIds: string[] = [];
const queue = [root.id];
while (queue.length) {
  const id = queue.shift()!;
  for (const c of await listChildren(id)) {
    if (c.mimeType === FOLDER) {
      await rememberFolder({ id: c.id!, name: c.name!, parentId: id }, false);
      queue.push(c.id!);
    } else fileIds.push(c.id!);
  }
}

const rows: Record<string, string | number>[] = [];
let ok = true;
for (const id of fileIds) {
  const meta = await getMeta(id);
  if (!meta || meta.trashed) continue;
  const how = extractionFor(meta.mimeType!);
  if (how.kind === "skip") continue;
  const loc = await locate(meta.parents?.[0], root);
  const state = await getFileState(id);
  const docs = await docsForFile(id);
  const wantAcl = permsToAcl(meta.permissions);
  const problems: string[] = [];

  if (!state || !docs.length) problems.push("missing");
  else {
    if (docs.some((d) => aclHash(d.acl_container) !== aclHash(wantAcl))) problems.push("wrong label");
    if (state.name !== meta.name || state.path !== loc?.path) problems.push("stale name/path");
    const signal = contentSignal({ mimeType: meta.mimeType!, md5Checksum: meta.md5Checksum, size: meta.size, modifiedTime: meta.modifiedTime });
    if (signal && signal !== state.content_signal) problems.push("stale content");
    if (deep && how.kind === "export") {
      const text = normalise(await exportText(id, how.exportMime), how.format);
      if (contentHash({ text, format: how.format, titleOnly: false }) !== state.content_hash) problems.push("stale content");
    }
    if (docs.length !== state.chunk_count) problems.push("chunk count");
  }
  ok &&= problems.length === 0;
  rows.push({
    file: meta.name!,
    folder: loc?.path ?? "?",
    chunks: docs.length,
    status: state?.status ?? "-",
    labels: wantAcl.length,
    result: problems.length ? `FAIL: ${problems.join(", ")}` : "PASS",
  });
}

// Indexed but no longer in Drive (or no longer under the root).
const live = new Set(fileIds);
const extra = (await indexedFileIds()).filter((id) => !live.has(id));
for (const id of extra) rows.push({ file: id, folder: "-", chunks: "?", status: "-", labels: "-", result: "FAIL: extra (not in Drive)" });
ok &&= extra.length === 0;

console.table(rows);
console.log(ok ? `All ${rows.length} files match.` : "Mismatch found. Run `npm run drive:poll`, or `npm run drive:backfill` to repair.");
process.exit(ok ? 0 : 1);
