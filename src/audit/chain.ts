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

export type AuditEvent = {
  actor: string; // who asked (login email)
  kind: "search" | "ask";
  via: string; // "web" | "cli"
  sources: string[]; // which sources were searched, e.g. ["drive"]
  query: string;
  keywords?: string;
  answer?: string;
  docs: AuditDoc[];
};

export type AuditRecord = AuditEvent & {
  v: 1;
  seq: number;
  at: string;
  allowed_ids: string[];
  dropped_ids: string[];
  denied_ids: string[];
  prev_hash: string;
  hash: string;
};

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

export const recordHash = (key: string, body: Omit<AuditRecord, "hash">) =>
  createHmac("sha256", key).update(canonical(body)).digest("hex");

export function seal(e: AuditEvent, prev: Pick<AuditRecord, "seq" | "hash"> | null, key: string, at = new Date().toISOString()): AuditRecord {
  const ids = (d: Decision) => e.docs.filter((x) => x.decision === d).map((x) => x.doc_id);
  const body: Omit<AuditRecord, "hash"> = {
    ...e,
    actor: e.actor.toLowerCase(),
    v: 1,
    seq: prev ? prev.seq + 1 : 1,
    at,
    allowed_ids: ids("allowed"),
    dropped_ids: ids("dropped"),
    denied_ids: ids("denied"),
    prev_hash: prev?.hash ?? GENESIS,
  };
  return { ...body, hash: recordHash(key, body) };
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
