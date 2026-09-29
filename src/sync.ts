// Pulls Slack history into Elasticsearch and keeps channel labels correct.
import type { ChannelInfo } from "./acl.js";
import { bulkUpsert, reaclChannel } from "./indexer.js";
import { withVectors } from "./embeddings.js";
import { cachedChannels, channelMessages, docCtx, listChannels, rememberChannel, web } from "./slack.js";
import { messageToDoc, type BrainDoc } from "./slackDocs.js";

export async function backfillChannel(ch: ChannelInfo): Promise<number> {
  const ctx = await docCtx();
  const docs = (await channelMessages(ch.id))
    .map((m) => messageToDoc(m, ch, ctx))
    .filter((d): d is BrainDoc => d !== null);
  await bulkUpsert(await withVectors(docs));
  return docs.length;
}

export async function backfillAll(): Promise<void> {
  for (const c of await listChannels()) {
    if (!c.is_member) {
      if (c.is_private) continue; // can't read private channels the bot isn't in
      await web.conversations.join({ channel: c.id });
    }
    const n = await backfillChannel(rememberChannel(c));
    console.log(`  #${c.name}${c.is_private ? " (private)" : ""}: ${n} messages`);
  }
}

// Slack has no dependable event for "channel became private/public", so compare periodically.
// Also joins and indexes any public channel the bot missed.
export async function reconcileChannels(): Promise<void> {
  const before = new Map(cachedChannels().map((c) => [c.id, c]));
  for (const c of await listChannels()) {
    const ch = rememberChannel(c);
    const old = before.get(ch.id);
    if (old && (old.is_private !== ch.is_private || old.name !== ch.name)) {
      console.log(`reconcile: #${ch.name} changed (private=${ch.is_private}), relabelling`);
      await reaclChannel(ch);
    }
    if (!c.is_member && !c.is_private) {
      await web.conversations.join({ channel: ch.id });
      await backfillChannel(ch);
    }
  }
}
