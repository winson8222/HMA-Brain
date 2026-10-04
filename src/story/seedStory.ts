// npm run seed:story [-- --dry-run] [--rewrite]
// Builds the whole demo story at once: the "Company A" folder in Drive (seed:drive's content) and every Slack
// message and DM in timeline.ts. Writes only to Slack and Drive; then run `npm run backfill` and
// `npm run drive:backfill` (or keep the server running with sync on) to index it.
// Every message and DM is posted as its author, with the user token they got by clicking Connect (so Slack shows
// the real person, not the app); authors who haven't connected are listed at the end. Safe to re-run: existing
// files, channels, members and messages are skipped.
//   --dry-run   print what would be posted and change nothing
//   --rewrite   also rewrite every Drive file from seedContent.ts (after editing the content)
import { WebClient } from "@slack/web-api";
import { requireEnv } from "../config.js";
import { accountEmail, explain } from "../connectors/drive/client.js";
import { seed } from "../connectors/drive/cli/seedOps.js";
import { personIdOfToken } from "../dms.js";
import { workspaceByKey, type Workspace } from "../slack.js";
import { userTokens } from "../tokens.js";
import { CHANNELS, STORY, type ChannelDef, type Dm, type Post, type Step, type Who, type WsKey } from "./timeline.js";

const PEOPLE: Record<Who, { name: string; email: string }> = {
  carol: { name: "Carol", email: requireEnv("CAROL_EMAIL").toLowerCase() },
  alice: { name: "Alice", email: requireEnv("ALICE_EMAIL").toLowerCase() },
  bob: { name: "Bob", email: requireEnv("BOB_EMAIL").toLowerCase() },
  dave: { name: "Dave", email: requireEnv("DAVE_EMAIL").toLowerCase() },
};
const WS_NAMES: Record<WsKey, string> = { main: "Company A", vendors: "Vendors" };

const isDm = (s: Step): s is Dm => "to" in s;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const def = (ws: WsKey, name: string) => {
  const c = CHANNELS[ws].find((x) => x.name === name);
  if (!c) throw new Error(`timeline: no channel "${name}" in ${ws}`);
  return c;
};
const channelLabel = (ws: WsKey, name: string) => {
  const c = def(ws, name);
  return `${c.private ? "🔒" : ""}#${c.shown ?? c.name}`;
};

function describe(s: Step): string {
  const where = isDm(s) ? `DM ${[s.as, ...s.to].map((p) => PEOPLE[p].name).join(", ")}` : `${channelLabel(s.ws, s.channel)}${s.thread ? " ↳" : ""}`;
  return `${WS_NAMES[s.ws].padEnd(9)} ${where.padEnd(24)} ${PEOPLE[s.as].name.padEnd(5)}  ${s.text}`;
}

// ---- Slack ----

const decode = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

class SlackSide {
  private channelIds = new Map<string, string>(); // "ws/name" → id
  private seen = new Map<string, { ts: string; text: string }[]>(); // conversation (or thread) → messages
  private userIds = new Map<string, string>(); // "ws/who" → Slack user ID
  private wss = new Map<WsKey, Workspace>();
  readonly needsConnect = new Set<string>();

  async ws(key: WsKey): Promise<Workspace> {
    if (!this.wss.has(key)) {
      const w = await workspaceByKey(key);
      if (!w) throw new Error(`No workspace with key "${key}" in slack-tokens.json`);
      this.wss.set(key, w);
    }
    return this.wss.get(key)!;
  }

  private async userId(key: WsKey, who: Who): Promise<string> {
    const k = `${key}/${who}`;
    if (!this.userIds.has(k)) {
      const ws = await this.ws(key);
      try {
        this.userIds.set(k, (await ws.web.users.lookupByEmail({ email: PEOPLE[who].email })).user!.id!);
      } catch {
        throw new Error(`${ws.teamName}: no Slack user with email ${PEOPLE[who].email} (${PEOPLE[who].name}). Did they join?`);
      }
    }
    return this.userIds.get(k)!;
  }

  // Finds or creates the channel, makes sure the bot and the channel's people are in it.
  private async channel(key: WsKey, c: ChannelDef): Promise<string> {
    const k = `${key}/${c.name}`;
    if (this.channelIds.has(k)) return this.channelIds.get(k)!;
    const ws = await this.ws(key);
    let found = (await ws.listChannels()).find((e) => (c.general ? e.is_general : e.name === c.name));
    if (!found) {
      try {
        found = (await ws.web.conversations.create({ name: c.name, is_private: c.private })).channel;
        console.log(`  created ${channelLabel(key, c.name)} in ${ws.teamName}`);
      } catch (e: any) {
        if (e?.data?.error === "name_taken") throw new Error(`#${c.name} exists in ${ws.teamName} but the bot can't see it: /invite the bot there, or rename it.`);
        throw e;
      }
    }
    if (!found!.is_member && !found!.is_private) await ws.web.conversations.join({ channel: found!.id });
    for (const m of c.members) {
      try {
        await ws.web.conversations.invite({ channel: found!.id, users: await this.userId(key, m) });
        console.log(`  added ${PEOPLE[m].name} to ${channelLabel(key, c.name)}`);
      } catch (e: any) {
        if (!["already_in_channel", "cant_invite_self"].includes(e?.data?.error)) throw e;
      }
    }
    this.channelIds.set(k, found!.id);
    return found!.id;
  }

