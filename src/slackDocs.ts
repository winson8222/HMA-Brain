// Pure functions that turn Slack messages/events into Elasticsearch docs.
// Used by backfill, live events and verify, so every path indexes the same way.
import { aclForChannel, type ChannelInfo, type ConvKind } from "./acl.js";

export type BrainDoc = {
  doc_id: string;
  source: "slack";
  team_id: string;
  team_name: string;
  channel_id: string;
  channel_name: string;
  kind: ConvKind;
  is_private: boolean;
  user_id: string | null;
  user_name: string;
  text: string;
  thread_ts: string | null;
  ts: string; // ISO date
  slack_ts: string;
  permalink: string;
  acl_container: string[];
};

export type Ctx = {
  teamId: string;
  teamName: string;
  teamUrl: string; // e.g. https://companyademo.slack.com/
  userName: (id: string) => string | undefined;
};

// Message subtypes that carry real content. Everything else (joins, topic changes...) is skipped.
const CONTENT_SUBTYPES = new Set([undefined, "bot_message", "file_share", "thread_broadcast", "me_message"]);

export const docId = (teamId: string, channelId: string, ts: string) => `slack:${teamId}:${channelId}:${ts}`;

export function messageToDoc(msg: any, channel: ChannelInfo, ctx: Ctx): BrainDoc | null {
  if (!msg?.ts || !CONTENT_SUBTYPES.has(msg.subtype)) return null;

  const fileNames = (msg.files ?? []).map((f: any) => f.name ?? f.title).filter(Boolean);
  const text = [msg.text ?? "", ...fileNames].filter(Boolean).join("\n").trim();
  if (!text) return null;

  const threadTs = msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : null;
  let permalink = `${ctx.teamUrl}archives/${channel.id}/p${msg.ts.replace(".", "")}`;
  if (threadTs) permalink += `?thread_ts=${threadTs}&cid=${channel.id}`;

  return {
    doc_id: docId(ctx.teamId, channel.id, msg.ts),
    source: "slack",
    team_id: ctx.teamId,
    team_name: ctx.teamName,
    channel_id: channel.id,
    channel_name: channel.name,
    kind: channel.kind,
    is_private: channel.is_private,
    user_id: msg.user ?? null,
    user_name: msg.username ?? (msg.user && ctx.userName(msg.user)) ?? msg.user ?? "unknown",
    text,
    thread_ts: threadTs,
    ts: new Date(Number(msg.ts) * 1000).toISOString(),
    slack_ts: msg.ts,
    permalink,
    acl_container: aclForChannel(ctx.teamId, channel),
  };
}

export type MessageAction =
  | { action: "upsert"; msg: any }
  | { action: "delete"; ts: string }
  | { action: "skip" };

// Decide what a live `message` event means for the index.
export function classifyMessageEvent(event: any): MessageAction {
  switch (event.subtype) {
    case "message_deleted":
      return { action: "delete", ts: event.deleted_ts };
    case "message_changed":
      // A thread parent deleted while it has replies becomes a tombstone.
      if (event.message?.subtype === "tombstone") return { action: "delete", ts: event.message.ts };
      return { action: "upsert", msg: event.message };
    default:
      return CONTENT_SUBTYPES.has(event.subtype) ? { action: "upsert", msg: event } : { action: "skip" };
  }
}

// "DM: Alice ↔ Carol" / "Group DM: Alice, Bob, Carol"
export function dmName(kind: ConvKind, names: string[]): string {
  return kind === "dm" ? `DM: ${names.join(" ↔ ")}` : `Group DM: ${names.join(", ")}`;
}
