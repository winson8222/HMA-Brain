// Tamper-evident audit records: a hash chain. Pure functions, unit-tested.
//
// Each record stores the previous record's hash, and its own hash covers its contents plus that link.
// Editing, deleting or reordering any record breaks every hash after it. The hash is an HMAC with a
// server-side key, so someone who can write to Elasticsearch still can't forge a consistent chain.
import { createHmac } from "node:crypto";

export type Decision = "allowed" | "dropped" | "denied";

// One document considered for a search or answer.
//   allowed: shown to the person (and, for Ask, given to the LLM)
//   dropped: matched their stored permissions but failed the live re-check with the source
//   denied:  matched the query but isn't shared with them (never shown; admin view only)
export type AuditDoc = {
  doc_id: string;
  source: string;
  title: string;
  path?: string;
  decision: Decision;
  reason?: string;
  cited?: boolean; // Ask only: the answer cites it
};

// Every record has a kind; each kind carries its own fields. All kinds share one hash chain.
// Records never hold message, page or file text: only IDs, titles, paths and permission labels.
export type AuditKind = AuditEvent["kind"];
export const AUDIT_KINDS = ["search", "ask", "permission_change", "content_change", "account", "admin"] as const satisfies readonly AuditKind[];

// "search,ask" or "permission" style input → known kinds. "access" = search + ask; a prefix like
// "permission" or "content" names the matching kind. Nothing valid → undefined (no kind filter).
export function parseKinds(raw: string | undefined): AuditKind[] | undefined {
  if (!raw) return undefined;
  const out = new Set<AuditKind>();
  for (const w of raw.split(",").map((x) => x.trim().toLowerCase())) {
    if (w === "access") (out.add("search"), out.add("ask"));
    for (const k of AUDIT_KINDS) if (w && (k === w || k.startsWith(`${w}_`))) out.add(k);
  }
  return out.size ? [...out] : undefined;
}

// A search or an Ask answer: who asked what, and which documents were shown or withheld.
export type AccessEvent = {
  actor: string; // who asked (login email)
  kind: "search" | "ask";
  via: string; // "web" | "cli"
  mode?: "me" | "demo"; // signed in as themselves, or a demo impersonation (absent on older records)
  sources: string[]; // which sources were searched, e.g. ["drive"]
  query: string;
  keywords?: string;
  answer?: string;
  docs: AuditDoc[];
};

// One indexed item (a Drive file, Jira issue, Confluence page, Slack message or channel), not a chunk.
// id is the item's doc ID prefix: drive:<file>, jira:<site>:<issue>, confluence:<site>:<page>, slack:...
export type AuditItem = { id: string; source: string; title: string; path?: string };

// Who may see an item: its permission labels, plus (Jira security levels, Confluence restrictions)
// the narrower set a person must ALSO be in.
export type Access = { labels: string[]; restricted_to?: string[] };

// How the system noticed a change.
export type SyncVia = "backfill" | "poll" | "reconcile" | "live-recheck" | "event";

// Two times on every permission and content change:
//   changed_at:  when it happened in the source, if the source says (Drive's change feed, an item's own
//                modified time, a Slack event). null when the source doesn't expose it (e.g. Jira and
//                Confluence permission changes): then only the detection time is known.
//   detected_at: when this system saw it (a poll, a reconcile, a live re-check, an event).
// detected_at - changed_at is the detection lag. Searches in between are still protected by the live re-check.
type ChangeTimes = { changed_at?: string | null; detected_at?: string }; // optional only on records written before they existed

export type PermissionChangeEvent = {
  kind: "permission_change";
  actor: "system";
  via: SyncVia;
  source: string;
  item: AuditItem;
  old_access?: Access; // absent when the old labels weren't known
  new_access?: Access;
  summary: string; // readable: "lost: drive:user:dave@…; gained: …"
} & ChangeTimes;