  // Messages in a conversation, or in one thread (cached; we're the only writer while this runs).
  private async messages(client: WebClient, channel: string, threadTs?: string) {
    const k = `${channel}/${threadTs ?? ""}`;
    if (!this.seen.has(k)) {
      const out: { ts: string; text: string }[] = [];
      let cursor: string | undefined;
      do {
        const r: any = threadTs
          ? await client.conversations.replies({ channel, ts: threadTs, limit: 200, cursor })
          : await client.conversations.history({ channel, limit: 200, cursor });
        for (const m of r.messages ?? []) if (!threadTs || m.ts !== threadTs) out.push({ ts: m.ts, text: decode(m.text ?? "") });
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      this.seen.set(k, out);
    }
    return this.seen.get(k)!;
  }

  // The author's own Slack client, or null (noted for the summary) if they haven't connected this workspace.
  private async author(key: WsKey, who: Who): Promise<WebClient | null> {
    const ws = await this.ws(key);
    const token = userTokens(ws.teamId).find((t) => personIdOfToken(t) === PEOPLE[who].email);
    if (!token) this.needsConnect.add(`${PEOPLE[who].name} → Connect ${ws.teamName}`);
    return token ? new WebClient(token.token) : null;
  }

  async post(s: Post): Promise<"posted" | "exists" | "skipped"> {
    const ws = await this.ws(s.ws);
    const client = await this.author(s.ws, s.as);
    if (!client) return "skipped";
    const channel = await this.channel(s.ws, def(s.ws, s.channel));
    let threadTs: string | undefined;
    if (s.thread) {
      const root = STORY.find((x): x is Post => !isDm(x) && x.id === s.thread);
      if (!root) throw new Error(`timeline: no message with id "${s.thread}"`);
      threadTs = (await this.messages(ws.web, channel)).find((m) => m.text === root.text)?.ts;
      if (!threadTs) throw new Error(`timeline: the thread "${s.thread}" must come before its replies`);
    }
    const seen = await this.messages(ws.web, channel, threadTs);
    if (seen.some((m) => m.text === s.text)) return "exists";
    const r = await client.chat.postMessage({ channel, text: s.text, thread_ts: threadTs, unfurl_links: false });
    seen.push({ ts: r.ts!, text: s.text });
    return "posted";
  }

  async dm(s: Dm): Promise<"posted" | "exists" | "skipped"> {
    const client = await this.author(s.ws, s.as);
    if (!client) return "skipped";
    const users = await Promise.all(s.to.map((p) => this.userId(s.ws, p)));
    const channel = (await client.conversations.open({ users: users.join(",") })).channel!.id!;
    const seen = await this.messages(client, channel);
    if (seen.some((m) => m.text === s.text)) return "exists";
    const r = await client.chat.postMessage({ channel, text: s.text, unfurl_links: false });
    seen.push({ ts: r.ts!, text: s.text });
    return "posted";
  }
}

// ---- main ----

async function main() {
  const has = (f: string) => process.argv.includes(f);
  if (has("--dry-run")) {
    console.log(`${STORY.filter((s) => !isDm(s)).length} channel messages and ${STORY.filter(isDm).length} DMs, in story order:\n`);
    STORY.forEach((s) => console.log(describe(s)));
    console.log("\nDrive: the Company A folder from seedContent.ts (see npm run seed:drive).");
    return;
  }

  await seed((await accountEmail())?.toLowerCase() ?? "", has("--rewrite"));

  console.log("\nSlack:");
  const slack = new SlackSide();
  let posted = 0;
  for (const s of STORY) {
    const result = isDm(s) ? await slack.dm(s) : await slack.post(s);
    if (result === "posted") {
      posted++;
      await sleep(1200); // Slack allows about one message per second per channel
    }
    if (result !== "exists") console.log(`  [${result}] ${describe(s)}`);
  }
  console.log(`\n${posted} posted, ${STORY.length - posted} already there or skipped.`);
  if (slack.needsConnect.size) {
    console.log("Some messages weren't posted: their author hasn't connected. Open /connect in their browser, then run this again:");
    slack.needsConnect.forEach((t) => console.log(`  - ${t}`));
  }
  console.log("To search it: npm run backfill (Slack) and npm run drive:backfill (Drive), or keep the server running with sync on.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.data?.error ? `Slack error: ${e.data.error}` : explain(e));
    process.exit(1);
  });
