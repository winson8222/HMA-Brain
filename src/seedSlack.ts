// npm run seed:slack — builds the demo in Slack: channels, members and messages in each
// workspace (posted by that workspace's bot), then DMs posted AS the personas using the user
// tokens from Connect. Writes only to Slack; Elasticsearch picks everything up through the
// normal sync. Safe to re-run: existing channels, members and messages are skipped.
import { WebClient } from "@slack/web-api";
import { requireEnv } from "./config.js";
import { personIdOfToken } from "./dms.js";
import { workspaceByKey, type Workspace } from "./slack.js";
import { userTokens } from "./tokens.js";

type Persona = "carol" | "alice" | "bob" | "dave";

const PERSONAS: Record<Persona, { name: string; emoji: string; email: string }> = {
  carol: { name: "Carol", emoji: ":female-detective:", email: requireEnv("CAROL_EMAIL") },
  alice: { name: "Alice", emoji: ":woman-technologist:", email: requireEnv("ALICE_EMAIL") },
  bob: { name: "Bob", emoji: ":man-technologist:", email: requireEnv("BOB_EMAIL") },
  dave: { name: "Dave", emoji: ":construction_worker:", email: requireEnv("DAVE_EMAIL") },
};

type Plan = {
  channels: { name: string; general?: true; private: boolean; members: Persona[] }[];
  messages: [channel: string, as: Persona, text: string][];
};

// Keys match "key" in slack-tokens.json.
const WORKSPACES: Record<string, Plan> = {
  main: {
    channels: [
      { name: "general", general: true, private: false, members: [] }, // everyone is in #general already
      { name: "payments", private: false, members: ["carol", "alice", "bob"] },
      { name: "db-migration", private: false, members: ["carol", "alice", "bob"] },
      { name: "vendor-support", private: false, members: ["carol", "dave"] },
      { name: "payments-incident", private: true, members: ["carol", "alice"] },
      { name: "security", private: true, members: ["carol"] },
    ],
    messages: [
      ["payments", "alice", "Payment API p99 latency spiking since 09:40, looking into it"],
      ["payments", "bob", "Is the checkout outage related to the DB migration?"],
      ["db-migration", "alice", "Migration step 3 blocked: schema lock on `transactions` table, ticket PAY-231"],
      ["db-migration", "bob", "Rollback plan for the migration is in the Confluence runbook"],
      ["payments-incident", "alice", "Root cause of payment outage: connection pool exhausted after migration flag enabled"],
      ["payments-incident", "carol", "Follow-up tickets PAY-240 (pool limits) and PAY-241 (alerting) created"],
      ["payments-incident", "alice", "Failover step added to runbook: switch to replica `pay-db-2`"],
      ["security", "carol", "Q3 breach incident report: leaked API key in public repo, rotated 14 Aug"],
      ["security", "carol", "Vulnerability CVE-2026-1234 in auth service, patch in progress"],
      ["vendor-support", "dave", "Can someone share the payment outage timeline for our SLA report?"],
      ["general", "carol", "Reminder: all-hands on Friday"],
    ],
  },
  vendors: {
    channels: [
      { name: "vendor-general", private: false, members: ["carol", "dave"] },
      { name: "vendor-contracts", private: true, members: ["carol"] },
    ],
    messages: [
      ["vendor-general", "carol", "Vendor SLA review for the payment outage is due Friday"],
      ["vendor-contracts", "carol", "Payment processor contract renewal: penalty clause triggered by the outage, $40k credit"],
    ],
  },
};

// DMs are posted by `from`, using their own user token (they must have connected that workspace).
const DMS: { ws: string; from: Persona; to: Persona[]; text: string }[] = [
  { ws: "main", from: "alice", to: ["carol"], text: "Between us: the outage root cause was my migration flag. Postmortem draft coming tonight." },
  { ws: "main", from: "carol", to: ["alice", "bob"], text: "Standup moved to 10am because of the payment outage" },
  { ws: "vendors", from: "carol", to: ["dave"], text: "Dave, please don't share the outage timeline with other vendors yet" },
];

