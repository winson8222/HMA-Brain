import { describe, expect, it } from "vitest";
import { canonical, GENESIS, seal, verifyChain, type AuditEvent, type AuditRecord } from "../audit/chain.js";

const KEY = "test-key";

const event = (query: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  actor: "Bob@Example.com",
  kind: "ask",
  via: "web",
  sources: ["drive"],
  query,
  answer: "The failover step is to promote the replica [1].",
  docs: [
    { doc_id: "drive:F1:0", source: "drive", title: "Payment service runbook", decision: "allowed", cited: true },
    { doc_id: "drive:F2:0", source: "drive", title: "Q3 breach report", decision: "denied", reason: "not shared with this person" },
    { doc_id: "drive:F3:1", source: "drive", title: "DB migration plan", decision: "dropped", reason: "access removed in Drive" },
  ],
  ...extra,
});

function chain(n: number): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (let i = 0; i < n; i++) out.push(seal(event(`question ${i + 1}`), out.at(-1) ?? null, KEY, `2026-09-28T10:0${i}:00.000Z`));
  return out;
}

// What Elasticsearch hands back: plain JSON, undefined fields gone.
const stored = (r: AuditRecord[]) => JSON.parse(JSON.stringify(r)) as AuditRecord[];

describe("audit hash chain", () => {
  it("links each record to the previous one and records who saw what", () => {
    const [a, b] = chain(2);
    expect(a.seq).toBe(1);
    expect(a.prev_hash).toBe(GENESIS);
    expect(b.prev_hash).toBe(a.hash);
    expect(a.actor).toBe("bob@example.com");
    expect(a.allowed_ids).toEqual(["drive:F1:0"]);
    expect(a.denied_ids).toEqual(["drive:F2:0"]);
    expect(a.dropped_ids).toEqual(["drive:F3:1"]);
  });

  it("an untouched chain verifies, including after a round trip through storage", () => {
    const v = verifyChain(stored(chain(3)), KEY);
    expect(v).toMatchObject({ ok: true, checked: 3, problems: [] });
    expect(v.head?.seq).toBe(3);
  });

  it("canonical form ignores key order and undefined fields", () => {
    expect(canonical({ b: 1, a: [1, { d: undefined, c: "x" }] })).toBe(canonical({ a: [1, { c: "x" }], b: 1 }));
  });

  it("detects an edited record", () => {
    const records = stored(chain(3));
    records[1].answer = "Nothing to see here.";
    expect(verifyChain(records, KEY).problems).toEqual([{ seq: 2, problem: "contents changed after it was written" }]);
  });

  it("detects a hidden denial (a doc's decision changed)", () => {
    const records = stored(chain(2));
    records[0].docs[1].decision = "allowed";
    expect(verifyChain(records, KEY).ok).toBe(false);
  });

  it("detects a deleted record", () => {
    const records = stored(chain(3));
    records.splice(1, 1);
    expect(verifyChain(records, KEY).problems).toEqual([{ seq: 3, problem: "records 2–2 are missing" }]);
  });

  it("detects a record replaced by a correctly re-sealed fake (the next link breaks)", () => {
    const records = stored(chain(3));
    records[1] = seal(event("something else"), records[0], KEY, records[1].at);
    const v = verifyChain(records, KEY);
    expect(v.ok).toBe(false);
    expect(v.problems[0].seq).toBe(3);
  });

  it("a chain rebuilt without the server's key doesn't verify", () => {
    const forged: AuditRecord[] = [];
    for (let i = 0; i < 2; i++) forged.push(seal(event(`q${i}`), forged.at(-1) ?? null, "attacker-guess"));
    expect(verifyChain(forged, KEY).ok).toBe(false);
  });

  it("an empty log verifies", () => expect(verifyChain([], KEY)).toMatchObject({ ok: true, checked: 0, head: null }));
});
