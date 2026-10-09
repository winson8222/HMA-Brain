import { describe, expect, it } from "vitest";
import { canonical, GENESIS, parseKinds, seal, verifyChain, type AccessEvent, type AccessRecord, type AuditEvent, type AuditRecord } from "../audit/chain.js";
import { access, changeEvents, deletedEvent, describeAccessChange, type Snapshot } from "../audit/events.js";

const KEY = "test-key";

const event = (query: string, extra: Partial<AccessEvent> = {}): AccessEvent => ({
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

function chain(n: number): AccessRecord[] {
  const out: AccessRecord[] = [];
  for (let i = 0; i < n; i++) out.push(<AccessRecord>seal(event(`question ${i + 1}`), out.at(-1) ?? null, KEY, `2026-09-28T10:0${i}:00.000Z`));
  return out;
}

// What Elasticsearch hands back: plain JSON, undefined fields gone.
const stored = <T extends AuditRecord>(r: T[]) => JSON.parse(JSON.stringify(r)) as T[];

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
    records[1] = seal(event("something else"), records[0], KEY, records[1].at) as AccessRecord;
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

describe("audit record kinds", () => {
  const mixed = (): AuditEvent[] => [
    event("who handles the outage?"),
    {
      kind: "permission_change",
      actor: "system",
      via: "poll",
      source: "drive",
      item: { id: "drive:F9", source: "drive", title: "Outage postmortem", path: "Company A/Engineering" },
      old_access: { labels: ["drive:user:dave@x.com", "drive:user:erin@x.com"] },
      new_access: { labels: ["drive:user:erin@x.com"] },
      summary: "lost: drive:user:dave@x.com",
    },
    {
      kind: "content_change",
      actor: "system",
      via: "poll",
      source: "jira",
      change: "updated",
      item: { id: "jira:acme:10001", source: "jira", title: "OPS-1: Vendor follow-up" },
      modified_at: "2026-09-28T09:58:00.000Z",
      indexed_at: "2026-09-28T10:00:00.000Z",
    },
    { kind: "content_change", actor: "system", via: "backfill", source: "confluence", change: "backfill", items: 12, summary: "12 indexed", indexed_at: "2026-09-28T10:00:00.000Z" },
    { kind: "account", actor: "Dave@X.com", via: "web", source: "atlassian", action: "connect", account: "Dave" },
    { kind: "admin", actor: "admin", via: "web", action: "audit_query", detail: { doc: "postmortem" }, result: "3 record(s)" },
  ];
  const sealAll = (events: AuditEvent[], from: AuditRecord[] = []) => {
    const out = [...from];
    for (const e of events) out.push(seal(e, out.at(-1) ?? null, KEY, "2026-09-28T10:00:00.000Z"));
    return out;
  };

  it("every kind hashes into one chain that verifies after a storage round trip", () => {
    const records = stored(sealAll(mixed()));
    expect(records.map((r) => r.kind)).toEqual(["ask", "permission_change", "content_change", "content_change", "account", "admin"]);
    expect(verifyChain(records, KEY)).toMatchObject({ ok: true, checked: 6 });
    expect(records[4].actor).toBe("dave@x.com");
  });

  it("only searches and answers carry per-decision doc ID lists", () => {
    const [ask, perm] = sealAll(mixed());
    expect("allowed_ids" in ask).toBe(true);
    expect("allowed_ids" in perm).toBe(false);
  });

  it("a record written before the new kinds existed still verifies, and new kinds chain onto it", () => {
    // A v1 search record exactly as the old code stored it.
    const old = stored(chain(2));
    const records = stored(sealAll(mixed().slice(1), old));
    expect(verifyChain(records, KEY)).toMatchObject({ ok: true, checked: 7 });
  });

  it("detects an edited permission change (someone hides a lost access)", () => {
    const records = stored(sealAll(mixed()));
    const p = records[1] as Extract<AuditRecord, { kind: "permission_change" }>;
    p.new_access = p.old_access;
    expect(verifyChain(records, KEY).problems).toEqual([{ seq: 2, problem: "contents changed after it was written" }]);
  });

  it("parses kind filters", () => {
    expect(parseKinds("permission")).toEqual(["permission_change"]);
    expect(parseKinds("access, content")).toEqual(["search", "ask", "content_change"]);
    expect(parseKinds("admin,account")).toEqual(["admin", "account"]);
    expect(parseKinds("nonsense")).toBeUndefined();
    expect(parseKinds(undefined)).toBeUndefined();
  });
});

describe("permission and content change events", () => {
  const snap = (labels: string[], modified: string | null = "2026-09-01T00:00:00Z", restricted?: string[]): Snapshot => ({
    title: "Postmortem",
    path: "Company A",
    access: access(labels, restricted),
    modified_at: modified,
  });

  it("nothing changed: no records", () => {
    expect(changeEvents("drive", "poll", "drive:F", snap(["b", "a"]), snap(["a", "b"]))).toEqual([]);
  });

  it("sharing changed: one permission change naming who lost and gained access", () => {
    const [e, ...rest] = changeEvents("drive", "poll", "drive:F", snap(["dave", "erin"]), snap(["erin", "vendor"]));
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ kind: "permission_change", actor: "system", item: { id: "drive:F", title: "Postmortem" }, summary: "lost: dave; gained: vendor" });
  });

  it("content edited: one content change with the source's modified time", () => {
    const [e] = changeEvents("jira", "poll", "jira:s:1", snap(["a"]), snap(["a"], "2026-09-02T00:00:00Z"), { indexedAt: "2026-09-02T00:01:00Z" });
    expect(e).toMatchObject({ kind: "content_change", change: "updated", modified_at: "2026-09-02T00:00:00Z", indexed_at: "2026-09-02T00:01:00Z" });
  });

  it("new item: added, unless it's part of a first backfill", () => {
    expect(changeEvents("drive", "poll", "drive:F", null, snap(["a"]))).toMatchObject([{ change: "added" }]);
    expect(changeEvents("drive", "backfill", "drive:F", null, snap(["a"]), { quietAdd: true })).toEqual([]);
  });

  it("describes restriction changes", () => {
    expect(describeAccessChange(access(["space"]), access(["space"], ["dave"]))).toBe("now restricted to: dave");
    expect(describeAccessChange(access(["space"], ["dave", "erin"]), access(["space"], ["erin"]))).toBe("restriction lost: dave");
    expect(describeAccessChange(access(["space"], ["dave"]), access(["space"]))).toBe("restriction removed");
  });

  it("deleted items are recorded with their title, never their text", () => {
    const e = deletedEvent("confluence", "reconcile", { id: "confluence:s:5", source: "confluence", title: "Runbook" }, "2026-09-01T00:00:00Z");
    expect(e).toMatchObject({ kind: "content_change", change: "deleted", item: { title: "Runbook" } });
    expect(JSON.stringify(e)).not.toMatch(/text/);
  });
});

describe("sources that know whether content changed", () => {
  it("a sharing change that bumped the modified time isn't recorded as an edit", () => {
    const prev: Snapshot = { title: "Postmortem", access: access(["dave", "erin"]), modified_at: "2026-10-09T10:00:00Z" };
    const next: Snapshot = { title: "Postmortem", access: access(["erin"]), modified_at: "2026-10-09T10:22:24Z" };
    expect(changeEvents("drive", "poll", "drive:F", prev, next, { contentChanged: false }).map((e) => e.kind)).toEqual(["permission_change"]);
    expect(changeEvents("drive", "poll", "drive:F", prev, next).map((e) => e.kind)).toEqual(["permission_change", "content_change"]);
  });
});
