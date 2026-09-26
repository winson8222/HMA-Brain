import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aclFilter, aclForChannel, canSee, principalsForUser } from "../acl.js";
import { classifyMessageEvent, messageToDoc, type Ctx } from "../slackDocs.js";

// Fixtures follow Slack's event payloads. Replace or extend them with real ones captured
// by running the server with CAPTURE_EVENTS=1 (saved to fixtures/captured/).
const fx = (name: string) => JSON.parse(readFileSync(`fixtures/${name}.json`, "utf8"));

const T = "T0DEMO";
const ctx: Ctx = { teamId: T, teamUrl: "https://companyademo.slack.com/", userName: (id) => ({ U0ALICE: "Alice", U0BOB: "Bob" })[id] };
const incident = { id: "C0PAYINC", name: "payments-incident", is_private: true };
const payments = { id: "C0PAYMENTS", name: "payments", is_private: false };
const security = { id: "C0SECURITY", name: "security", is_private: true };

describe("aclForChannel", () => {
  it("public channel: any full member, or guests in the channel", () => {
    expect(aclForChannel(T, payments)).toEqual([`slack:ws:${T}:member`, "slack:channel:C0PAYMENTS"]);
  });
  it("private channel: members only", () => {
    expect(aclForChannel(T, incident)).toEqual(["slack:channel:C0PAYINC"]);
  });
});

describe("visibility", () => {
  const alice = principalsForUser(T, "U0ALICE", false, ["C0PAYMENTS", "C0PAYINC"]);
  const bob = principalsForUser(T, "U0BOB", false, ["C0PAYMENTS"]);
  const guest = principalsForUser(T, "U0DAVE", true, ["C0VENDOR"]);

  it("member of private channel sees it", () => expect(canSee(aclForChannel(T, incident), alice)).toBe(true));
  it("non-member does not see private channel", () => expect(canSee(aclForChannel(T, incident), bob)).toBe(false));
  it("full member sees public channels they have not joined", () =>
    expect(canSee(aclForChannel(T, { ...payments, id: "C0OTHER" }), bob)).toBe(true));
  it("guest does not see public channels they are not in", () =>
    expect(canSee(aclForChannel(T, payments), guest)).toBe(false));
  it("ES filter uses the principals", () =>
    expect(aclFilter(bob)).toEqual({ terms: { acl_container: bob } }));
});

describe("messageToDoc", () => {
  it("plain user message", () => {
    const d = messageToDoc(fx("message"), incident, ctx)!;
    expect(d.doc_id).toBe("slack:C0PAYINC:1790000000.000100");
    expect(d.user_name).toBe("Alice");
    expect(d.acl_container).toEqual(["slack:channel:C0PAYINC"]);
    expect(d.permalink).toBe("https://companyademo.slack.com/archives/C0PAYINC/p1790000000000100");
  });
  it("bot message keeps the persona name", () => {
    const d = messageToDoc(fx("bot_message"), incident, ctx)!;
    expect(d.user_name).toBe("Alice");
    expect(d.user_id).toBeNull();
  });
  it("thread reply links to its parent", () => {
    const d = messageToDoc(fx("thread_reply"), payments, ctx)!;
    expect(d.thread_ts).toBe("1790000000.000100");
    expect(d.permalink).toContain("?thread_ts=1790000000.000100");
  });
  it("file share indexes file names", () => {
    expect(messageToDoc(fx("file_share"), security, ctx)!.text).toContain("q3-breach-report.pdf");
  });
  it("system messages are skipped", () => {
    expect(messageToDoc(fx("channel_join"), payments, ctx)).toBeNull();
  });
});

describe("classifyMessageEvent", () => {
  it("new message → upsert", () => expect(classifyMessageEvent(fx("message")).action).toBe("upsert"));
  it("bot message → upsert", () => expect(classifyMessageEvent(fx("bot_message")).action).toBe("upsert"));
  it("edit → upsert the new version", () => {
    const a = classifyMessageEvent(fx("message_changed"));
    expect(a.action).toBe("upsert");
    expect(a.action === "upsert" && messageToDoc(a.msg, payments, ctx)!.text).toContain("(edited)");
    expect(a.action === "upsert" && a.msg.ts).toBe("1790000000.000100");
  });
  it("delete → delete original ts", () =>
    expect(classifyMessageEvent(fx("message_deleted"))).toEqual({ action: "delete", ts: "1790000000.000100" }));
  it("deleted thread parent (tombstone) → delete", () =>
    expect(classifyMessageEvent(fx("tombstone"))).toEqual({ action: "delete", ts: "1790000000.000100" }));
  it("join notice → skip", () => expect(classifyMessageEvent(fx("channel_join")).action).toBe("skip"));
});
