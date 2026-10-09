// The audit log in Elasticsearch (`brain-audit`): append-only records chained by hash (see chain.ts).
// Every kind of record (searches, answers, permission and content changes, account links, admin actions)
// goes into the same chain; see chain.ts for the kinds.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { es } from "../es.js";
import { seal, verifyChain, type AuditEvent, type AuditKind, type AuditRecord, type Decision, type VerifyResult } from "./chain.js";

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
    // permission_change, content_change, account, admin
    source: { type: "keyword" },
    item: { properties: { id: { type: "keyword" }, title: { type: "keyword" }, source: { type: "keyword" } } },
    change: { type: "keyword" },
    action: { type: "keyword" },
    summary: { type: "text" },
    modified_at: { type: "date" },
    indexed_at: { type: "date" },
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
  } else {
    // An index created before the newer kinds existed: add their fields (adding fields is always allowed).
    await es.indices.putMapping({ index: INDEX, ...mappings });
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
  // An item: a doc ID (drive:<file>:<n>), an item ID (drive:<file>, jira:<site>:<issue>), a bare Drive file
  // ID, or words from its title. Matches searches that returned it AND its permission/content changes.
  doc?: string;
  kind?: AuditKind[];
  decision?: Decision;
  since?: string;
  until?: string;
  text?: string; // words in the question, answer or change summary
  limit?: number;
};

const DECISION_FIELDS = (d?: Decision) => (d ? [d] : (["allowed", "dropped", "denied"] as const)).map((x) => `${x}_ids`);

// A chunk's doc ID → its item's ID (drive:F:3 → drive:F). Anything else is already an item ID.
const CHUNK_PARTS: Record<string, number> = { drive: 3, jira: 4, confluence: 4 };
export function itemIdOf(docId: string): string {
  const parts = docId.split(":");
  return parts.length === CHUNK_PARTS[parts[0]] && /^\d+$/.test(parts.at(-1)!) ? parts.slice(0, -1).join(":") : docId;
}

// Every way the `doc` filter can name an item.
export function docClauses(raw: string, decision?: Decision): object[] {
  const d = raw.trim();
  const ids = DECISION_FIELDS(decision);
  const out: object[] = [];
  const titleWords = { value: `*${d.replace(/[*?\\]/g, "")}*`, case_insensitive: true };
  out.push({ wildcard: { "docs.title": titleWords } });
  if (!decision) out.push({ wildcard: { "item.title": titleWords } });
  if (/\s/.test(d)) return out; // a title, not an ID
  const itemIds = d.includes(":") ? [d, itemIdOf(d)] : [`drive:${d}`];
  for (const f of ids) {
    out.push({ term: { [f]: d } });
    for (const i of itemIds) out.push({ prefix: { [f]: `${i}:` } });
  }
  if (!decision) out.push({ terms: { "item.id": [...new Set(itemIds)] } });
  return out;
}

// "Who saw X?", "What did Bob ask this week?", "When did Dave lose access to the postmortem?": newest first.
export async function queryAudit(f: AuditFilter): Promise<AuditRecord[]> {
  await ensureAuditIndex();
  const filter: object[] = [];
  if (f.actor) filter.push({ term: { actor: f.actor.trim().toLowerCase() } });
  if (f.kind?.length) filter.push({ terms: { kind: f.kind } });
  if (f.doc) filter.push({ bool: { should: docClauses(f.doc, f.decision), minimum_should_match: 1 } });
  if (f.decision) filter.push({ bool: { should: DECISION_FIELDS(f.decision).map((field) => ({ exists: { field } })), minimum_should_match: 1 } });
  if (f.since || f.until) filter.push({ range: { at: { ...(f.since ? { gte: f.since } : {}), ...(f.until ? { lte: f.until } : {}) } } });
  const must = f.text ? [{ multi_match: { query: f.text, fields: ["query", "keywords", "answer", "summary"] } }] : [];
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
