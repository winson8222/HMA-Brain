import { describe, expect, it } from "vitest";
import { canSeeJira, jiraFilter, jiraKeysFor, labelsFor, pickedGroups, pickedUsers, recheck, toRule } from "../connectors/jira/acl.js";
import { adfToText } from "../connectors/jira/adf.js";
import { issueChunks, issueToDocs, jqlTime, pickerFields, type ProjectAcl, type RawIssue } from "../connectors/jira/docs.js";

const SITE = "acme.atlassian.net";
const roles = { "10002": { users: ["u-lead"], groups: ["g-eng"] } };

describe("toRule", () => {
  it("maps every supported holder; expands project roles into their users and groups", () => {
    const r = toRule(
      SITE,
      [
        { type: "group", parameter: "payments", value: "g-pay" },
        { type: "projectRole", parameter: "10002" },
        { type: "user", parameter: "u-carol" },
        { type: "applicationRole" },
        { type: "anyone" },
        { type: "projectLead" },
        { type: "reporter" },
      ],
      roles,
      "u-pm",
    );
    expect(r.labels).toEqual([
      "jira:acme.atlassian.net:anyone",
      "jira:acme.atlassian.net:group:g-eng",
      "jira:acme.atlassian.net:group:g-pay",
      "jira:acme.atlassian.net:loggedin",
      "jira:acme.atlassian.net:user:u-carol",
      "jira:acme.atlassian.net:user:u-lead",
      "jira:acme.atlassian.net:user:u-pm",
    ]);
    expect(r.reporter).toBe(true);
    expect(r.assignee).toBe(false);
    expect(r.unsupported).toEqual([]);
  });
  it("skips holders it can't label (fail closed) and says which", () => {
    const r = toRule(SITE, [{ type: "sd.customer.portal.only" }, { type: "projectRole", parameter: "999" }, { type: "group", parameter: "old-name" }], roles, null);
    expect(r.labels).toEqual([]);
    expect(r.unsupported).toEqual(["group without an ID", "projectRole 999 (members not readable)", "sd.customer.portal.only"]);
  });
  it("picker-field grants: the people or groups named in that field on each issue", () => {
    const r = toRule(SITE, [{ type: "userCustomField", parameter: "customfield_10050" }, { type: "groupCustomField", parameter: "customfield_10060" }], {}, null);
    expect(r).toMatchObject({ labels: [], userFields: ["customfield_10050"], groupFields: ["customfield_10060"], unsupported: [] });
    const fields = { customfield_10050: [{ accountId: "u-carol" }, { accountId: "u-bob" }], customfield_10060: { groupId: "g-sec", name: "security" } };
    expect(labelsFor(SITE, r, { reporter: null, assignee: null, fields })).toEqual([
      "jira:acme.atlassian.net:group:g-sec",
      "jira:acme.atlassian.net:user:u-bob",
      "jira:acme.atlassian.net:user:u-carol",
    ]);
    expect(labelsFor(SITE, r, { reporter: null, assignee: null, fields: {} })).toEqual([]); // field empty: nobody via it
  });
  it("reads single and multi picker values; skips values without IDs", () => {
    expect(pickedUsers({ accountId: "u-a" })).toEqual(["u-a"]);
    expect(pickedUsers([{ accountId: "u-a" }, { displayName: "no id" }])).toEqual(["u-a"]);
    expect(pickedUsers(null)).toEqual([]);
    expect(pickedGroups([{ name: "old-only" }, { groupId: "g-1" }])).toEqual(["g-1"]);
  });
  it("reporter/assignee become labels only on the issue that has them", () => {
    const r = toRule(SITE, [{ type: "assignee" }], {}, null);
    expect(labelsFor(SITE, r, { reporter: "u-a", assignee: "u-b" })).toEqual(["jira:acme.atlassian.net:user:u-b"]);
    expect(labelsFor(SITE, r, { reporter: "u-a", assignee: null })).toEqual([]);
  });
});

describe("both permission layers", () => {
  const alice = jiraKeysFor(SITE, { accountId: "u-alice", groupIds: ["g-pay"], licensed: true });
  const dave = jiraKeysFor(SITE, { accountId: "u-dave", groupIds: [], licensed: false });
  const pay = { acl_container: ["jira:acme.atlassian.net:group:g-pay"], restricted: false, acl_item: [] };
  const secret = { ...pay, restricted: true, acl_item: ["jira:acme.atlassian.net:user:u-carol"] };

  it("project browse alone decides an unrestricted issue", () => {
    expect(canSeeJira(pay, alice)).toBe(true);
    expect(canSeeJira(pay, dave)).toBe(false);
  });
  it("a security level also has to match, even for someone who can browse the project", () => {
    expect(canSeeJira(secret, alice)).toBe(false);
    expect(canSeeJira(secret, [...alice, "jira:acme.atlassian.net:user:u-carol"])).toBe(true);
  });
  it("a restricted issue with no readable level members is visible to nobody", () => {
    expect(canSeeJira({ ...pay, restricted: true, acl_item: [] }, alice)).toBe(false);
  });
  it("an unlicensed account doesn't get 'any logged-in user'", () => {
    expect(alice).toContain("jira:acme.atlassian.net:loggedin");
    expect(dave).not.toContain("jira:acme.atlassian.net:loggedin");
  });
  it("the ES filter requires both layers", () => {
    expect(jiraFilter(["k"])).toEqual([
      { terms: { acl_container: ["k"] } },
      { bool: { should: [{ term: { restricted: false } }, { terms: { acl_item: ["k"] } }], minimum_should_match: 1 } },
    ]);
  });
  it("the live re-check fails closed", () => {
    expect(recheck({ state: "ok" })).toEqual({ ok: true });
    expect(recheck({ state: "denied" }).ok).toBe(false);
    expect(recheck({ state: "error", error: "timeout" }).ok).toBe(false);
    expect(recheck(undefined).ok).toBe(false);
  });
});

