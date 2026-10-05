import { aclForChannel, type ChannelInfo } from "./acl.js";
import { es, INDEX } from "./es.js";
import { docId, type BrainDoc } from "./slackDocs.js";

const inConversation = (teamId: string, channelId: string) => [
  { term: { team_id: teamId } },
  { term: { channel_id: channelId } },
];

export async function upsert(doc: BrainDoc) {
  await es.index({ index: INDEX, id: doc.doc_id, document: doc, refresh: true });
}

export async function bulkUpsert(docs: BrainDoc[]) {
  if (!docs.length) return;
  const operations = docs.flatMap((d) => [{ index: { _index: INDEX, _id: d.doc_id } }, d]);
  const r = await es.bulk({ operations, refresh: true });
  if (r.errors) throw new Error("Bulk index had errors: " + JSON.stringify(r.items.find((i) => i.index?.error)));
}

export async function deleteMessage(teamId: string, channelId: string, ts: string) {
  // Also remove replies if a thread parent is deleted.
  await es.deleteByQuery({
    index: INDEX,
    refresh: true,
    query: {
      bool: {
        should: [
          { term: { doc_id: docId(teamId, channelId, ts) } },
          { bool: { filter: [...inConversation(teamId, channelId), { term: { thread_ts: ts } }] } },
        ],
        minimum_should_match: 1,
      },
    },
  });
}

// Remove a whole conversation, e.g. a DM nobody has connected anymore.
export async function deleteConversation(teamId: string, channelId: string) {
  await es.deleteByQuery({ index: INDEX, refresh: true, query: { bool: { filter: inConversation(teamId, channelId) } } });
}

// Rewrite the name and permission label of every doc in a channel
// (after a rename, or when a channel switches between public and private).
export async function reaclChannel(teamId: string, ch: ChannelInfo) {
  await es.updateByQuery({
    index: INDEX,
    refresh: true,
    conflicts: "proceed",
    query: { bool: { filter: inConversation(teamId, ch.id) } },
    script: {
      source:
        "ctx._source.acl_container = params.acl; ctx._source.channel_name = params.name; ctx._source.is_private = params.priv",
      params: { acl: aclForChannel(teamId, ch), name: ch.name, priv: ch.is_private },
    },
  });
}
