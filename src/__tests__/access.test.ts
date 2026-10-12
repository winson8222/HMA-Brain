import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ search: vi.fn(), getMeta: vi.fn(), browsableIssues: vi.fn(), canRead: vi.fn(), jiraCall: vi.fn(), confluenceCall: vi.fn(), jiraAccess: vi.fn(), confluenceAccess: vi.fn() }));
vi.mock("../es.js", () => ({ es: { search: mocks.search } }));
vi.mock("../connectors/index.js", () => ({ driveConfigured: true, jiraConfigured: true, confluenceConfigured: true, connectors: ["slack", "drive", "jira", "confluence"].map((name) => ({ name })) }));
vi.mock("../people.js", () => ({ findPerson: async () => ({ accounts: [] }) }));
vi.mock("../connectors/drive/config.js", () => ({ driveConfig: { index: "drive" } }));
vi.mock("../connectors/jira/config.js", () => ({ jiraConfig: { index: "jira" } }));
vi.mock("../connectors/confluence/config.js", () => ({ confluenceConfig: { index: "confluence" } }));
vi.mock("../connectors/drive/client.js", () => ({ getMeta: mocks.getMeta, explain: String, isConnected: () => false }));
vi.mock("../connectors/jira/client.js", () => ({ browsableIssues: mocks.browsableIssues, call: mocks.jiraCall }));
vi.mock("../connectors/confluence/client.js", () => ({ canRead: mocks.canRead, call: mocks.confluenceCall }));
vi.mock("../connectors/jira/people.js", () => ({ jiraAccess: mocks.jiraAccess }));
vi.mock("../connectors/confluence/people.js", () => ({ confluenceAccess: mocks.confluenceAccess }));
// Isolate unrelated route dependencies.
vi.mock("../config.js", () => ({ config: { allowImpersonation: false } }));
vi.mock("../session.js", () => ({ getSession: () => "bob@gmail.com" }));
vi.mock("../llm.js", () => ({ llmConfigured: () => false }));
vi.mock("../audit/record.js", () => ({ recordAudit: vi.fn() }));
vi.mock("../connectors/drive/auth.js", () => ({ newOAuthClient: vi.fn(), saveToken: vi.fn(), SCOPES: [] }));
vi.mock("../connectors/drive/query.js", () => ({ driveAsk: vi.fn(), driveSearch: vi.fn() }));
vi.mock("../connectors/drive/store.js", () => ({ ensureDriveIndices: async () => {}, getConnector: async () => null }));
vi.mock("../connectors/drive/sync.js", () => ({ driveStatus: {}, loadStatus: vi.fn(), pollOnce: vi.fn(), summary: vi.fn() }));
import { driveRouter } from "../connectors/drive/routes.js";
import { accessSummary } from "../access.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.jiraAccess.mockResolvedValue({ accountId: "bob", keys: ["user:bob"] });
  mocks.confluenceAccess.mockResolvedValue({ accountId: "bob", keys: ["user:bob"] });
});

describe("connection summaries do not expose content inventories", () => {
  it("returns only source connection flags without searching or fetching document metadata", async () => {
    expect(await accessSummary("bob@gmail.com")).toEqual({
      connected: { slack: false, drive: true, jira: true, confluence: true },
    });
    for (const fn of [mocks.search, mocks.getMeta, mocks.browsableIssues, mocks.canRead, mocks.jiraCall, mocks.confluenceCall]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
  it("marks sources unavailable for an identity without a source account", async () => {
    mocks.jiraAccess.mockResolvedValue(null);
    mocks.confluenceAccess.mockResolvedValue(null);
    expect(await accessSummary("workspace:U123")).toEqual({
      connected: { slack: false, drive: false, jira: false, confluence: false },
    });
  });
  it("returns identities without file names from the legacy Drive people endpoint", async () => {
    const route = driveRouter.stack.find((layer) => layer.route?.path === "/api/drive/people")!.route!;
    const res = { set: vi.fn(), json: vi.fn(), status: vi.fn() };
    await route.stack[0].handle({} as Request, res as unknown as Response, () => {});
    expect(res.json).toHaveBeenCalledWith([{ name: "bob@gmail.com", email: "bob@gmail.com", admin: false, role: "" }]);
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.getMeta).not.toHaveBeenCalled();
  });
});
