import type { estypes } from "@elastic/elasticsearch";
import { aclFilter, aclForChannel, canSee } from "./acl.js";
import { es, INDEX } from "./es.js";
import { getAccess } from "./people.js";
import { workspaceByTeam } from "./slack.js";
import type { BrainDoc } from "./slackDocs.js";

type SearchHit<T> = estypes.SearchHit<T>;

export type AskMode = "demo" | "me";

export type Result = {
  workspace: string;
  channel: string;
  kind: BrainDoc["kind"];
  is_private: boolean;
  author: string;
  snippet: string;
  time: string;
  permalink: string;
};

// What the audit log records about each message (admin view only).
export type LoggedDoc = {
  id: string;
  workspace: string;
  channel: string;
  kind: BrainDoc["kind"];
  is_private: boolean;
  author: string;
  text: string;
};

export type LogEntry = {
  at: string;
  kind: "search" | "ask";
  mode: AskMode;
  personId: string;
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

const logged = (h: SearchHit<BrainDoc>, opts: { redactDm?: boolean } = {}): LoggedDoc => {
  const d = h._source!;
  const isDm = d.kind !== "channel";
  return {
    id: h._id!,
    workspace: d.team_name,
    channel: d.channel_name,
    kind: d.kind,
    is_private: d.is_private,
    author: isDm && opts.redactDm ? "" : d.user_name,
    // Compliance needs to know a private message was withheld, not what it said.
    text: isDm && opts.redactDm ? "(withheld)" : d.text,
  };
};

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
export async function retrieve(personId: string, q: string, size = 10) {
  // 1. What can this person see, across all workspaces? (cached; refreshed on membership events or after 60s)
  const access = await getAccess(personId);

  // 2. Search, filtered by their principals. Restricted docs never leave Elasticsearch.
  const r = await es.search<BrainDoc>(permissionedQuery(q, access.principals, size));

  // 3. Re-check channel hits against live Slack data (fresh membership + current channel privacy),
  //    in case an event was missed. DMs need no re-check: who is in a DM never changes.
  const live = await getAccess(personId, { fresh: true });
  const allowed: SearchHit<BrainDoc>[] = [];
  const dropped: LoggedDoc[] = [];
  for (const h of r.hits.hits) {
    const d = h._source!;
    let ok: boolean;
    if (d.kind === "channel") {
      const ws = await workspaceByTeam(d.team_id);
      ok = canSee(aclForChannel(d.team_id, await ws.getChannel(d.channel_id, true)), live.principals);
    } else {
      ok = canSee(d.acl_container, live.principals);
    }
    if (ok) allowed.push(h);
    else dropped.push(logged(h, { redactDm: true }));
  }

  // 4. Server-side only: which matching docs were withheld. Goes to the audit log, never to the user.
  const shadow = await es.search<BrainDoc>({ index: INDEX, size: 50, query: { match: { text: q } } });
  const allowedIds = new Set(allowed.map((h) => h._id));
  const denied = shadow.hits.hits.filter((h) => !allowedIds.has(h._id)).map((h) => logged(h, { redactDm: true }));

  return { allowed, audit: { allowed: allowed.map((h) => logged(h)), droppedByRecheck: dropped, denied } };
}

export function toResult(h: SearchHit<BrainDoc>): Result {
  const d = h._source!;
  return {
    workspace: d.team_name,
    channel: d.channel_name,
    kind: d.kind,
    is_private: d.is_private,
    author: d.user_name,
    snippet: h.highlight?.text?.join(" … ") ?? escapeHtml(d.text),
    time: d.ts,
    permalink: d.permalink,
  };
}

export async function search(personId: string, q: string, mode: AskMode): Promise<Result[]> {
  const { allowed, audit } = await retrieve(personId, q);
  logEntry({ kind: "search", mode, personId, query: q, ...audit });
  // Only content fields go back: no hit counts, no ACLs, nothing about withheld docs.
  return allowed.map(toResult);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
