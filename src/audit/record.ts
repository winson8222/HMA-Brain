// Recording system and account events from sync code and routes.
// A failed audit write is logged loudly but doesn't stop a sync or a sign-in: the sync is what keeps
// permissions correct, so it must keep running. Searches and answers are different: they still refuse to
// return anything without their record (federated.ts calls appendAudit directly).
import type { AuditEvent, AuditItem, SyncVia } from "./chain.js";
import { changeEvents, deletedEvent, type Snapshot } from "./events.js";
import { appendAudit } from "./store.js";

export async function recordAudit(e: AuditEvent): Promise<void> {
  try {
    await appendAudit(e);
  } catch (err: any) {
    console.error(`AUDIT WRITE FAILED (${e.kind}): ${String(err?.message ?? err)}`);
  }
}

export async function recordItemChange(
  source: string,
  via: SyncVia,
  id: string,
  prev: Snapshot | null,
  next: Snapshot,
  opts: { quietAdd?: boolean; contentChanged?: boolean } = {},
): Promise<void> {
  for (const e of changeEvents(source, via, id, prev, next, opts)) await recordAudit(e);
}

export const recordItemDeleted = (source: string, via: SyncVia, item: AuditItem, modifiedAt?: string | null) =>
  recordAudit(deletedEvent(source, via, item, modifiedAt));

// A first (or reset) backfill: one record instead of one per item.
export const recordBackfill = (source: string, via: SyncVia, items: number, summary: string) =>
  recordAudit({ kind: "content_change", actor: "system", via, source, change: "backfill", items, summary, indexed_at: new Date().toISOString() });
