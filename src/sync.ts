// Pulls Slack history into Elasticsearch and keeps channel labels correct, for every workspace.
import { aclForChannel, type ChannelInfo } from "./acl.js";
import { access } from "./audit/events.js";
import { recordBackfill, recordItemChange } from "./audit/record.js";
import { backfillUserDms } from "./dms.js";
import { bulkUpsert, reaclChannel } from "./indexer.js";
import { withVectors } from "./embeddings.js";
import { conversationMessages, workspaces, type Workspace } from "./slack.js";
import { messageToDoc, type BrainDoc } from "./slackDocs.js";
import { userTokens } from "./tokens.js";

export const channelItemId = (teamId: string, channelId: string) => `slack:${teamId}:${channelId}`;

// A conversation's name for the audit log. DMs stay anonymous, like withheld DMs in search records.
export const conversationTitle = (ch: Pick<ChannelInfo, "kind" | "name">) => (ch.kind === "channel" ? `#${ch.name}` : ch.kind === "dm" ? "a DM" : "a group DM");

export async function backfillChannel(ws: Workspace, ch: ChannelInfo): Promise<number> {
  const docs = (await conversationMessages(ws.web, ch.id))
    .map((m) => messageToDoc(m, ch, ws.ctx()))
    .filter((d): d is BrainDoc => d !== null);
  await bulkUpsert(await withVectors(docs));
  return docs.length;
}

export async function backfillWorkspace(ws: Workspace): Promise<number> {
  console.log(`${ws.teamName}:`);
  let total = 0;
  for (const c of await ws.listChannels()) {
    if (!c.is_member) {
      if (c.is_private) continue; // can't read private channels the bot isn't in
      await ws.web.conversations.join({ channel: c.id });
    }
    const n = await backfillChannel(ws, ws.rememberChannel(c));
    total += n;
    console.log(`  #${c.name}${c.is_private ? " (private)" : ""}: ${n} messages`);
  }
  for (const t of userTokens(ws.teamId)) {
    const n = await backfillUserDms(ws, t);
    total += n;
    console.log(`  DMs via ${t.email ?? t.userId}: ${n} messages`);
  }
  return total;
}

export async function backfillAll(): Promise<void> {
  for (const ws of await workspaces()) {
    const n = await backfillWorkspace(ws);
    await recordBackfill("slack", "backfill", n, `Slack ${ws.teamName}: ${n} messages`);
  }
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
      const was = { title: `#${old.name}`, path: ws.teamName, access: access(aclForChannel(ws.teamId, old)), modified_at: null };
      await recordItemChange("slack", "reconcile", channelItemId(ws.teamId, ch.id), was, {
        ...was,
        title: `#${ch.name}`,
        access: access(aclForChannel(ws.teamId, ch)),
      });
    }
    if (!c.is_member && !c.is_private) {
      await ws.web.conversations.join({ channel: ch.id });
      const n = await backfillChannel(ws, ch);
      await recordBackfill("slack", "reconcile", n, `Slack ${ws.teamName} #${ch.name}: joined, ${n} messages`);
    }
  }
}