describe("adfToText", () => {
  it("keeps text, line breaks, lists, mentions and links", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Rollback" }] },
        { type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { text: "@Carol" } }, { type: "hardBreak" }, { type: "text", text: "first." }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "disable tx_schema_v2" }] }] }] },
        { type: "paragraph", content: [{ type: "inlineCard", attrs: { url: "https://example.com/runbook" } }] },
      ],
    };
    expect(adfToText(doc)).toBe("Rollback\nAsk @Carol\nfirst.\n- disable tx_schema_v2\n\nhttps://example.com/runbook");
  });
  it("empty or plain-text bodies", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(" plain ")).toBe("plain");
  });
});

const para = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const issue = (over: Partial<RawIssue["fields"]> = {}): RawIssue => ({
  id: "10042",
  key: "PAY-240",
  fields: {
    summary: "Checkout fails after schema migration",
    description: para("Payments return 500 since tx_schema_v2."),
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    project: { id: "10000", key: "PAY", name: "Payments" },
    reporter: { accountId: "u-alice", displayName: "Alice" },
    assignee: { accountId: "u-bob", displayName: "Bob" },
    updated: "2026-09-30T10:00:00.000+0000",
    comment: {
      comments: [
        { id: "1", author: { displayName: "Bob" }, body: para("Rolled back, monitoring."), created: "2026-09-30T11:00:00.000+0000" },
        { id: "2", author: { displayName: "Carol" }, body: para("Root cause is a leaked key."), visibility: { type: "role", value: "Administrators" } },
      ],
    },
    ...over,
  },
});
const acl: ProjectAcl = {
  project_id: "10000",
  key: "PAY",
  name: "Payments",
  browse: { labels: ["jira:acme.atlassian.net:group:g-pay"], reporter: true, assignee: false, userFields: ["customfield_10050"], groupFields: [], unsupported: [] },
  levels: { "10100": { labels: ["jira:acme.atlassian.net:user:u-carol"], reporter: false, assignee: false, userFields: [], groupFields: [], unsupported: [] } },
  hash: "h",
};

describe("issueToDocs", () => {
  it("one doc per chunk, labelled from the project, with a permalink", () => {
    const docs = issueToDocs(SITE, "https://acme.atlassian.net", issue(), acl);
    expect(docs).toHaveLength(2);
    expect(docs[0].doc_id).toBe("jira:acme.atlassian.net:10042:0");
    expect(docs[0].text.startsWith("PAY-240: Checkout fails after schema migration\n\nType: Bug · Status: In Progress")).toBe(true);
    expect(docs[0].acl_container).toEqual(["jira:acme.atlassian.net:group:g-pay", "jira:acme.atlassian.net:user:u-alice"]);
    expect(docs[0].restricted).toBe(false);
    expect(docs[0].permalink).toBe("https://acme.atlassian.net/browse/PAY-240");
  });
  it("someone named only in a picker field the scheme grants gets a label; the project's picker fields are fetched", () => {
    const docs = issueToDocs(SITE, "https://x", issue({ customfield_10050: [{ accountId: "u-dave" }] }), acl);
    expect(docs[0].acl_container).toContain("jira:acme.atlassian.net:user:u-dave");
    expect(pickerFields(acl)).toEqual(["customfield_10050"]);
  });
  it("leaves out comments restricted to a role or group", () => {
    const text = issueChunks(issue()).join("\n");
    expect(text).toContain("Rolled back, monitoring.");
    expect(text).not.toContain("leaked key");
  });
  it("a security level adds item labels; an unknown level makes it visible to nobody", () => {
    expect(issueToDocs(SITE, "https://x", issue({ security: { id: "10100", name: "Security team" } }), acl)[0]).toMatchObject({
      restricted: true,
      acl_item: ["jira:acme.atlassian.net:user:u-carol"],
    });
    expect(issueToDocs(SITE, "https://x", issue({ security: { id: "999" } }), acl)[0]).toMatchObject({ restricted: true, acl_item: [] });
  });
  it("the hash changes when only the labels change", () => {
    const a = issueToDocs(SITE, "https://x", issue(), acl)[0].content_hash;
    const b = issueToDocs(SITE, "https://x", issue(), { ...acl, browse: { ...acl.browse, labels: [] } })[0].content_hash;
    expect(a).not.toBe(b);
  });
});

describe("jqlTime", () => {
  it("formats in the service account's time zone, to the minute", () => {
    const at = new Date("2026-10-02T01:30:45Z");
    expect(jqlTime(at, "UTC")).toBe("2026-10-02 01:30");
    expect(jqlTime(at, "Asia/Singapore")).toBe("2026-10-02 09:30");
    expect(jqlTime(at, "America/Los_Angeles")).toBe("2026-10-01 18:30");
  });
});

describe("Connect Jira", () => {
  it("asks only for read:me, and links only the person still signed in who started it", async () => {
    process.env.JIRA_OAUTH_CLIENT_ID = "cid";
    const { authorizeUrl, linkTarget } = await import("../connectors/jira/auth.js");
    const url = new URL(authorizeUrl("alice@x.com"));
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("scope")).toBe("read:me");
    const state = url.searchParams.get("state")!;
    expect(linkTarget(state, "alice@x.com")).toEqual({ personId: "alice@x.com" });
    expect(linkTarget(state, "mallory@x.com")).toHaveProperty("error"); // someone else's browser
    expect(linkTarget(state, undefined)).toHaveProperty("error");
    expect(linkTarget(state.slice(0, -2) + "xx", "alice@x.com")).toHaveProperty("error"); // tampered
  });
});
