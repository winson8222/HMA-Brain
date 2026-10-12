// The audit log in Elasticsearch (`brain-audit`): append-only records chained by hash (see chain.ts).
// Every kind of record (searches, answers, permission and content changes, account links, admin actions)
// goes into the same chain; see chain.ts for the kinds.
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { es } from "../es.js";
import { seal, verifyChain, type AuditEvent, type AuditKind, type AuditRecord, type Decision, type VerifyResult, isAccess } from "./chain.js";
import { readCheckpoint, writeCheckpoint, withCheckpointLock, type Checkpoint } from "./checkpoint.js";

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

// Serialize within a process and across every process sharing the trusted checkpoint file.
let queue: Promise<unknown> = Promise.resolve();
export function appendAudit(e: AuditEvent): Promise<AuditRecord> {
  const next = queue.then(() => withCheckpointLock(() => appendNow(e)));
  queue = next.catch(() => {});
  return next;
}

async function appendNow(e: AuditEvent): Promise<AuditRecord> {
  await ensureAuditIndex();
  let checkpoint = await readCheckpoint(INDEX);
  const records = await readRecords();
  let verified = checkRetained(records, checkpoint);
  if (!verified.ok) throw new Error(`Audit append blocked: ${verified.problems.map(p => p.problem).join("; ")}`);
  if (!checkpoint) throw new Error("Audit checkpoint is not initialized");
  // A crash may leave a write-ahead record not yet in ES. Replay precisely that trusted record,
  // never construct a replacement or move the retained head backwards.
  if (checkpoint.pending) {
    const pending = checkpoint.pending;
    if (!records.some(r => r.seq === pending.seq)) {
      await es.create({ index: INDEX, id: String(pending.seq), document: pending, refresh: true });
      records.push(pending);
    }
    checkpoint = { v: 1, index: INDEX, head: { seq: pending.seq, hash: pending.hash } };
    await writeCheckpoint(checkpoint);
    verified = checkRetained(records, checkpoint);
  }
  const rec = seal(e, verified.head, auditKey());
  await writeCheckpoint({ ...checkpoint, pending: rec });
  await es.create({ index: INDEX, id: String(rec.seq), document: rec, refresh: true });
  await writeCheckpoint({ v: 1, index: INDEX, head: { seq: rec.seq, hash: rec.hash } });
  return rec;
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
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const records: AuditRecord[] = [];
  let after: number[] | undefined;
  // Existing indices store docs as flattened objects. Match on _source to bind title/ID and
  // decision to ONE entry, and page until enough actual matches survive (no reindex required).
  for (;;) {
    const r = await es.search<AuditRecord>({
      index: INDEX, size: limit, sort: [{ seq: "desc" }],
      query: { bool: { filter, must } }, ...(after ? { search_after: after } : {}),
    });
    const hits = r.hits.hits;
    for (const hit of hits) {
      const record = hit._source!;
      if (f.doc && f.decision && !matchesDocumentDecision(record, f.doc, f.decision)) continue;
      records.push(record);
      if (records.length === limit) return records;
    }
    if (hits.length < limit) return records;
    after = hits.at(-1)!.sort as number[];
  }
}

function matchesDocumentDecision(record: AuditRecord, raw: string, decision: Decision): boolean {
  if (!isAccess(record)) return false;
  const d = raw.trim();
  const words = d.replace(/[*?\\]/g, "").toLowerCase();
  const itemIds = d.includes(":") ? [d, itemIdOf(d)] : [`drive:${d}`];
  return record.docs.some(doc => doc.decision === decision && (
    doc.title.toLowerCase().includes(words) || (!/\s/.test(d) &&
      (doc.doc_id === d || itemIds.some(id => doc.doc_id.startsWith(`${id}:`))))
  ));
}

async function readRecords(): Promise<AuditRecord[]> {
  const records: AuditRecord[] = [];
  let after: number[] | undefined;
  for (;;) {
    const r = await es.search<AuditRecord>({ index: INDEX, size: 1000, sort: [{ seq: "asc" }], ...(after ? { search_after: after } : {}) });
    const hits = r.hits.hits;
    records.push(...hits.map((h) => h._source!));
    if (hits.length < 1000) break;
    after = hits.at(-1)!.sort as number[];
  }
  return records;
}

