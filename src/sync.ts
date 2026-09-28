// Pulls Slack history into Elasticsearch and keeps channel labels correct, for every workspace.
import type { ChannelInfo } from "./acl.js";
import { backfillUserDms } from "./dms.js";
import { bulkUpsert, reaclChannel } from "./indexer.js";
import { conversationMessages, workspaces, type Workspace } from "./slack.js";
import { messageToDoc, type BrainDoc } from "./slackDocs.js";
import { userTokens } from "./tokens.js";

export async function backfillChannel(ws: Workspace, ch: ChannelInfo): Promise<number> {
  const docs = (await conversationMessages(ws.web, ch.id))
    .map((m) => messageToDoc(m, ch, ws.ctx()))
    .filter((d): d is BrainDoc => d !== null);
  await bulkUpsert(docs);
  return docs.length;
}

export async function backfillWorkspace(ws: Workspace): Promise<void> {
  console.log(`${ws.teamName}:`);
  for (const c of await ws.listChannels()) {
    if (!c.is_member) {
      if (c.is_private) continue; // can't read private channels the bot isn't in
      await ws.web.conversations.join({ channel: c.id });
    }
    const n = await backfillChannel(ws, ws.rememberChannel(c));
    console.log(`  #${c.name}${c.is_private ? " (private)" : ""}: ${n} messages`);
  }
  for (const t of userTokens(ws.teamId)) {
    const n = await backfillUserDms(ws, t);
    console.log(`  DMs via ${t.email ?? t.userId}: ${n} messages`);
  }
}

export async function backfillAll(): Promise<void> {
  for (const ws of await workspaces()) await backfillWorkspace(ws);
}

// Slack has no dependable event for "channel became private/public", so compare periodically.
// Also joins and indexes any public channel the bot missed.
export async function reconcileChannels(ws: Workspace): Promise<void> {
  const before = new Map(ws.cachedChannels().map((c) => [c.id, c]));
  for (const c of await ws.listChannels()) {
    const ch = ws.rememberChannel(c);
    const old = before.get(ch.id);
    if (old && (old.is_private !== ch.is_private || old.name !== ch.name)) {
      console.log(`reconcile: #${ch.name} changed (private=${ch.is_private}), relabelling`);
      await reaclChannel(ws.teamId, ch);
    }
    if (!c.is_member && !c.is_private) {
      await ws.web.conversations.join({ channel: ch.id });
      await backfillChannel(ws, ch);
    }
  }
}
