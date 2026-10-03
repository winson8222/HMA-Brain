// npm run seed:story -- --day N [--dry-run] [--live] [--any-date]
// Plays one day of the demo story (timeline.ts) into Slack and Drive. Steps whose time has passed are done now,
// a few seconds apart; with --live the run then waits and does each later step at its time, so Slack's
// timestamps match the story. Without --live it stops at the first future step (run again later to continue).
// Safe to re-run: a message already in its channel or thread is skipped, and Drive steps are recorded in
// story-state.json. Elasticsearch picks everything up through the normal sync (or npm run backfill / drive:poll).
//   --dry-run    print the day's steps and change nothing
//   --any-date   run a day on a date other than its planned one (timestamps won't match the story)
//   --fast       post overdue steps back to back instead of a few seconds apart
import { WebClient } from "@slack/web-api";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { requireEnv } from "../config.js";
import { accountEmail } from "../connectors/drive/client.js";
import { personIdOfToken } from "../dms.js";
import { workspaceByKey, type Workspace } from "../slack.js";
import { userTokens } from "../tokens.js";
import { CHANNELS, DAYS, STORY_DAYS, type ChannelDef, type Dm, type DriveStep, type Post, type Step, type Who, type WsKey } from "./timeline.js";

const PEOPLE: Record<Who, { name: string; emoji: string; email: string }> = {
  carol: { name: "Carol", emoji: ":female-detective:", email: requireEnv("CAROL_EMAIL").toLowerCase() },
  alice: { name: "Alice", emoji: ":woman-technologist:", email: requireEnv("ALICE_EMAIL").toLowerCase() },
  bob: { name: "Bob", emoji: ":man-technologist:", email: requireEnv("BOB_EMAIL").toLowerCase() },
  dave: { name: "Dave", emoji: ":construction_worker:", email: requireEnv("DAVE_EMAIL").toLowerCase() },
};
const WS_NAMES: Record<WsKey, string> = { main: "Company A", vendors: "Vendors" };

const isDrive = (s: Step): s is DriveStep => "drive" in s;
const isDm = (s: Step): s is Dm => "to" in s;

// ---- time ----

const due = (day: number, at: string) => new Date(`${STORY_DAYS[day]}T${at}:00+08:00`);
const todaySgt = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
const clock = (d = new Date()) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// ---- state (Drive steps done) ----

const STATE_FILE = "story-state.json";
const state: { done: Record<string, string> } = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { done: {} };
const markDone = (id: string) => {
  state.done[id] = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
};

// ---- printing ----

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
  if (isDrive(s)) return `Drive        ${s.drive}`;
  const where = isDm(s)
    ? `DM ${[s.as, ...s.to].map((p) => PEOPLE[p].name).join(", ")}`
    : `${channelLabel(s.ws, s.channel)}${s.thread ? " ↳" : ""}`;
  return `${WS_NAMES[s.ws].padEnd(9)} ${where.padEnd(26)} ${PEOPLE[s.as].name.padEnd(6)} ${s.text}`;
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

  async post(s: Post): Promise<"posted" | "exists"> {
    const ws = await this.ws(s.ws);
    const channel = await this.channel(s.ws, def(s.ws, s.channel));
    let threadTs: string | undefined;
    if (s.thread) {
      const root = Object.values(DAYS).flat().find((x): x is Post => !isDrive(x) && !isDm(x) && x.id === s.thread);
      if (!root) throw new Error(`timeline: no message with id "${s.thread}"`);
      threadTs = (await this.messages(ws.web, channel)).find((m) => m.text === root.text)?.ts;
      if (!threadTs) throw new Error(`The thread "${s.thread}" hasn't been posted yet (${root.at} on its day)`);
    }
    const seen = await this.messages(ws.web, channel, threadTs);
    if (seen.some((m) => m.text === s.text)) return "exists";
    const r = await ws.web.chat.postMessage({
      channel,
      text: s.text,
      thread_ts: threadTs,
      username: PEOPLE[s.as].name,
      icon_emoji: PEOPLE[s.as].emoji,
      unfurl_links: false,
    });
    seen.push({ ts: r.ts!, text: s.text });
    return "posted";
  }

  async dm(s: Dm): Promise<"posted" | "exists" | "skipped"> {
    const ws = await this.ws(s.ws);
    const token = userTokens(ws.teamId).find((t) => personIdOfToken(t) === PEOPLE[s.as].email);
    if (!token) {
      this.needsConnect.add(`${PEOPLE[s.as].name} → Connect ${ws.teamName}`);
      return "skipped";
    }
    const client = new WebClient(token.token);
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
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const day = Number(args[args.indexOf("--day") + 1]);
  if (!has("--day") || !DAYS[day]) throw new Error(`Usage: npm run seed:story -- --day ${Object.keys(DAYS).join("|")} [--dry-run] [--live]`);
  const steps = [...DAYS[day]].sort((a, b) => a.at.localeCompare(b.at));
  const date = STORY_DAYS[day];
  const weekday = due(day, "12:00").toLocaleDateString("en-GB", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short" });

  if (has("--dry-run")) {
    const n = (p: (s: Step) => boolean) => steps.filter(p).length;
    console.log(`Day ${day}, ${weekday} (${date}), times in SGT: ${n((s) => !isDrive(s) && !isDm(s))} channel messages, ${n(isDm)} DMs, ${n(isDrive)} Drive steps\n`);
    for (const s of steps) console.log(`${s.at}  ${describe(s)}`);
    return;
  }
  if (date !== todaySgt() && !has("--any-date"))
    throw new Error(`Day ${day} is planned for ${date}, and today is ${todaySgt()}. Slack stamps messages when they're posted; pass --any-date to run it anyway.`);

  const slack = new SlackSide();
  const admin = (await accountEmail())?.toLowerCase() ?? "";
  let catchingUp = false;
  for (const [i, s] of steps.entries()) {
    const when = due(day, s.at);
    if (when > new Date()) {
      if (!has("--live")) {
        console.log(`\n${steps.length - i} steps are later today (next at ${s.at}). Run again with --live to post them at their times.`);
        break;
      }
      const at = new Date(when.getTime() + (isDrive(s) ? 0 : between(0, 40_000)));
      console.log(`  … waiting until ${clock(at)}`);
      await sleep(at.getTime() - Date.now());
      catchingUp = false;
    } else if (catchingUp && !has("--fast")) {
      await sleep(between(8_000, 20_000)); // overdue steps go out a few seconds apart, not all in one second
    }

    let result: string;
    if (isDrive(s)) {
      if (state.done[s.id]) result = "done before";
      else {
        await s.run(admin);
        markDone(s.id);
        result = "done";
      }
    } else result = isDm(s) ? await slack.dm(s) : await slack.post(s);
    catchingUp = result !== "exists" && result !== "done before";
    console.log(`${clock()}  [${s.at} ${result}] ${describe(s)}`);
  }

  if (slack.needsConnect.size) {
    console.log("\nSome DMs weren't posted: the sender hasn't connected. Open /connect in their browser, then run this day again:");
    slack.needsConnect.forEach((t) => console.log(`  - ${t}`));
  }
  console.log("\nTo search it: npm run backfill (Slack) and npm run drive:poll (Drive), or keep the server running with sync on.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.data?.error ? `Slack error: ${e.data.error}` : (e?.message ?? e));
    process.exit(1);
  });
