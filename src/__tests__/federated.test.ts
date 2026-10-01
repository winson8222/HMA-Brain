import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, Evidence } from "../connectors/types.js";

const ev = (source: string, ref: string, text: string): Evidence => ({
  source,
  ref,
  title: ref,
  location: source === "slack" ? "Company A" : "Company A Demo / Engineering",
  author: null,
  time: "2026-09-29T00:00:00Z",
  text,
  snippet: text,
  permalink: `https://example.com/${ref}`,
  private: false,
});

// Each fake connector "knows" which person may see what, like the real ones filter by principals.
const fake = (name: string, label: string, byPerson: Record<string, Evidence[]>): Connector => ({
  name,
  label,
  retrieve: vi.fn(async (personId: string) => ({
    allowed: byPerson[personId] ?? [],
    audit: (byPerson[personId] ?? []).map((e) => ({ doc_id: e.ref, source: name, title: e.title, decision: "allowed" as const })),
  })),
  describe: (e) => e.title,
});

const slack = fake("slack", "Slack", {
  "alice@x.com": [ev("slack", "slack:1", "rollback plan is in the Confluence runbook")],
  "dave@x.com": [],
});
const drive = fake("drive", "Google Drive", {
  "alice@x.com": [ev("drive", "drive:runbook:0", "Rollback: disable tx_schema_v2 and redeploy the previous release")],
  "dave@x.com": [],
});

vi.mock("../connectors/index.js", () => ({ connectors: [slack, drive] }));
vi.mock("../audit/store.js", () => ({ appendAudit: vi.fn(async (e: object) => e) }));
vi.mock("../hybrid.js", () => ({
  resolveRerank: () => false,
  rrfFuse: (lists: string[][]) => {
    // Interleave, like RRF does for equal-length lists.
    const out: { id: string; score: number }[] = [];
    for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i]) out.push({ id: l[i], score: 1 / (i + 1) });
    return out;
  },
}));
const chat = vi.fn();
vi.mock("../llm.js", () => ({ chat: (...a: unknown[]) => chat(...a) }));
vi.mock("../prompts.js", () => ({ getPrompt: async () => "RULES" }));
vi.mock("../tracing.js", () => ({ withTrace: (_n: string, _a: object, fn: () => unknown) => fn(), withSpan: (_n: string, _a: object, fn: () => unknown) => fn() }));

const { search, ask, pickConnectors, UnknownSourceError } = await import("../federated.js");
const { appendAudit } = await import("../audit/store.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("federated search", () => {
  it("merges permitted results from every source, labelled by source", async () => {
    const { results, unavailable } = await search("alice@x.com", "rollback", "demo");
    expect(results.map((r) => [r.source, r.sourceLabel])).toEqual([
      ["slack", "Slack"],
      ["drive", "Google Drive"],
    ]);
    expect(unavailable).toEqual([]);
    expect(results[0]).not.toHaveProperty("text"); // content fields only
  });

  it("searches only the chosen sources", async () => {
    const { results } = await search("alice@x.com", "rollback", "demo", ["drive"]);
    expect(results.map((r) => r.source)).toEqual(["drive"]);
    expect(slack.retrieve).not.toHaveBeenCalled();
  });

  it("rejects unknown or empty source lists", () => {
    expect(() => pickConnectors(["jira"])).toThrow(UnknownSourceError);
    expect(() => pickConnectors([])).toThrow(UnknownSourceError);
    expect(pickConnectors(undefined).map((c) => c.name)).toEqual(["slack", "drive"]);
  });

  it("a person with no access gets nothing from any source", async () => {
    const { results } = await search("dave@x.com", "rollback", "demo");
    expect(results).toEqual([]);
  });

  it("one failing source doesn't take down the others, and is reported", async () => {
    vi.mocked(drive.retrieve).mockRejectedValueOnce(new Error("Google token expired"));
    const { results, unavailable } = await search("alice@x.com", "rollback", "demo");
    expect(results.map((r) => r.source)).toEqual(["slack"]);
    expect(unavailable).toEqual(["Google Drive"]);
  });

  it("writes one audit record covering every searched source", async () => {
    await search("alice@x.com", "rollback", "demo");
    expect(appendAudit).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(appendAudit).mock.calls[0][0];
    expect(rec.sources).toEqual(["slack", "drive"]);
    expect(rec.docs.map((d) => d.source)).toEqual(["slack", "drive"]);
  });
});

describe("federated ask", () => {
  it("puts only permitted evidence from the chosen sources in the prompt, and marks citations", async () => {
    chat.mockResolvedValueOnce("rollback runbook").mockResolvedValueOnce("Disable tx_schema_v2 and redeploy [2].");
    const a = await ask("alice@x.com", "Rollback how", "demo");
    const prompt = chat.mock.calls[1][0][1].content as string;
    expect(prompt).toContain("[1] Slack · slack:1");
    expect(prompt).toContain("[2] Google Drive · drive:runbook:0");
    expect(a.sources.map((s) => [s.n, s.source])).toEqual([[2, "drive"]]);
    const rec = vi.mocked(appendAudit).mock.calls[0][0];
    expect(rec.docs.find((d) => d.doc_id === "drive:runbook:0")?.cited).toBe(true);
    expect(rec.docs.find((d) => d.doc_id === "slack:1")?.cited).toBeUndefined();
  });

  it("answers NO_INFO without calling the LLM for the answer when nothing is permitted", async () => {
    chat.mockResolvedValueOnce("rollback");
    const a = await ask("dave@x.com", "Rollback how", "demo");
    expect(a.answer).toBe("I don't have information on that.");
    expect(chat).toHaveBeenCalledTimes(1); // keywords only
  });

  it("still writes the audit record when the LLM fails", async () => {
    chat.mockResolvedValueOnce("rollback").mockRejectedValueOnce(new Error("The LLM didn't respond in time. Try again."));
    await expect(ask("alice@x.com", "Rollback how", "demo")).rejects.toThrow("didn't respond");
    expect(vi.mocked(appendAudit).mock.calls[0][0].answer).toMatch(/^\(no answer:/);
  });
});
