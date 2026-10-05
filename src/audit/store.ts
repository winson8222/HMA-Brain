// The audit log in Elasticsearch (`brain-audit`): append-only records chained by hash (see chain.ts).
// Source-agnostic: Drive writes to it today; Slack's in-memory log can switch to appendAudit() later.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { es } from "../es.js";
import { seal, verifyChain, type AuditEvent, type AuditRecord, type Decision, type VerifyResult } from "./chain.js";

const INDEX = process.env.AUDIT_INDEX || "brain-audit";

const mappings = {
  dynamic: false as const, // everything is kept in _source; only these fields are searchable
  properties: {
    seq: { type: "long" },
    at: { type: "date" },
    actor: { type: "keyword" },
    kind: { type: "keyword" },
    via: { type: "keyword" },
    sources: { type: "keyword" },
    query: { type: "text" },
    keywords: { type: "text" },
    answer: { type: "text" },
    allowed_ids: { type: "keyword" },
    dropped_ids: { type: "keyword" },
    denied_ids: { type: "keyword" },
    docs: { properties: { doc_id: { type: "keyword" }, title: { type: "keyword" }, decision: { type: "keyword" }, source: { type: "keyword" } } },
    prev_hash: { type: "keyword" },
    hash: { type: "keyword" },
  },
} as const;

// The HMAC key never goes into Elasticsearch. Set AUDIT_KEY, or one is generated in .secrets/ (gitignored).
// Losing it means old records can no longer be verified.
let key: string | undefined;
export function auditKey(): string {
  if (key) return key;
  if (process.env.AUDIT_KEY) return (key = process.env.AUDIT_KEY);
  const file = process.env.AUDIT_KEY_FILE || ".secrets/audit-key";
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e; // another process just created it
    }
  }
  return (key = readFileSync(file, "utf8").trim());
}

let ready = false;
async function ensureAuditIndex() {
  if (ready) return;
  if (!(await es.indices.exists({ index: INDEX }))) {
    await es.indices.create({ index: INDEX, mappings }, { ignore: [400] }); // 400: another process created it first
  }
  ready = true;
}

async function head(): Promise<AuditRecord | null> {
  const r = await es.search<AuditRecord>({ index: INDEX, size: 1, sort: [{ seq: "desc" }] });
  return r.hits.hits[0]?._source ?? null;
}

// Appends run one at a time in this process. Across processes (server + CLI), the record ID is its
// sequence number and `create` refuses a taken ID, so two writers can't fork the chain: the loser retries.
let queue: Promise<unknown> = Promise.resolve();

export function appendAudit(e: AuditEvent): Promise<AuditRecord> {
  const next = queue.then(() => appendNow(e));
  queue = next.catch(() => {});
  return next;
}

async function appendNow(e: AuditEvent): Promise<AuditRecord> {
  await ensureAuditIndex();
  for (let attempt = 0; attempt < 10; attempt++) {
    const rec = seal(e, await head(), auditKey());
    try {
      await es.create({ index: INDEX, id: String(rec.seq), document: rec, refresh: true });
      return rec;
    } catch (err: any) {
      if (err?.meta?.statusCode !== 409) throw err;
    }
  }
  throw new Error("Couldn't append to the audit log: too many concurrent writers");
}

export type AuditFilter = {
  actor?: string;
  doc?: string; // a doc ID (drive:<file>:<n>, slack:<channel>:<ts>) or a bare Drive file ID
  decision?: Decision;
  since?: string;
  until?: string;
  text?: string; // words in the question or answer
  limit?: number;
};

// "Who saw X?", "What did Bob ask this week?", "Show every denial": newest first.
export async function queryAudit(f: AuditFilter): Promise<AuditRecord[]> {
  await ensureAuditIndex();
  const filter: object[] = [];
  const decisions: Decision[] = f.decision ? [f.decision] : ["allowed", "dropped", "denied"];
  if (f.actor) filter.push({ term: { actor: f.actor.trim().toLowerCase() } });
  if (f.doc) {
    const d = f.doc.trim();
    const match = d.includes(":") ? (field: string) => ({ term: { [field]: d } }) : (field: string) => ({ prefix: { [field]: `drive:${d}:` } });
    filter.push({ bool: { should: decisions.map((x) => match(`${x}_ids`)), minimum_should_match: 1 } });
  } else if (f.decision) filter.push({ exists: { field: `${f.decision}_ids` } });
  if (f.since || f.until) filter.push({ range: { at: { ...(f.since ? { gte: f.since } : {}), ...(f.until ? { lte: f.until } : {}) } } });
  const must = f.text ? [{ multi_match: { query: f.text, fields: ["query", "keywords", "answer"] } }] : [];
  const r = await es.search<AuditRecord>({
    index: INDEX,
    size: Math.min(Math.max(f.limit ?? 50, 1), 500),
    sort: [{ seq: "desc" }],
    query: { bool: { filter, must } },
  });
  return r.hits.hits.map((h) => h._source!);
}

export async function verifyAudit(): Promise<VerifyResult> {
  await ensureAuditIndex();
  const records: AuditRecord[] = [];
  let after: number[] | undefined;
  for (;;) {
    const r = await es.search<AuditRecord>({ index: INDEX, size: 1000, sort: [{ seq: "asc" }], ...(after ? { search_after: after } : {}) });
    const hits = r.hits.hits;
    records.push(...hits.map((h) => h._source!));
    if (hits.length < 1000) break;
    after = hits.at(-1)!.sort as number[];
  }
  return verifyChain(records, auditKey());
}
