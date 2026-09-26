import type { estypes } from "@elastic/elasticsearch";
import { aclFilter, aclForChannel, canSee } from "./acl.js";
import { es, INDEX } from "./es.js";
import { getAccess } from "./principals.js";
import { getChannel, getWorkspace } from "./slack.js";
import type { BrainDoc } from "./slackDocs.js";

type SearchHit<T> = estypes.SearchHit<T>;

export type Result = {
  channel: string;
  is_private: boolean;
  author: string;
  snippet: string;
  time: string;
  permalink: string;
};

// What the audit log records about each message (admin view only).
export type LoggedDoc = { id: string; channel: string; is_private: boolean; author: string; text: string };

export type LogEntry = {
  at: string;
  kind: "search" | "ask";
  userId: string;
  query: string;
  keywords?: string;
  answer?: string;
  allowed: LoggedDoc[];
  droppedByRecheck: LoggedDoc[];
  denied: LoggedDoc[];
};

export const auditLog: LogEntry[] = [];

export function logEntry(e: Omit<LogEntry, "at">) {
  auditLog.unshift({ at: new Date().toISOString(), ...e });
  auditLog.length = Math.min(auditLog.length, 200);
}

const logged = (h: SearchHit<BrainDoc>): LoggedDoc => ({
  id: h._id!,
  channel: h._source!.channel_name,
  is_private: h._source!.is_private,
  author: h._source!.user_name,
  text: h._source!.text,
});

export function permissionedQuery(q: string, principals: string[], size = 10) {
  return {
    index: INDEX,
    size,
    query: { bool: { must: { match: { text: q } }, filter: [aclFilter(principals)] } },
    highlight: {
      fields: { text: { number_of_fragments: 0 } },
      encoder: "html" as const,
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
    },
  };
}

// Permission-aware retrieval shared by Search and Ask.
export async function retrieve(userId: string, q: string, size = 10) {
  // 1. What can this user see? (cached; refreshed on membership events or after 60s)
  const access = await getAccess(userId);

  // 2. Search, filtered by the user's principals. Restricted docs never leave Elasticsearch.
  const r = await es.search<BrainDoc>(permissionedQuery(q, access.principals, size));

  // 3. Re-check each hit against live Slack data (fresh membership + current channel privacy),
  //    in case an event was missed and the index or cache is stale.
  const live = await getAccess(userId, { fresh: true });
  const { teamId } = await getWorkspace();
  const allowed: SearchHit<BrainDoc>[] = [];
  const dropped: LoggedDoc[] = [];
  for (const h of r.hits.hits) {
    const ch = await getChannel(h._source!.channel_id, true);
    if (canSee(aclForChannel(teamId, ch), live.principals)) allowed.push(h);
    else dropped.push(logged(h));
  }

  // 4. Server-side only: which matching docs were withheld. Goes to the audit log, never to the user.
  const shadow = await es.search<BrainDoc>({ index: INDEX, size: 50, query: { match: { text: q } } });
  const allowedIds = new Set(allowed.map((h) => h._id));
  const denied = shadow.hits.hits.filter((h) => !allowedIds.has(h._id)).map(logged);

  return { allowed, audit: { allowed: allowed.map(logged), droppedByRecheck: dropped, denied } };
}

export function toResult(h: SearchHit<BrainDoc>): Result {
  const d = h._source!;
  return {
    channel: d.channel_name,
    is_private: d.is_private,
    author: d.user_name,
    snippet: h.highlight?.text?.join(" … ") ?? escapeHtml(d.text),
    time: d.ts,
    permalink: d.permalink,
  };
}

export async function search(userId: string, q: string): Promise<Result[]> {
  const { allowed, audit } = await retrieve(userId, q);
  logEntry({ kind: "search", userId, query: q, ...audit });
  // Only content fields go back: no hit counts, no ACLs, nothing about withheld docs.
  return allowed.map(toResult);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
