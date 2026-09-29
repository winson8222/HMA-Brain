// Hybrid retrieval helpers: config resolution, the kNN query and reciprocal rank fusion.
// Pure and unit-testable; no Elasticsearch, network or Slack access here.
import { aclFilter } from "./acl.js";
import { config } from "./config.js";
import { embeddingConfigured } from "./embeddings.js";

export type RetrievalMode = "lexical" | "hybrid";

// RETRIEVAL_MODE wins when set; otherwise hybrid as soon as an embedding model + dims are configured.
export function resolveRetrievalMode(): RetrievalMode {
  const explicit = process.env.RETRIEVAL_MODE;
  if (explicit === "lexical" || explicit === "hybrid") return explicit;
  return embeddingConfigured() ? "hybrid" : "lexical";
}

// MULTI_QUERY: number of semantic paraphrases per query (0/off/unset = off, "on" = 2).
export function resolveMultiQuery(): number {
  const v = process.env.MULTI_QUERY;
  if (!v || v === "off" || v === "0") return 0;
  if (v === "on") return 2;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

// RERANK=on|off wins when set; otherwise on as soon as a Cohere key exists.
export function resolveRerank(): boolean {
  const explicit = process.env.RERANK;
  if (explicit === "on") return true;
  if (explicit === "off") return false;
  return !!process.env.COHERE_API_KEY;
}

// The vector leg of hybrid search. The permission filter goes INSIDE the knn clause
// (developer-guide rule) so restricted docs are never even candidates. Never use post_filter.
export function knnQuery(
  vector: number[],
  principals: string[],
  k = config.hybridCandidates,
  numCandidates = config.hybridCandidates * 2,
) {
  return {
    knn: {
      field: "text_vector",
      query_vector: vector,
      k,
      num_candidates: numCandidates,
      filter: [aclFilter(principals)],
    },
    size: k,
  };
}

// Reciprocal rank fusion over ordered id lists (rank starts at 1).
// score(d) = Σ 1/(k + rank). Ties break by first appearance across lists, for determinism.
export function rrfFuse(lists: string[][], k = config.rrfK): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, firstSeen.size);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.id)! - firstSeen.get(b.id)!);
}
