import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, type AuditEvent, type AuditRecord } from "../audit/chain.js";

const state = vi.hoisted(() => ({ rows: [] as AuditRecord[], failCreate: false }));
vi.mock("../es.js", () => ({ es: {
  indices: { exists: async () => true, putMapping: async () => ({}) },
  search: async (r: any) => {
    if (r.scroll) return { _scroll_id: "evidence", hits: { hits: state.rows.map(x => ({ _id: String(x.seq), _source: x })) } };
    const asc = r.sort[0].seq === "asc";
    const rows = [...state.rows].sort((a,b) => asc ? a.seq-b.seq : b.seq-a.seq)
      .filter(x => !r.search_after || (asc ? x.seq > r.search_after[0] : x.seq < r.search_after[0]));
    return { hits: { hits: rows.slice(0, r.size).map(x => ({ _source: x, sort: [x.seq] })) } };
  },
  scroll: async () => ({ _scroll_id: "evidence", hits: { hits: [] } }),
  clearScroll: async () => ({}),
  deleteByQuery: async () => { state.rows = []; return {}; },
  create: async (r: any) => {
    if (state.failCreate) throw new Error("simulated outage");
    if (state.rows.some(x => x.seq === r.document.seq)) throw { meta: { statusCode: 409 } };
    state.rows.push(r.document);
  },
} }));
let folder: string;
beforeEach(() => {
  vi.resetModules(); state.rows = []; state.failCreate = false;
  folder = mkdtempSync(join(tmpdir(), "audit-store-"));
  process.env.AUDIT_KEY = "test-key";
  process.env.AUDIT_CHECKPOINT_FILE = join(folder, "checkpoint.json");
});
afterEach(() => { rmSync(folder, {recursive:true, force:true}); delete process.env.AUDIT_CHECKPOINT_FILE; delete process.env.AUDIT_KEY; });
const event: AuditEvent = { kind:"admin", actor:"admin", via:"test", action:"audit_verify" };

// Exercise the public store seam: retained trust must survive fresh module/process state.
describe("retained audit checkpoint", () => {
  it("reports uninitialized trust instead of declaring an empty log intact", async () => {
    const { verifyAudit } = await import("../audit/store.js");
    expect((await verifyAudit()).ok).toBe(false);
  });
  it("detects suffix deletion even after restart", async () => {
    const store = await import("../audit/store.js");
    await store.initializeAuditCheckpoint();
    await store.appendAudit(event); await store.appendAudit(event);
    state.rows.pop(); vi.resetModules();
    const restarted = await import("../audit/store.js");
    expect((await restarted.verifyAudit()).ok).toBe(false);
    await expect(restarted.appendAudit(event)).rejects.toThrow();
  });
});

const readAnchor = () => JSON.parse(readFileSync(process.env.AUDIT_CHECKPOINT_FILE!, "utf8"));
const writeAnchor = (value: unknown) => writeFileSync(process.env.AUDIT_CHECKPOINT_FILE!, JSON.stringify(value));

it("rejects appends until explicit initialization, and never replaces an existing checkpoint", async () => {
  const store = await import("../audit/store.js");
  await expect(store.appendAudit(event)).rejects.toThrow("not initialized");
  await store.initializeAuditCheckpoint();
  expect((await store.verifyAudit()).ok).toBe(true);
  await expect(store.initializeAuditCheckpoint()).rejects.toThrow("already exists");
});

it.each(["all", "middle", "edit", "replacement"])("detects %s tampering and refuses to bless it by appending", async (mode) => {
  const store = await import("../audit/store.js");
  await store.initializeAuditCheckpoint();
  for (let i = 0; i < 3; i++) await store.appendAudit(event);
  const trusted = readAnchor();
  if (mode === "all") state.rows = [];
  if (mode === "middle") state.rows.splice(1, 1);
  if (mode === "edit") state.rows[0].actor = "attacker";
  if (mode === "replacement") {
    // Even a correctly signed replacement for the last record disagrees with retained trust.
    state.rows[2] = seal({ ...event, actor: "replacement" }, state.rows[1], "test-key");
  }
  expect((await store.verifyAudit()).ok).toBe(false);
  await expect(store.appendAudit(event)).rejects.toThrow("Audit append blocked");
  expect(readAnchor()).toEqual(trusted);
});

