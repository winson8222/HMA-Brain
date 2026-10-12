// Trusted local storage, deliberately outside Elasticsearch. All writers must share this file.
// This protects against ES-only tampering, not compromise/rollback of the application filesystem.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AuditRecord } from "./chain.js";

export type AuditHead = { seq: number; hash: string };
export type Checkpoint = { v: 1; index: string; head: AuditHead | null; pending?: AuditRecord };
const file = () => resolve(process.env.AUDIT_CHECKPOINT_FILE || ".secrets/audit-checkpoint.json");

export async function readCheckpoint(index: string): Promise<Checkpoint | null> {
  let raw: string;
  try { raw = await readFile(file(), "utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  const value = JSON.parse(raw) as Checkpoint;
  const validHead = (h: AuditHead | null) => h === null || (Number.isSafeInteger(h?.seq) && h.seq > 0 && /^[a-f0-9]{64}$/.test(h.hash));
  if (!value || typeof value !== "object" || value.v !== 1 || value.index !== index || !validHead(value.head) ||
      (value.pending !== undefined && (!validHead(value.pending) || value.pending === null))) {
    throw new Error("Invalid audit checkpoint or AUDIT_INDEX mismatch; restore the matching trusted checkpoint");
  }
  return value;
}

export async function writeCheckpoint(value: Checkpoint): Promise<void> {
  const path = file();
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temp, { force: true }); }
}

// Directory creation is atomic across server + CLI. Never auto-steal stale locks: a slow or paused
// owner must not race another writer. After a crash, stop ALL writers before removing the lock.
export async function withCheckpointLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${file()}.lock`;
  await mkdir(dirname(file()), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw new Error(`Audit checkpoint is locked: ${lock}. If a writer crashed, stop all audit writers before removing this lock directory.`);
      await delay(25);
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true }); }
}
