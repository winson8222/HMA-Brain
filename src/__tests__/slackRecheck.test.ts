// The live Slack re-check in retrieve(): one fresh fetch per distinct channel (parallel), and
// a channel whose fetch fails is withheld (fail closed) but still audited.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelInfo } from "../acl.js";
import type { BrainDoc } from "../slackDocs.js";
import type estypes from "@elastic/elasticsearch";

const channel = (id: string, name: string, isPrivate: boolean): ChannelInfo => ({ id, name, is_private: isPrivate, kind: "channel" });

type Hit = { teamId: string; channelId: string; kind: "channel" | "dm"; acl: string[] };
const doc = (h: Hit): BrainDoc =>
  ({
    doc_id: `slack:T1:${h.channelId}:1`,
    source: "slack",
    team_id: h.teamId,
    team_name: "Co",
    channel_id: h.channelId,
    channel_name: h.channelId,
    kind: h.kind,
    is_private: false,
    user_id: "u1",
    user_name: "Alice",
    text: "hello",
    ts: "2026-01-01T00:00:00Z",
    permalink: "p",
    acl_container: h.acl,
  }) as BrainDoc;

const hit = (h: Hit) => ({ _id: h.channelId, _source: doc(h) });

// Fixture: two hits in #pub, one hit in #priv, one DM. Same output the serial version gave.
const FIXTURE: Hit[] = [
  { teamId: "T1", channelId: "Cpub", kind: "channel", acl: ["slack:T1:member"] },
  { teamId: "T1", channelId: "Cpub", kind: "channel", acl: ["slack:T1:member"] },
  { teamId: "T1", channelId: "Cpriv", kind: "channel", acl: ["slack:T1:channel:Cpriv"] },
  { teamId: "T1", channelId: "Ddm", kind: "dm", acl: ["person:alice@x.com"] },
];

const getChannel = vi.fn();
const workspacesMock: Record<string, { getChannel: (...a: unknown[]) => unknown }> = {
  "T1": {
    getChannel: (...a: unknown[]) => getChannel(...a),
  },
};

vi.mock("../es.js", () => ({
  es: {
    search: vi.fn(async (body: { query?: { bool?: { filter?: unknown[] } } }) => {
      // First call: candidates (lexical). Second call: the shadow (denied) search — nothing extra.
      return { hits: { hits: [] } };
    }),
    count: vi.fn(async () => ({ count: 0 })),
  },
  INDEX: "brain",
  ensureIndex: vi.fn(async () => {}),
}));
vi.mock("../people.js", () => ({
  getAccess: vi.fn(async () => ({ personId: "alice@x.com", principals: ["person:alice@x.com", "slack:T1:member", "slack:T1:channel:Cpub"], workspaces: [], fetchedAt: Date.now() })),
}));
vi.mock("../slack.js", () => ({
  workspaceByTeam: vi.fn(async (teamId: string) => workspacesMock[teamId]),
}));
vi.mock("../embeddings.js", () => ({ embedQuery: vi.fn(), embedTexts: vi.fn(), embeddingConfigured: () => false }));
vi.mock("../hybrid.js", () => ({ resolveRerank: () => false, resolveRetrievalMode: () => "lexical", resolveMultiQuery: () => 0, rrfFuse: () => [] }));
vi.mock("../llm.js", () => ({ llmConfigured: () => false, chat: vi.fn() }));
vi.mock("../multiQuery.js", () => ({ paraphrase: vi.fn() }));
vi.mock("../rerank.js", () => ({ rerank: vi.fn(), applyRerankOrder: vi.fn() }));
vi.mock("../tracing.js", () => ({ withSpan: (_n: string, _a: object, fn: () => unknown) => fn(), withTrace: (_n: string, _a: object, fn: () => unknown) => fn() }));

const { retrieve } = await import("../search.js");
const { es } = await import("../es.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(es.search).mockImplementation(async () => ({ hits: { hits: [] } }) as never);
});

const primeCandidates = (fixture: Hit[]) => {
  vi.mocked(es.search).mockImplementationOnce(async () => ({ hits: { hits: fixture.map(hit) } }) as never);
};

describe("slack live re-check", () => {
  it("fetches each distinct channel once, in parallel, and drops nothing permitted", async () => {
    primeCandidates(FIXTURE);
    getChannel.mockImplementation(async (_id: string, _fresh: boolean) => {
      if (_id === "Cpriv") return channel("Cpriv", "priv", true);
      return channel(_id, _id, false);
    });
    const r = await retrieve("alice@x.com", "hello", 10, { rerank: false });
    // 3 distinct channels in the fixture (Cpub twice, Cpriv, and the DM is not a channel).
    expect(getChannel).toHaveBeenCalledTimes(2);
    expect(getChannel).toHaveBeenCalledWith("Cpub", true);
    expect(getChannel).toHaveBeenCalledWith("Cpriv", true);
    // Public channels pass for a member, and the DM passes via its person principal; #priv stays out.
    expect(r.allowed.map((h) => h._id)).toEqual(["Cpub", "Cpub", "Ddm"]);
    expect(r.audit.droppedByRecheck.map((d) => d.id)).toEqual(["Cpriv"]);
    expect(r.audit.allowed).toHaveLength(3);
  });

  it("withholds a channel whose fetch errors, and still audits it", async () => {
    primeCandidates(FIXTURE);
    getChannel.mockImplementation(async (id: string) => {
      if (id === "Cpub") throw new Error("Slack rate limit");
      return channel(id, id, false);
    });
    const r = await retrieve("alice@x.com", "hello", 10, { rerank: false });
    // Cpub hits are withheld; Cpriv comes back but isn't shared; the DM passes (no re-check needed).
    expect(r.allowed.map((h) => h._id)).toEqual(["Cpriv", "Ddm"]);
    expect(r.audit.droppedByRecheck.map((d) => d.id)).toEqual(["Cpub", "Cpub"]);
  });

  it("returns the same result as the serial evaluation for the same fixture", async () => {
    primeCandidates(FIXTURE);
    getChannel.mockImplementation(async (id: string) => (id === "Cpriv" ? channel("Cpriv", "priv", true) : channel(id, id, false)));
    const parallel = await retrieve("alice@x.com", "hello", 10, { rerank: false });
    // Serial ground truth computed by hand: Cpub×2 and the DM allowed; Cpriv dropped (not a member).
    expect(parallel.allowed.map((h) => h._id)).toEqual(["Cpub", "Cpub", "Ddm"]);
    expect(parallel.audit.droppedByRecheck.map((d) => d.id)).toEqual(["Cpriv"]);
  });
});