it("rejects an old checkpoint with an unexplained extension instead of silently updating trust", async () => {
  const store = await import("../audit/store.js");
  await store.initializeAuditCheckpoint();
  await store.appendAudit(event);
  const stale = readAnchor();
  await store.appendAudit(event);
  writeAnchor(stale);
  expect((await store.verifyAudit()).ok).toBe(false);
  await expect(store.appendAudit(event)).rejects.toThrow("uncheckpointed extension");
});

it("recovers an exact pending record after an ES failure and process restart", async () => {
  const store = await import("../audit/store.js");
  await store.initializeAuditCheckpoint(); await store.appendAudit(event);
  state.failCreate = true;
  await expect(store.appendAudit({ ...event, actor: "pending-person" })).rejects.toThrow("simulated outage");
  const pending = readAnchor().pending;
  expect(pending.seq).toBe(2);
  expect((await store.verifyAudit()).ok).toBe(false); // read-only: does not replay it
  expect(state.rows).toHaveLength(1);
  state.failCreate = false; vi.resetModules();
  const restarted = await import("../audit/store.js");
  const next = await restarted.appendAudit(event);
  expect(state.rows[1]).toEqual(pending);
  expect(next.seq).toBe(3);
  expect(readAnchor().pending).toBeUndefined();
  expect((await restarted.verifyAudit()).ok).toBe(true);
});

it("settles a pending record already committed to ES without duplicating it", async () => {
  const store = await import("../audit/store.js");
  await store.initializeAuditCheckpoint(); await store.appendAudit(event);
  const previous = readAnchor();
  const second = await store.appendAudit(event);
  writeAnchor({ ...previous, pending: second }); // crash between ES commit and checkpoint commit
  expect((await store.verifyAudit()).ok).toBe(true);
  expect((await store.appendAudit(event)).seq).toBe(3);
  expect(state.rows).toHaveLength(3);
  expect((await store.verifyAudit()).ok).toBe(true);
});

it("serializes writers with independent module queues sharing one retained checkpoint", async () => {
  const server = await import("../audit/store.js");
  await server.initializeAuditCheckpoint();
  vi.resetModules();
  const cli = await import("../audit/store.js");
  await Promise.all(Array.from({length: 8}, (_, i) => (i % 2 ? cli : server).appendAudit(event)));
  expect(state.rows.map(r => r.seq)).toEqual([1,2,3,4,5,6,7,8]);
  expect((await server.verifyAudit()).ok).toBe(true);
  expect(readAnchor().head.seq).toBe(8);
});

it("refuses malformed, mismatched-index, or corrupt pending checkpoints", async () => {
  const store = await import("../audit/store.js");
  await store.initializeAuditCheckpoint();
  const anchor = readAnchor();
  writeAnchor({ ...anchor, index: "different-index" });
  await expect(store.verifyAudit()).rejects.toThrow("AUDIT_INDEX mismatch");
  writeFileSync(process.env.AUDIT_CHECKPOINT_FILE!, "not json");
  await expect(store.verifyAudit()).rejects.toThrow();
  const pending = seal(event, null, "wrong-key");
  writeAnchor({ ...anchor, pending });
  expect((await store.verifyAudit()).ok).toBe(false);
  await expect(store.appendAudit(event)).rejects.toThrow("Invalid pending");
});

it("will bootstrap valid legacy history only explicitly and rejects a damaged legacy chain", async () => {
  const store = await import("../audit/store.js");
  state.rows.push(seal(event, null, "test-key"));
  expect((await store.verifyAudit()).ok).toBe(false);
  await expect(store.appendAudit(event)).rejects.toThrow("not initialized");
  state.rows[0].actor = "altered";
  await expect(store.initializeAuditCheckpoint()).rejects.toThrow("chain is broken");
  state.rows = [seal(event, null, "test-key")];
  await store.initializeAuditCheckpoint();
  expect((await store.appendAudit(event)).seq).toBe(2);
  expect((await store.verifyAudit()).ok).toBe(true);
});


