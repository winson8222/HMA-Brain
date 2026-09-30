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
import { backfillChannel } from "./sync.js";

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
    const action = classifyMessageEvent(e);
    if (action.action === "skip") return;
    if (action.action === "delete") {
      await deleteMessage(ws.teamId, e.channel, action.ts);
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
    }
  });

  // Membership changes only affect the person's principals, not the index.
  app.event("member_joined_channel", async ({ event }) => {
    await invalidateAccount(ws, event.user);
    if (event.user === ws.botUserId) {
      const n = await backfillChannel(ws, await ws.getChannel(event.channel, true));
      console.log(`bot added to ${event.channel} in ${ws.teamName}, indexed ${n} messages`);
    }
  });
  app.event("member_left_channel", async ({ event }) => {
    await invalidateAccount(ws, event.user);
    console.log(`${event.user} left ${event.channel} in ${ws.teamName}: access refreshed`);
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
