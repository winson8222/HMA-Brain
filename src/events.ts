// Live sync: Slack events (over Socket Mode) → Elasticsearch / permission cache.
// One Bolt app per workspace; each is registered with that workspace's Workspace object.
import type { App } from "@slack/bolt";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { dmInfo } from "./dms.js";
import { withVectors } from "./embeddings.js";
import { deleteMessage, reaclChannel, upsert } from "./indexer.js";
import { invalidateAccount } from "./people.js";
import type { Workspace } from "./slack.js";
import { classifyMessageEvent, messageToDoc } from "./slackDocs.js";
import { recordAudit, recordBackfill } from "./audit/record.js";
import { backfillChannel, channelItemId, conversationTitle } from "./sync.js";

const slackTime = (ts?: string) => (ts ? new Date(Number(ts) * 1000).toISOString() : null);

export const status = { eventsReceived: 0, lastEvent: null as null | { type: string; at: string } };

export function registerEvents(app: App, ws: Workspace) {
  // Record every event (and optionally save it as a test fixture).
  app.use(async ({ body, next }) => {
    const event = (body as any).event;
    if (event) {
      const type = event.subtype ? `${event.type}.${event.subtype}` : event.type;
      status.eventsReceived++;
      status.lastEvent = { type: `${ws.teamName}: ${type}`, at: new Date().toISOString() };
      if (config.captureEvents) {
        mkdirSync("fixtures/captured", { recursive: true });
        writeFileSync(`fixtures/captured/${type}-${Date.now()}.json`, JSON.stringify(event, null, 2));
      }
    }
    await next();
  });

  app.event("message", async ({ event, body }) => {
    const e = event as any;
    const detected = new Date().toISOString(); // Slack pushed it: detection is seconds after the change
    const action = classifyMessageEvent(e);
    if (action.action === "skip") return;
    if (action.action === "delete") {
      await deleteMessage(ws.teamId, e.channel, action.ts);
      const ch = await ws.getChannel(e.channel).catch(() => null);
      await recordAudit({
        kind: "content_change",
        actor: "system",
        via: "event",
        source: "slack",
        change: "deleted",
        item: { id: `slack:${ws.teamId}:${e.channel}:${action.ts}`, source: "slack", title: `message in ${ch ? conversationTitle(ch) : e.channel}`, path: ws.teamName },
        changed_at: slackTime(e.event_ts ?? e.ts),
        detected_at: detected,
        indexed_at: new Date().toISOString(),
      });
      console.log(`deleted ${ws.teamName} ${e.channel}:${action.ts}`);
      return;
    }

    // DMs arrive through a connected person's subscription; read them with a participant's token.
    const isDm = e.channel_type === "im" || e.channel_type === "mpim";
    const authorizedUser = (body as any).authorizations?.find((a: any) => !a.is_bot)?.user_id;
    const ch = isDm ? await dmInfo(ws, e.channel, authorizedUser) : await ws.getChannel(e.channel);
    if (!ch) return; // e.g. a DM with a bot

    const doc = messageToDoc(action.msg, ch, ws.ctx());
    if (doc) {
      await upsert((await withVectors([doc]))[0]);
      console.log(`indexed ${doc.doc_id} in ${ch.kind === "channel" ? "#" : ""}${doc.channel_name}`);
      const edited = e.subtype === "message_changed";
      await recordAudit({
        kind: "content_change",
        actor: "system",
        via: "event",
        source: "slack",
        change: edited ? "updated" : "added",
        item: { id: doc.doc_id, source: "slack", title: `message in ${conversationTitle(ch)}`, path: ws.teamName },
        changed_at: slackTime(edited ? (action.msg.edited?.ts ?? e.event_ts) : action.msg.ts),
        detected_at: detected,
        indexed_at: new Date().toISOString(),
      });
    }
  });

  // Membership changes only affect the person's principals, not the index.
  // Who is in a channel decides who can see it: each join or leave is a permission change on the channel.
  const membership = async (user: string, channel: string, joined: boolean, eventTs?: string) => {
    const ch = await ws.getChannel(channel).catch(() => null);
    const who = ws.ctx().userName(user) ?? user;
    await recordAudit({
      kind: "permission_change",
      actor: "system",
      via: "event",
      source: "slack",
      item: { id: channelItemId(ws.teamId, channel), source: "slack", title: ch ? conversationTitle(ch) : channel, path: ws.teamName },
      summary: `${who} ${joined ? "joined (gained access)" : "left (lost access)"}`,
      changed_at: slackTime(eventTs),
      detected_at: new Date().toISOString(),
    });
  };
  app.event("member_joined_channel", async ({ event }) => {
    await invalidateAccount(ws, event.user);
    if (event.user === ws.botUserId) {
      const ch = await ws.getChannel(event.channel, true);
      const n = await backfillChannel(ws, ch);
      console.log(`bot added to ${event.channel} in ${ws.teamName}, indexed ${n} messages`);
      await recordBackfill("slack", "event", n, `Slack ${ws.teamName} ${conversationTitle(ch)}: bot added, ${n} messages`);
    } else await membership(event.user, event.channel, true, (event as any).event_ts);
  });
  app.event("member_left_channel", async ({ event }) => {
    await invalidateAccount(ws, event.user);
    console.log(`${event.user} left ${event.channel} in ${ws.teamName}: access refreshed`);
    await membership(event.user, event.channel, false, (event as any).event_ts);
  });

  app.event("channel_created", async ({ event }) => {
    ws.rememberChannel({ ...event.channel, is_private: false });
    await ws.web.conversations.join({ channel: event.channel.id }); // triggers member_joined_channel → backfill
  });

  const onRename = async ({ event }: any) => {
    await reaclChannel(ws.teamId, await ws.getChannel(event.channel.id, true));
  };
  app.event("channel_rename", onRename);
  app.event("group_rename", onRename);

  // Archived channels keep their docs and labels; nothing to do.
  for (const e of ["channel_archive", "channel_unarchive", "group_archive", "group_unarchive"] as const) {
    app.event(e, async () => {});
  }
}
