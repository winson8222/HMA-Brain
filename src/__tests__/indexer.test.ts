import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aclFilter, aclForChannel, canSee, personPrincipal, principalsForAccount, type ChannelInfo } from "../acl.js";
import { sign, verify } from "../session.js";
import { classifyMessageEvent, dmName, messageToDoc, type Ctx } from "../slackDocs.js";

// Fixtures follow Slack's event payloads. Replace or extend them with real ones captured
// by running the server with CAPTURE_EVENTS=1 (saved to fixtures/captured/).
const fx = (name: string) => JSON.parse(readFileSync(`fixtures/${name}.json`, "utf8"));

const A = "T0MAIN";
const B = "T0VENDOR";
const ctx: Ctx = {
  teamId: A,
  teamName: "Company A Demo",
  teamUrl: "https://companyademo.slack.com/",
  userName: (id) => ({ U0ALICE: "Alice", U0BOB: "Bob" })[id],
};
const ch = (id: string, name: string, is_private: boolean): ChannelInfo => ({ id, name, is_private, kind: "channel" });
const incident = ch("C0PAYINC", "payments-incident", true);
const payments = ch("C0PAYMENTS", "payments", false);
const security = ch("C0SECURITY", "security", true);
const aliceCarolDm: ChannelInfo = {
  id: "D0ALICECAROL",
  name: dmName("dm", ["Alice", "Carol"]),
  is_private: true,
  kind: "dm",
  participants: ["alice@x.com", "carol@x.com"],
};

describe("aclForChannel", () => {
  it("public channel: any full member of that workspace, or guests in the channel", () => {
    expect(aclForChannel(A, payments)).toEqual([`slack:${A}:member`, `slack:${A}:channel:C0PAYMENTS`]);
  });
  it("private channel: members only", () => {
    expect(aclForChannel(A, incident)).toEqual([`slack:${A}:channel:C0PAYINC`]);
  });
  it("DM: exactly its participants, across workspaces", () => {
    expect(aclForChannel(A, aliceCarolDm)).toEqual(["person:alice@x.com", "person:carol@x.com"]);
  });
});

describe("visibility", () => {
  const alice = [personPrincipal("alice@x.com"), ...principalsForAccount(A, false, ["C0PAYMENTS", "C0PAYINC"])];
  const bob = [personPrincipal("bob@x.com"), ...principalsForAccount(A, false, ["C0PAYMENTS"])];
  const guest = [personPrincipal("dave@x.com"), ...principalsForAccount(A, true, ["C0VENDOR"])];
  // Carol is in both workspaces: her principals are the union.
  const carol = [
    personPrincipal("carol@x.com"),
    ...principalsForAccount(A, false, ["C0PAYINC", "C0SECURITY"]),
    ...principalsForAccount(B, false, ["C0CONTRACTS"]),
  ];
  const contracts = ch("C0CONTRACTS", "vendor-contracts", true);

  it("member of private channel sees it", () => expect(canSee(aclForChannel(A, incident), alice)).toBe(true));
  it("non-member does not see private channel", () => expect(canSee(aclForChannel(A, incident), bob)).toBe(false));
  it("full member sees public channels they have not joined", () =>
    expect(canSee(aclForChannel(A, ch("C0OTHER", "other", false)), bob)).toBe(true));
  it("guest does not see public channels they are not in", () =>
    expect(canSee(aclForChannel(A, payments), guest)).toBe(false));
  it("workspace isolation: a public channel in B is invisible to A-only members", () =>
    expect(canSee(aclForChannel(B, ch("C0VGEN", "vendor-general", false)), alice)).toBe(false));
  it("union: someone in both workspaces sees private channels in each", () => {
    expect(canSee(aclForChannel(A, security), carol)).toBe(true);
    expect(canSee(aclForChannel(B, contracts), carol)).toBe(true);
  });
  it("DM participants see it, others don't", () => {
    expect(canSee(aclForChannel(A, aliceCarolDm), alice)).toBe(true);
    expect(canSee(aclForChannel(A, aliceCarolDm), carol)).toBe(true);
    expect(canSee(aclForChannel(A, aliceCarolDm), bob)).toBe(false);
  });
  it("ES filter uses the principals", () => expect(aclFilter(bob)).toEqual({ terms: { acl_container: bob } }));
});

describe("messageToDoc", () => {
  it("plain user message", () => {
    const d = messageToDoc(fx("message"), incident, ctx)!;
    expect(d.doc_id).toBe(`slack:${A}:C0PAYINC:1790000000.000100`);
    expect(d.team_name).toBe("Company A Demo");
    expect(d.kind).toBe("channel");
    expect(d.user_name).toBe("Alice");
    expect(d.acl_container).toEqual([`slack:${A}:channel:C0PAYINC`]);
    expect(d.permalink).toBe("https://companyademo.slack.com/archives/C0PAYINC/p1790000000000100");
  });
  it("DM message is labelled with its participants", () => {
    const d = messageToDoc(fx("dm_message"), aliceCarolDm, ctx)!;
    expect(d.kind).toBe("dm");
    expect(d.channel_name).toBe("DM: Alice ↔ Carol");
    expect(d.acl_container).toEqual(["person:alice@x.com", "person:carol@x.com"]);
  });
  it("group DM name lists everyone", () => expect(dmName("group_dm", ["Alice", "Bob", "Carol"])).toBe("Group DM: Alice, Bob, Carol"));
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
  it("DM message → upsert", () => expect(classifyMessageEvent(fx("dm_message")).action).toBe("upsert"));
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

describe("signed session / state", () => {
  it("round-trips", () => expect(verify<{ p: string }>(sign({ p: "alice@x.com" }, 60_000))?.p).toBe("alice@x.com"));
  it("rejects tampering", () => {
    const [v, m] = sign({ p: "alice@x.com" }, 60_000).split(".");
    const forged = Buffer.from(JSON.stringify({ p: "carol@x.com", exp: Date.now() + 60_000 })).toString("base64url");
    expect(verify(`${forged}.${m}`)).toBeUndefined();
    expect(verify(`${v}.${m}x`)).toBeUndefined();
  });
  it("rejects expired", () => expect(verify(sign({ p: "a" }, -1))).toBeUndefined());
});
