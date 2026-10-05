// One Workspace object per connected Slack workspace: its bot client plus channel and user caches.
import { WebClient } from "@slack/web-api";
import type { ChannelInfo } from "./acl.js";
import type { Ctx } from "./slackDocs.js";
import { loadTokens, type WorkspaceCreds } from "./tokens.js";

export const displayName = (u: any) => u.profile?.display_name || u.real_name || u.name || u.id;
// Slack's own system accounts: Slackbot, and "Slack" (trial and billing notices).
const SYSTEM_USERS = new Set(["USLACKBOT", "USLACK"]);
export const isHuman = (u: any) => !u.deleted && !u.is_bot && !SYSTEM_USERS.has(u.id);
export const emailOf = (u: any): string | undefined => u?.profile?.email?.toLowerCase();

export class Workspace {
  readonly web: WebClient;
  teamId = "";
  teamName = "";
  teamUrl = "";
  botUserId = "";
  private channels = new Map<string, ChannelInfo>();
  private users = new Map<string, any>();

  constructor(readonly creds: WorkspaceCreds) {
    this.web = new WebClient(creds.botToken);
  }

  get key() {
    return this.creds.key;
  }

  async init() {
    const a = await this.web.auth.test();
    this.teamId = a.team_id!;
    this.teamName = a.team!;
    this.teamUrl = a.url!;
    this.botUserId = a.user_id!;
    await this.listUsers();
    return this;
  }

  // ---- people ----

  async listUsers(): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.web.users.list({ limit: 200, cursor });
      out.push(...(r.members ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    this.users = new Map(out.map((u) => [u.id, u]));
    return out;
  }

  async getUser(id: string): Promise<any> {
    if (!this.users.has(id)) {
      const r = await this.web.users.info({ user: id });
      this.users.set(id, r.user);
    }
    return this.users.get(id);
  }

  cachedUsers(): any[] {
    return [...this.users.values()];
  }

  // The same person across workspaces: their email, or a workspace-scoped ID if there is none.
  personIdOf(u: any): string {
    return emailOf(u) ?? `${this.teamId}:${u.id}`;
  }

  userName = (id: string) => (this.users.has(id) ? displayName(this.users.get(id)) : undefined);

  ctx(): Ctx {
    return { teamId: this.teamId, teamName: this.teamName, teamUrl: this.teamUrl, userName: this.userName };
  }

  // ---- channels ----

  rememberChannel(c: any): ChannelInfo {
    const info: ChannelInfo = { id: c.id, name: c.name, is_private: !!c.is_private, kind: "channel" };
    this.channels.set(info.id, info);
    return info;
  }

  remember(info: ChannelInfo): ChannelInfo {
    this.channels.set(info.id, info);
    return info;
  }

  cached(id: string): ChannelInfo | undefined {
    return this.channels.get(id);
  }

  cachedChannels(): ChannelInfo[] {
    return [...this.channels.values()].filter((c) => c.kind === "channel").map((c) => ({ ...c }));
  }

  async getChannel(id: string, fresh = false): Promise<ChannelInfo> {
    if (!fresh && this.channels.has(id)) return this.channels.get(id)!;
    const r = await this.web.conversations.info({ channel: id });
    return this.rememberChannel(r.channel);
  }

  // All channels the bot can see (public ones, plus private ones it is in).
  async listChannels(): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.web.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      out.push(...(r.channels ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    out.forEach((c) => this.rememberChannel(c));
    return out;
  }
}

// Full message history of a conversation, including thread replies.
// `client` is the bot for channels, or a person's user client for their DMs.
export async function conversationMessages(client: WebClient, channelId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await client.conversations.history({ channel: channelId, limit: 200, cursor });
    for (const m of r.messages ?? []) {
      out.push(m);
      if (m.reply_count && m.thread_ts) out.push(...(await threadReplies(client, channelId, m.thread_ts)));
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

async function threadReplies(client: WebClient, channelId: string, threadTs: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 200, cursor });
    out.push(...(r.messages ?? []).filter((m: any) => m.ts !== threadTs)); // parent is already in history
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

// ---- registry ----

let registry: Promise<Workspace[]> | undefined;

export function workspaces(): Promise<Workspace[]> {
  registry ??= Promise.all(loadTokens().workspaces.map((c) => new Workspace(c).init()));
  return registry;
}

export async function workspaceByTeam(teamId: string): Promise<Workspace> {
  const ws = (await workspaces()).find((w) => w.teamId === teamId);
  if (!ws) throw new Error(`Unknown Slack workspace ${teamId}`);
  return ws;
}

export async function workspaceByKey(key: string): Promise<Workspace | undefined> {
  return (await workspaces()).find((w) => w.key === key);
}
