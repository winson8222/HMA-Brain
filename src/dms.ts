// DMs and group DMs. The bot can't read them; they are read with the user token of a
// participant who clicked Connect. A DM's permission label is its participants, which
// Slack never changes, so it needs no live re-check.
import { WebClient } from "@slack/web-api";
import { personPrincipal, type ChannelInfo, type ConvKind } from "./acl.js";
import { es, INDEX } from "./es.js";
import { bulkUpsert, deleteConversation } from "./indexer.js";
import { conversationMessages, displayName, isHuman, type Workspace } from "./slack.js";
import { dmName, messageToDoc, type BrainDoc } from "./slackDocs.js";
import { userTokens, type UserToken } from "./tokens.js";

export const userClient = (t: UserToken) => new WebClient(t.token);

export const personIdOfToken = (t: UserToken) => t.email?.toLowerCase() ?? `${t.teamId}:${t.userId}`;

async function buildDmInfo(ws: Workspace, id: string, kind: ConvKind, memberIds: string[]): Promise<ChannelInfo | undefined> {
  const unique = [...new Set(memberIds)];
  const users = (await Promise.all(unique.map((m) => ws.getUser(m).catch(() => undefined)))).filter(
    (u) => u && isHuman(u),
  );
  // Skip DMs with a bot or Slack itself, and notes-to-self: not conversations between people.
  if (users.length < 2) return undefined;
  return ws.remember({
    id,
    kind,
    is_private: true,
    name: dmName(kind, users.map(displayName)),
    participants: users.map((u) => ws.personIdOf(u)),
  });
}

async function infoWith(ws: Workspace, client: WebClient, ownerId: string, c: any): Promise<ChannelInfo | undefined> {
  if (c.is_im) return buildDmInfo(ws, c.id, "dm", [ownerId, c.user]);
  if (c.is_mpim) {
    const r = await client.conversations.members({ channel: c.id, limit: 50 });
    return buildDmInfo(ws, c.id, "group_dm", r.members ?? []);
  }
  return undefined;
}

// Resolve a DM seen in a live event, using any connected participant's token.
export async function dmInfo(ws: Workspace, convId: string, preferUserId?: string): Promise<ChannelInfo | undefined> {
  const cached = ws.cached(convId);
  if (cached) return cached;
  const first = (t: UserToken) => (t.userId === preferUserId ? 0 : 1);
  const toks = userTokens(ws.teamId).sort((a, b) => first(a) - first(b));
  for (const t of toks) {
    try {
      const client = userClient(t);
      const r = await client.conversations.info({ channel: convId });
      return await infoWith(ws, client, t.userId, r.channel);
    } catch {
      // not this person's conversation; try the next connected person
    }
  }
  return undefined;
}

// Every DM and group DM one connected person is in (with the client that can read it).
export async function userDmConversations(ws: Workspace, t: UserToken): Promise<{ info: ChannelInfo; client: WebClient }[]> {
  const client = userClient(t);
  const convs: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await client.conversations.list({ types: "im,mpim", limit: 200, cursor });
    convs.push(...(r.channels ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const out: { info: ChannelInfo; client: WebClient }[] = [];
  for (const c of convs) {
    const info = await infoWith(ws, client, t.userId, c);
    if (info) out.push({ info, client });
  }
  return out;
}

// Index every DM and group DM one connected person is in.
export async function backfillUserDms(ws: Workspace, t: UserToken): Promise<number> {
  let n = 0;
  for (const { info, client } of await userDmConversations(ws, t)) {
    const docs = (await conversationMessages(client, info.id))
      .map((m) => messageToDoc(m, info, ws.ctx()))
      .filter((d): d is BrainDoc => d !== null);
    await bulkUpsert(docs);
    n += docs.length;
  }
  return n;
}

// After someone disconnects: drop their DMs from the index unless another participant
// is still connected (so content only stays while a participant still allows it).
export async function cleanupAfterDisconnect(ws: Workspace, personId: string): Promise<number> {
  const r = await es.search<BrainDoc>({
    index: INDEX,
    size: 0,
    query: {
      bool: {
        filter: [
          { term: { team_id: ws.teamId } },
          { terms: { kind: ["dm", "group_dm"] } },
          { term: { acl_container: personPrincipal(personId) } },
        ],
      },
    },
    aggs: {
      convs: {
        terms: { field: "channel_id", size: 1000 },
        aggs: { sample: { top_hits: { size: 1, _source: ["acl_container"] } } },
      },
    },
  });
  const stillConnected = new Set(userTokens(ws.teamId).map((t) => personPrincipal(personIdOfToken(t))));
  let removed = 0;
  for (const b of (r.aggregations?.convs as any)?.buckets ?? []) {
    const acl: string[] = b.sample.hits.hits[0]._source.acl_container;
    const others = acl.filter((p) => p !== personPrincipal(personId));
    if (!others.some((p) => stillConnected.has(p))) {
      await deleteConversation(ws.teamId, b.key);
      removed++;
    }
  }
  return removed;
}