function checkRetained(records: AuditRecord[], checkpoint: Checkpoint | null): VerifyResult {
  const result = verifyChain(records, auditKey());
  result.checkpoint = checkpoint?.head ?? null;
  if (!checkpoint) result.problems.push({ seq: 0, problem: "Audit checkpoint is not initialized; explicitly trust the current history with audit:log -- checkpoint --trust-current-head" });
  else {
    const anchor = checkpoint.head;
    if (anchor && records.find(r => r.seq === anchor.seq)?.hash !== anchor.hash) {
      result.problems.push({ seq: anchor.seq, problem: "Retained checkpoint is missing or mismatched (history deleted or replaced)" });
    }
    if (checkpoint.pending) {
      const pending = checkpoint.pending;
      // Also validate the pending record and its position against the complete committed prefix.
      const prefix = records.filter(r => r.seq <= (anchor?.seq ?? 0));
      const pendingCheck = verifyChain([...prefix, pending], auditKey());
      if (!pendingCheck.ok || pending.seq !== (anchor?.seq ?? 0) + 1) {
        result.problems.push({ seq: pending.seq, problem: "Invalid pending checkpoint record" });
      }
      const stored = records.find(r => r.seq === pending.seq);
      if (stored && stored.hash !== pending.hash) result.problems.push({ seq: pending.seq, problem: "Pending checkpoint differs from the stored record" });
      // One valid pending append is the only permissible extension of the committed head.
      if (records.some(r => r.seq > pending.seq)) result.problems.push({ seq: pending.seq, problem: "Uncheckpointed records follow the pending append" });
    } else if ((result.head?.seq ?? 0) > (anchor?.seq ?? 0)) {
      result.problems.push({ seq: result.head?.seq ?? 0, problem: "Stored history extends beyond the retained checkpoint; refusing to trust an uncheckpointed extension" });
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

export async function verifyAudit(): Promise<VerifyResult> {
  return withCheckpointLock(async () => {
    await ensureAuditIndex();
    const checkpoint = await readCheckpoint(INDEX);
    const records = await readRecords();
    const result = checkRetained(records, checkpoint);
    if (checkpoint?.pending && !records.some(r => r.seq === checkpoint.pending!.seq)) {
      result.problems.push({ seq: checkpoint.pending.seq, problem: "Pending audit append is absent from storage; next append can replay the trusted pending record" });
      result.ok = false;
    }
    return result;
  });
}

// Operator-only explicit trust bootstrap. A valid chain cannot prove that a suffix wasn't removed
// before the first checkpoint, so never call this automatically or replace an existing anchor.
export async function initializeAuditCheckpoint(): Promise<VerifyResult> {
  return withCheckpointLock(async () => {
    await ensureAuditIndex();
    if (await readCheckpoint(INDEX)) throw new Error("Audit checkpoint already exists; refusing to replace retained trust");
    const result = verifyChain(await readRecords(), auditKey());
    if (!result.ok) throw new Error("Cannot initialize checkpoint: stored audit chain is broken");
    await writeCheckpoint({ v: 1, index: INDEX, head: result.head });
    return { ...result, checkpoint: result.head };
  });
}

// Demo-scale local recovery. The retained checkpoint is never replaced or rolled back.
type AuditBackup = { v: 1; index: string; records: AuditRecord[] };
async function saveRecoveryFile(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600); // never overwrite earlier evidence/backups
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  const dir = await open(dirname(path), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

export async function backupAudit(path: string): Promise<VerifyResult> {
  return withCheckpointLock(async () => {
    await ensureAuditIndex();
    const checkpoint = await readCheckpoint(INDEX);
    if (checkpoint?.pending) throw new Error("Settle the pending append before making a backup");
    const records = await readRecords();
    const result = checkRetained(records, checkpoint);
    if (!result.ok) throw new Error("Backup refused: audit history does not match retained trust");
    await saveRecoveryFile(path, { v: 1, index: INDEX, records } satisfies AuditBackup);
    return result;
  });
}

// Scroll independently of seq: damaged/missing/duplicate sequence numbers must not hide evidence.
async function recoveryEvidence() {
  const documents: { id: string | undefined; source: unknown }[] = [];
  let scrollId: string | undefined;
  try {
    let page = await es.search({ index: INDEX, scroll: "1m", size: 1000, sort: ["_doc"] });
    scrollId = page._scroll_id;
    for (;;) {
      documents.push(...page.hits.hits.map(h => ({ id: h._id, source: h._source })));
      if (!page.hits.hits.length) break;
      if (!scrollId) throw new Error("Cannot capture complete repair evidence: missing scroll ID");
      page = await es.scroll({ scroll_id: scrollId, scroll: "1m" });
      scrollId = page._scroll_id ?? scrollId;
    }
  } finally {
    if (scrollId) await es.clearScroll({ scroll_id: scrollId });
  }
  return documents;
}

export async function repairAudit(path: string, evidencePath?: string): Promise<VerifyResult> {
  return withCheckpointLock(async () => {
    const backup = JSON.parse(readFileSync(path, "utf8")) as AuditBackup;
    if (!backup || backup.v !== 1 || backup.index !== INDEX || !Array.isArray(backup.records)) {
      throw new Error("Invalid backup or AUDIT_INDEX mismatch");
    }
    const checkpoint = await readCheckpoint(INDEX);
    if (!checkpoint || checkpoint.pending) throw new Error("Repair requires an initialized checkpoint with no pending append");
    const expected = checkRetained(backup.records, checkpoint);
    if (!expected.ok) throw new Error("Repair refused: backup is damaged, stale, or does not match the retained checkpoint");
    // No evidence path means validation only; never touch the index for a dry run.
    if (!evidencePath) return expected;
    ready = false; // the entire index may have been deleted since this process last used it
    await ensureAuditIndex();
    const documents = await recoveryEvidence();
    await saveRecoveryFile(evidencePath, { v: 1, index: INDEX, capturedAt: new Date().toISOString(), checkpoint, documents });
    const deleted = await es.deleteByQuery({ index: INDEX, query: { match_all: {} }, refresh: true });
    if (deleted.timed_out || deleted.failures?.length || deleted.version_conflicts) {
      throw new Error("Repair interrupted while clearing damaged history; preserve evidence and rerun with the same backup and a new evidence path");
    }
    for (const record of backup.records) {
      await es.create({ index: INDEX, id: String(record.seq), document: record, refresh: true });
    }
    const result = checkRetained(await readRecords(), checkpoint);
    if (!result.ok) throw new Error("Repair verification failed; retain backup/evidence and keep writers stopped");
    return result;
  });
}
