import type { estypes } from "@elastic/elasticsearch";
import { aclFilter, aclForChannel, canSee } from "./acl.js";
import { config } from "./config.js";
import { es, INDEX } from "./es.js";
import { embedQuery, embedTexts } from "./embeddings.js";
import { knnQuery, resolveMultiQuery, resolveRetrievalMode, resolveRerank, rrfFuse } from "./hybrid.js";
import { paraphrase } from "./multiQuery.js";
import { llmConfigured } from "./llm.js";
import { getAccess } from "./people.js";
import { applyRerankOrder, rerank } from "./rerank.js";
import { workspaceByTeam } from "./slack.js";
import type { BrainDoc } from "./slackDocs.js";
import { withSpan } from "./tracing.js";

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
export async function retrieve(personId: string, q: string, size = 10, opts: { vectorQuery?: string; rerank?: boolean } = {}) {
  // 1. What can this person see, across all workspaces? (cached; refreshed on membership events or after 60s)
  const access = await getAccess(personId);

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

  // 3. Re-check channel hits against live Slack data (fresh membership + current channel privacy),
  //    in case an event was missed. DMs need no re-check: who is in a DM never changes.
  const live = await getAccess(personId, { fresh: true });
  let allowed: SearchHit<BrainDoc>[] = [];
  const dropped: LoggedDoc[] = [];
  await withSpan("recheck", { candidates: hits.length }, async () => {
    for (const h of hits) {
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
    return { allowed: allowed.length, dropped: dropped.length };
  });

  // 4. Rerank the permitted candidates with Cohere (falls back to the pre-rerank order on failure).
  //    After the re-check on purpose: only already-permitted text is ever sent to a third party,
  //    and the rerank budget isn't spent on docs that would be dropped anyway.
  //    Skipped when the caller reranks a merged multi-source list itself (src/federated.ts).
  if (opts.rerank !== false && resolveRerank() && allowed.length > 1) {
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

  // 5. Server-side only: which matching docs were withheld. Goes to the audit log, never to the user.
  const shadow = await es.search<BrainDoc>({ index: INDEX, size: 50, query: { match: { text: q } } });
  const allowedIds = new Set(allowed.map((h) => h._id));
  const denied = shadow.hits.hits.filter((h) => !allowedIds.has(h._id)).map((h) => logged(h, { redactDm: true }));

  return { allowed: allowed.slice(0, size), audit: { allowed: allowed.map((h) => logged(h)), droppedByRecheck: dropped, denied } };
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

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