it.each(["mismatched-pending", "missing-prefix"])("never replays a pending record over %s tampering", async mode => {
  const store = await import("../audit/store.js");
  await store.initializeAuditCheckpoint();
  await store.appendAudit(event);
  const previous = readAnchor();
  const pending = await store.appendAudit(event);
  writeAnchor({ ...previous, pending });
  if (mode === "mismatched-pending") state.rows[1] = seal({ ...event, actor: "replacement" }, state.rows[0], "test-key");
  else state.rows.shift();
  expect((await store.verifyAudit()).ok).toBe(false);
  await expect(store.appendAudit(event)).rejects.toThrow("Audit append blocked");
  expect(readAnchor()).toEqual({ ...previous, pending });
});

describe("backup-based repair", () => {
  it.each(["edit", "tail", "all", "extra"])("restores %s damage without changing retained trust", async mode => {
    const store = await import("../audit/store.js");
    await store.initializeAuditCheckpoint();
    for (let i = 0; i < 3; i++) await store.appendAudit(event);
    const original = structuredClone(state.rows);
    const anchor = readAnchor();
    const backup = join(folder, "backup.json"), evidence = join(folder, "evidence.json");
    await store.backupAudit(backup);
    if (mode === "edit") state.rows[0].actor = "attacker";
    if (mode === "tail") state.rows.pop();
    if (mode === "all") state.rows = [];
    if (mode === "extra") state.rows.push(seal(event, state.rows.at(-1)!, "test-key"));
    const damaged = structuredClone(state.rows);
    expect((await store.verifyAudit()).ok).toBe(false);
    expect((await store.repairAudit(backup)).ok).toBe(true);
    expect(state.rows).toEqual(damaged); // dry run never repairs
    expect((await store.repairAudit(backup, evidence)).ok).toBe(true);
    expect(JSON.parse(readFileSync(evidence, "utf8")).documents.map((d: any) => d.source)).toEqual(damaged);
    expect(state.rows).toEqual(original);
    expect(readAnchor()).toEqual(anchor);
    expect((await store.appendAudit(event)).seq).toBe(4);
  });

  it("rejects stale, modified and wrong-index backups without touching damaged history", async () => {
    const store = await import("../audit/store.js");
    await store.initializeAuditCheckpoint(); await store.appendAudit(event);
    const path = join(folder, "backup.json");
    await store.backupAudit(path);
    await store.appendAudit(event);
    const original = structuredClone(state.rows);
    await expect(store.repairAudit(path, join(folder, "evidence.json"))).rejects.toThrow("stale");
    const backup = JSON.parse(readFileSync(path, "utf8"));
    backup.records[0].actor = "attacker";
    writeFileSync(path, JSON.stringify(backup));
    await expect(store.repairAudit(path)).rejects.toThrow("damaged");
    backup.index = "other";
    writeFileSync(path, JSON.stringify(backup));
    await expect(store.repairAudit(path)).rejects.toThrow("AUDIT_INDEX mismatch");
    expect(state.rows).toEqual(original);
  });

  it("refuses to overwrite evidence and can retry an interrupted repair", async () => {
    const store = await import("../audit/store.js");
    await store.initializeAuditCheckpoint(); await store.appendAudit(event);
    const backup = join(folder, "backup.json"), evidence = join(folder, "evidence.json");
    await store.backupAudit(backup);
    state.rows[0].actor = "attacker";
    writeFileSync(evidence, "keep me");
    await expect(store.repairAudit(backup, evidence)).rejects.toThrow();
    expect(state.rows[0].actor).toBe("attacker");
    state.failCreate = true;
    await expect(store.repairAudit(backup, join(folder, "first.json"))).rejects.toThrow("simulated outage");
    expect((await store.verifyAudit()).ok).toBe(false);
    state.failCreate = false;
    expect((await store.repairAudit(backup, join(folder, "retry.json"))).ok).toBe(true);
  });

  it("will not back up a damaged chain or repair without retained trust", async () => {
    const store = await import("../audit/store.js");
    await store.initializeAuditCheckpoint(); await store.appendAudit(event);
    const path = join(folder, "backup.json");
    await store.backupAudit(path);
    state.rows = [];
    await expect(store.backupAudit(join(folder, "bad.json"))).rejects.toThrow("Backup refused");
    rmSync(process.env.AUDIT_CHECKPOINT_FILE!);
    await expect(store.repairAudit(path)).rejects.toThrow("initialized checkpoint");
  });
});