export type ContentChangeEvent =
  | {
      kind: "content_change";
      actor: "system";
      via: SyncVia;
      source: string;
      change: "added" | "updated" | "deleted";
      item: AuditItem;
      modified_at?: string | null; // older records only: the source's modified time (now changed_at)
      indexed_at: string; // when the index caught up
    } & ChangeTimes
  | {
      // A first (or reset) backfill: one summary instead of one record per item.
      kind: "content_change";
      actor: "system";
      via: SyncVia;
      source: string;
      change: "backfill";
      items: number;
      summary: string;
      indexed_at: string;
    };

export type AccountEvent = {
  kind: "account";
  actor: string; // the person (login email)
  via: string;
  source: "slack" | "atlassian" | "drive";
  action: "connect" | "disconnect";
  account?: string; // the linked account or workspace, e.g. "Acme (T123)" or an Atlassian display name
};

export type AdminEvent = {
  kind: "admin";
  actor: string; // "admin" (the shared ADMIN_TOKEN identifies no one more specific)
  via: string;
  action: "audit_query" | "audit_verify" | "sync_now";
  detail?: Record<string, string>; // the filter used, the source synced
  result?: string;
};

export type AuditEvent = AccessEvent | PermissionChangeEvent | ContentChangeEvent | AccountEvent | AdminEvent;

type Sealed = {
  v: 1;
  seq: number;
  at: string;
  prev_hash: string;
  hash: string;
};
// Searches and answers also list the doc IDs per decision, for the "who saw X" queries.
type AccessIds = { allowed_ids: string[]; dropped_ids: string[]; denied_ids: string[] };

export type AccessRecord = AccessEvent & Sealed & AccessIds;
export type AuditRecord = (AccessEvent & AccessIds & Sealed) | (Exclude<AuditEvent, AccessEvent> & Sealed);

export const isAccess = (r: AuditEvent): r is AccessEvent => r.kind === "search" || r.kind === "ask";

export const GENESIS = "0".repeat(64);

// Stable JSON: sorted keys, undefined dropped (as it is when stored), so a record read back hashes the same.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const recordHash = (key: string, body: object) =>
  createHmac("sha256", key).update(canonical(body)).digest("hex");

export function seal(e: AuditEvent, prev: Pick<AuditRecord, "seq" | "hash"> | null, key: string, at = new Date().toISOString()): AuditRecord {
  const link = { v: 1 as const, seq: prev ? prev.seq + 1 : 1, at, prev_hash: prev?.hash ?? GENESIS };
  let body: object;
  if (isAccess(e)) {
    // Same fields, in the same shape, as before other kinds existed: old records still verify.
    const ids = (d: Decision) => e.docs.filter((x) => x.decision === d).map((x) => x.doc_id);
    body = { ...e, actor: e.actor.toLowerCase(), ...link, allowed_ids: ids("allowed"), dropped_ids: ids("dropped"), denied_ids: ids("denied") };
  } else body = { ...e, actor: e.actor.toLowerCase(), ...link };
  return { ...body, hash: recordHash(key, body) } as AuditRecord;
}

export type Problem = { seq: number; problem: string };
export type VerifyResult = { ok: boolean; checked: number; head: { seq: number; hash: string } | null; problems: Problem[] };

// Records must be sorted by seq. Removing records from the very end can't be seen from the chain
// alone; compare the head with one noted earlier (see docs/drive-setup.md, "Audit log").
export function verifyChain(records: AuditRecord[], key: string): VerifyResult {
  const problems: Problem[] = [];
  let expectedSeq = 1;
  let prevHash = GENESIS;
  for (const r of records) {
    if (r.seq > expectedSeq) problems.push({ seq: r.seq, problem: `records ${expectedSeq}–${r.seq - 1} are missing` });
    else if (r.seq < expectedSeq) problems.push({ seq: r.seq, problem: "out of order or duplicated" });
    else if (r.prev_hash !== prevHash) problems.push({ seq: r.seq, problem: "link to the previous record is broken (records deleted, reordered or replaced)" });
    const { hash, ...body } = r;
    if (recordHash(key, body) !== hash) problems.push({ seq: r.seq, problem: "contents changed after it was written" });
    prevHash = r.hash;
    expectedSeq = r.seq + 1;
  }
  const last = records.at(-1);
  return { ok: problems.length === 0, checked: records.length, head: last ? { seq: last.seq, hash: last.hash } : null, problems };
}
