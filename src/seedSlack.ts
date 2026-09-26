// npm run seed:slack — creates the demo channels in Slack, adds the personas and posts
// the storyline messages. Writes only to Slack; Elasticsearch picks the messages up
// through the normal sync (live events or `npm run backfill`). Safe to re-run.
import { requireEnv } from "./config.js";
import { listChannels, web } from "./slack.js";

type Persona = "carol" | "alice" | "bob" | "dave";

const PERSONAS: Record<Persona, { name: string; emoji: string; email: string }> = {
  carol: { name: "Carol", emoji: ":female-detective:", email: requireEnv("CAROL_EMAIL") },
  alice: { name: "Alice", emoji: ":woman-technologist:", email: requireEnv("ALICE_EMAIL") },
  bob: { name: "Bob", emoji: ":man-technologist:", email: requireEnv("BOB_EMAIL") },
  dave: { name: "Dave", emoji: ":construction_worker:", email: requireEnv("DAVE_EMAIL") },
};

const CHANNELS: { name: string; general?: true; private: boolean; members: Persona[] }[] = [
  { name: "general", general: true, private: false, members: [] }, // everyone is in #general already
  { name: "payments", private: false, members: ["carol", "alice", "bob"] },
  { name: "db-migration", private: false, members: ["carol", "alice", "bob"] },
  { name: "vendor-support", private: false, members: ["carol", "dave"] },
  { name: "payments-incident", private: true, members: ["carol", "alice"] },
  { name: "security", private: true, members: ["carol"] },
];

const MESSAGES: [channel: string, as: Persona, text: string][] = [
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
];

async function main() {
  // 1. Persona emails → Slack user IDs
  const ids = {} as Record<Persona, string>;
  for (const [key, p] of Object.entries(PERSONAS) as [Persona, (typeof PERSONAS)[Persona]][]) {
    try {
      const r = await web.users.lookupByEmail({ email: p.email });
      ids[key] = r.user!.id!;
    } catch {
      throw new Error(`No Slack user with email ${p.email} (${p.name}). Did they accept the invite?`);
    }
  }
  console.log("Personas found:", ids);

  // 2. Channels (create if missing) and 3. members
  const existing = await listChannels();
  const channelIds: Record<string, string> = {};
  for (const c of CHANNELS) {
    let found = existing.find((e) => (c.general ? e.is_general : e.name === c.name));
    if (!found) {
      try {
        found = (await web.conversations.create({ name: c.name, is_private: c.private })).channel;
        console.log(`created #${c.name}${c.private ? " (private)" : ""}`);
      } catch (e: any) {
        if (e?.data?.error === "name_taken")
          throw new Error(`#${c.name} exists but the bot can't see it. /invite @brain in that channel, or delete it.`);
        throw e;
      }
    } else if (!!found.is_private !== c.private) {
      console.warn(`warning: #${c.name} exists but is ${found.is_private ? "private" : "public"}; expected the opposite`);
    }
    if (!found!.is_member && !found!.is_private) await web.conversations.join({ channel: found!.id });
    channelIds[c.name] = found!.id;

    for (const m of c.members) {
      try {
        await web.conversations.invite({ channel: found!.id, users: ids[m] });
      } catch (e: any) {
        if (!["already_in_channel", "cant_invite_self"].includes(e?.data?.error)) throw e;
      }
    }
  }

  // 4. Messages (skip any already posted)
  for (const [channel, as, text] of MESSAGES) {
    const hist = await web.conversations.history({ channel: channelIds[channel], limit: 200 });
    if (hist.messages?.some((m: any) => m.text === text)) continue;
    await web.chat.postMessage({
      channel: channelIds[channel],
      text,
      username: PERSONAS[as].name,
      icon_emoji: PERSONAS[as].emoji,
    });
    console.log(`posted in #${channel} as ${PERSONAS[as].name}`);
  }
  console.log("Seed done.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
