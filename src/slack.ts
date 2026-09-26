import { WebClient } from "@slack/web-api";
import { requireEnv } from "./config.js";
import type { ChannelInfo } from "./acl.js";
import type { Ctx } from "./slackDocs.js";

export const web = new WebClient(requireEnv("SLACK_BOT_TOKEN"));

type Workspace = { teamId: string; teamUrl: string; botUserId: string };
let workspace: Workspace | undefined;

export async function getWorkspace(): Promise<Workspace> {
  if (!workspace) {
    const a = await web.auth.test();
    workspace = { teamId: a.team_id!, teamUrl: a.url!, botUserId: a.user_id! };
  }
  return workspace;
}

// ---- channels ----
const channels = new Map<string, ChannelInfo>();

export function rememberChannel(c: any): ChannelInfo {
  const info = { id: c.id, name: c.name, is_private: !!c.is_private };
  channels.set(info.id, info);
  return info;
}

export async function getChannel(id: string, fresh = false): Promise<ChannelInfo> {
  if (!fresh && channels.has(id)) return channels.get(id)!;
  const r = await web.conversations.info({ channel: id });
  return rememberChannel(r.channel);
}

export function cachedChannel(id: string) {
  return channels.get(id);
}

// All channels the bot can see (public ones, plus private ones it is in).
export async function listChannels(): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await web.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    out.push(...(r.channels ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  out.forEach(rememberChannel);
  return out;
}

// ---- users ----
const userNames = new Map<string, string>();

export async function listUsers() {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await web.users.list({ limit: 200, cursor });
    out.push(...(r.members ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  for (const u of out) userNames.set(u.id, displayName(u));
  return out;
}

export const displayName = (u: any) =>
  u.profile?.display_name || u.real_name || u.name || u.id;

export const isHuman = (u: any) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT";

export async function docCtx(): Promise<Ctx> {
  const ws = await getWorkspace();
  if (userNames.size === 0) await listUsers();
  return { teamId: ws.teamId, teamUrl: ws.teamUrl, userName: (id) => userNames.get(id) };
}

// Full message history of a channel, including thread replies.
export async function channelMessages(channelId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await web.conversations.history({ channel: channelId, limit: 200, cursor });
    for (const m of r.messages ?? []) {
      out.push(m);
      if (m.reply_count && m.thread_ts) out.push(...(await threadReplies(channelId, m.thread_ts)));
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

async function threadReplies(channelId: string, threadTs: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await web.conversations.replies({ channel: channelId, ts: threadTs, limit: 200, cursor });
    out.push(...(r.messages ?? []).filter((m: any) => m.ts !== threadTs)); // parent is already in history
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

export function cachedChannels(): ChannelInfo[] {
  return [...channels.values()].map((c) => ({ ...c }));
}
