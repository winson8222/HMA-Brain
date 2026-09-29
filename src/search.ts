import type { estypes } from "@elastic/elasticsearch";
import { aclFilter, aclForChannel, canSee } from "./acl.js";
import { config } from "./config.js";
import { es, INDEX } from "./es.js";
import { embedQuery, embedTexts } from "./embeddings.js";
import { knnQuery, resolveMultiQuery, resolveRetrievalMode, resolveRerank, rrfFuse } from "./hybrid.js";
import { paraphrase } from "./multiQuery.js";
import { llmConfigured } from "./llm.js";
import { getAccess } from "./principals.js";
import { applyRerankOrder, rerank } from "./rerank.js";
import { getChannel, getWorkspace } from "./slack.js";
import type { BrainDoc } from "./slackDocs.js";
import { withSpan, withTrace } from "./tracing.js";

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
export async function retrieve(userId: string, q: string, size = 10, opts: { vectorQuery?: string } = {}) {
  // 1. What can this user see? (cached; refreshed on membership events or after 60s)
  const access = await getAccess(userId);

  // 2. Candidate fetch, filtered by the user's principals. Restricted docs never leave Elasticsearch.
  //    lexical: BM25 only. hybrid: BM25 + kNN in parallel, fused with reciprocal rank fusion.
  let hits: SearchHit<BrainDoc>[];
  if (resolveRetrievalMode() === "hybrid") {
    hits = await withSpan("hybrid.fetch", { lexical: q, vectorQuery: opts.vectorQuery ?? q }, async () => {
      const vq = opts.vectorQuery ?? q;
      // Semantic query vectors: one per paraphrase when MULTI_QUERY is on (falls back to the
      // raw query alone on any paraphrase/embed failure).
      let vectors: number[][] = [];
      const nParaphrases = resolveMultiQuery();
      if (nParaphrases > 0 && llmConfigured()) {
        try {
          const variants = await withSpan("multiquery", { question: vq, n: nParaphrases }, () => paraphrase(vq, nParaphrases));
          if (variants.length) {
            vectors = await withSpan("embed.query", { queries: [vq, ...variants] }, () => embedTexts([vq, ...variants]));
          }
        } catch (e) {
          console.warn("multi-query failed, using the raw query:", String((e as any)?.message ?? e));
        }
      }
      if (!vectors.length) {
        try {
          vectors = [await withSpan("embed.query", { text: vq }, () => embedQuery(vq))];
        } catch (e) {
          console.warn("embed failed, falling back to the lexical leg:", String((e as any)?.message ?? e));
        }
      }
      const [bm25, knnLists] = await Promise.all([
        es.search<BrainDoc>(permissionedQuery(q, access.principals, config.hybridCandidates)),
        Promise.all(vectors.map((v) => es.search<BrainDoc>(knnQuery(v, access.principals)))),
      ]);
      const byId = new Map<string, SearchHit<BrainDoc>>();
      for (const h of [bm25.hits.hits, ...knnLists.map((r) => r.hits.hits)].flat()) if (h._id) byId.set(h._id, h);
      const fused = await withSpan(
        "fuse",
        { bm25: bm25.hits.hits.length, knn: knnLists.map((r) => r.hits.hits.length) },
        async () =>
          rrfFuse([bm25.hits.hits, ...knnLists.map((r) => r.hits.hits)].map((l) => l.map((h) => h._id!))).slice(0, config.fuseTop),
      );
      return fused.map((f) => byId.get(f.id)!).filter(Boolean);
    });
  } else {
    hits = (await es.search<BrainDoc>(permissionedQuery(q, access.principals, size))).hits.hits;
  }

  // 3. Re-check each hit against live Slack data (fresh membership + current channel privacy),
  //    in case an event was missed and the index or cache is stale.
  const live = await getAccess(userId, { fresh: true });
  const { teamId } = await getWorkspace();
  let allowed: SearchHit<BrainDoc>[] = [];
  const dropped: LoggedDoc[] = [];
  await withSpan("recheck", { candidates: hits.length }, async () => {
    for (const h of hits) {
      const ch = await getChannel(h._source!.channel_id, true);
      if (canSee(aclForChannel(teamId, ch), live.principals)) allowed.push(h);
      else dropped.push(logged(h));
    }
    return { allowed: allowed.length, dropped: dropped.length };
  });

  // 3. Rerank the permitted candidates with Cohere (falls back to the pre-rerank order on failure).
  //    After the re-check on purpose: only already-permitted text is ever sent to a third party,
  //    and the rerank budget isn't spent on docs that would be dropped anyway.
  if (resolveRerank() && allowed.length > 1) {
    allowed = await withSpan("rerank", { model: process.env.COHERE_MODEL ?? "rerank-v3.5", candidates: allowed.length }, async () => {
      try {
        const order = await rerank(q, allowed.map((h) => ({ text: h._source!.text })));
        return applyRerankOrder(allowed, order).map((r) => r.item);
      } catch (e) {
        console.warn("rerank failed, keeping pre-rerank order:", String((e as any)?.message ?? e));
        return allowed;
      }
    });
  }

  // 4. Server-side only: which matching docs were withheld. Goes to the audit log, never to the user.
  const shadow = await es.search<BrainDoc>({ index: INDEX, size: 50, query: { match: { text: q } } });
  const allowedIds = new Set(allowed.map((h) => h._id));
  const denied = shadow.hits.hits.filter((h) => !allowedIds.has(h._id)).map(logged);

  return { allowed: allowed.slice(0, size), audit: { allowed: allowed.map(logged), droppedByRecheck: dropped, denied } };
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
  return withTrace("search", { userId, input: { query: q } }, async () => {
    const { allowed, audit } = await retrieve(userId, q);
    logEntry({ kind: "search", userId, query: q, ...audit });
    // Only content fields go back: no hit counts, no ACLs, nothing about withheld docs.
    return allowed.map(toResult);
  });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
