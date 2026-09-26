// Live sync: Slack events (over Socket Mode) → Elasticsearch / permission cache.
import type { App } from "@slack/bolt";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { deleteMessage, reaclChannel, upsert } from "./indexer.js";
import { invalidate } from "./principals.js";
import { docCtx, getChannel, getWorkspace, rememberChannel, web } from "./slack.js";
import { classifyMessageEvent, messageToDoc } from "./slackDocs.js";
import { backfillChannel } from "./sync.js";

export const status = { eventsReceived: 0, lastEvent: null as null | { type: string; at: string } };

export function registerEvents(app: App) {
  // Record every event (and optionally save it as a test fixture).
  app.use(async ({ body, next }) => {
    const event = (body as any).event;
    if (event) {
      const type = event.subtype ? `${event.type}.${event.subtype}` : event.type;
      status.eventsReceived++;
      status.lastEvent = { type, at: new Date().toISOString() };
      if (config.captureEvents) {
        mkdirSync("fixtures/captured", { recursive: true });
        writeFileSync(`fixtures/captured/${type}-${Date.now()}.json`, JSON.stringify(event, null, 2));
      }
    }
    await next();
  });

  app.event("message", async ({ event }) => {
    const e = event as any;
    const action = classifyMessageEvent(e);
    if (action.action === "skip") return;
    if (action.action === "delete") {
      await deleteMessage(e.channel, action.ts);
      console.log(`deleted ${e.channel}:${action.ts}`);
      return;
    }
    const doc = messageToDoc(action.msg, await getChannel(e.channel), await docCtx());
    if (doc) {
      await upsert(doc);
      console.log(`indexed ${doc.doc_id} in #${doc.channel_name}`);
    }
  });

  // Membership changes only affect the user's principals, not the index.
  app.event("member_joined_channel", async ({ event }) => {
    invalidate(event.user);
    const { botUserId } = await getWorkspace();
    if (event.user === botUserId) {
      const n = await backfillChannel(await getChannel(event.channel, true));
      console.log(`bot added to ${event.channel}, indexed ${n} messages`);
    }
  });
  app.event("member_left_channel", async ({ event }) => {
    invalidate(event.user);
    console.log(`${event.user} left ${event.channel}: access refreshed`);
  });

  app.event("channel_created", async ({ event }) => {
    rememberChannel({ ...event.channel, is_private: false });
    await web.conversations.join({ channel: event.channel.id }); // triggers member_joined_channel → backfill
  });

  const onRename = async ({ event }: any) => {
    await reaclChannel(await getChannel(event.channel.id, true));
  };
  app.event("channel_rename", onRename);
  app.event("group_rename", onRename);

  // Archived channels keep their docs and labels; nothing to do.
  for (const e of ["channel_archive", "channel_unarchive", "group_archive", "group_unarchive"] as const) {
    app.event(e, async () => {});
  }
}