async function personaIds(ws: Workspace, who: Persona[]): Promise<Partial<Record<Persona, string>>> {
  const ids: Partial<Record<Persona, string>> = {};
  for (const p of who) {
    try {
      ids[p] = (await ws.web.users.lookupByEmail({ email: PERSONAS[p].email })).user!.id!;
    } catch {
      throw new Error(`${ws.teamName}: no Slack user with email ${PERSONAS[p].email} (${PERSONAS[p].name}). Did they accept the invite?`);
    }
  }
  return ids;
}

async function seedChannels(ws: Workspace, plan: Plan) {
  const everyone = [...new Set(plan.channels.flatMap((c) => c.members))];
  const ids = await personaIds(ws, everyone);
  const existing = await ws.listChannels();
  const channelIds: Record<string, string> = {};

  for (const c of plan.channels) {
    let found = existing.find((e) => (c.general ? e.is_general : e.name === c.name));
    if (!found) {
      try {
        found = (await ws.web.conversations.create({ name: c.name, is_private: c.private })).channel;
        console.log(`  created #${c.name}${c.private ? " (private)" : ""}`);
      } catch (e: any) {
        if (e?.data?.error === "name_taken")
          throw new Error(`#${c.name} exists in ${ws.teamName} but the bot can't see it. /invite the bot there, or delete it.`);
        throw e;
      }
    } else if (!!found.is_private !== c.private) {
      console.warn(`  warning: #${c.name} is ${found.is_private ? "private" : "public"}; expected the opposite`);
    }
    if (!found!.is_member && !found!.is_private) await ws.web.conversations.join({ channel: found!.id });
    channelIds[c.name] = found!.id;

    for (const m of c.members) {
      try {
        await ws.web.conversations.invite({ channel: found!.id, users: ids[m]! });
      } catch (e: any) {
        if (!["already_in_channel", "cant_invite_self"].includes(e?.data?.error)) throw e;
      }
    }
  }

  for (const [channel, as, text] of plan.messages) {
    const hist = await ws.web.conversations.history({ channel: channelIds[channel], limit: 200 });
    if (hist.messages?.some((m: any) => m.text === text)) continue;
    await ws.web.chat.postMessage({ channel: channelIds[channel], text, username: PERSONAS[as].name, icon_emoji: PERSONAS[as].emoji });
    console.log(`  posted in #${channel} as ${PERSONAS[as].name}`);
  }
}

// Returns the personas who still need to connect this workspace for their DMs to be seeded.
async function seedDms(ws: Workspace): Promise<Persona[]> {
  const missing: Persona[] = [];
  for (const dm of DMS.filter((d) => d.ws === ws.key)) {
    const token = userTokens(ws.teamId).find((t) => personIdOfToken(t) === PERSONAS[dm.from].email.toLowerCase());
    if (!token) {
      missing.push(dm.from);
      continue;
    }
    const client = new WebClient(token.token);
    const ids = await personaIds(ws, dm.to);
    const conv = await client.conversations.open({ users: dm.to.map((p) => ids[p]).join(",") });
    const channel = conv.channel!.id!;
    const hist = await client.conversations.history({ channel, limit: 200 });
    if (hist.messages?.some((m: any) => m.text === dm.text)) continue;
    await client.chat.postMessage({ channel, text: dm.text });
    console.log(`  DM from ${PERSONAS[dm.from].name} to ${dm.to.map((p) => PERSONAS[p].name).join(", ")}`);
  }
  return [...new Set(missing)];
}

async function main() {
  const todo: string[] = [];
  for (const [key, plan] of Object.entries(WORKSPACES)) {
    const ws = await workspaceByKey(key);
    if (!ws) {
      console.warn(`Skipping "${key}": no workspace with that key in slack-tokens.json`);
      continue;
    }
    console.log(`${ws.teamName} (${key}):`);
    await seedChannels(ws, plan);
    const missing = await seedDms(ws);
    for (const p of missing) todo.push(`${PERSONAS[p].name} → connect ${ws.teamName}`);
  }
  if (todo.length) {
    console.log("\nSome DMs weren't seeded yet. Open /connect in each person's browser and connect:");
    todo.forEach((t) => console.log(`  - ${t}`));
    console.log("Then run `npm run seed:slack` again.");
  } else console.log("\nSeed done.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
