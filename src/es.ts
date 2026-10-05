import { Client } from "@elastic/elasticsearch";
import { config } from "./config.js";

export const es = new Client({ node: config.esUrl });
export const INDEX = config.esIndex;

const mappings = {
  properties: {
    doc_id: { type: "keyword" },
    source: { type: "keyword" },
    team_id: { type: "keyword" },
    team_name: { type: "keyword" },
    kind: { type: "keyword" },
    channel_id: { type: "keyword" },
    channel_name: { type: "keyword" },
    is_private: { type: "boolean" },
    user_id: { type: "keyword" },
    user_name: { type: "keyword" },
    text: { type: "text" },
    thread_ts: { type: "keyword" },
    ts: { type: "date" },
    slack_ts: { type: "keyword" },
    permalink: { type: "keyword", index: false },
    acl_container: { type: "keyword" },
    // Vector for hybrid search; only when embeddings are configured (dims come from EMBEDDING_DIMS).
    ...(config.embeddingDims
      ? { text_vector: { type: "dense_vector", dims: config.embeddingDims, index: true, similarity: "cosine" } as const }
      : {}),
  },
} as const;

export async function ensureIndex() {
  if (!(await es.indices.exists({ index: INDEX }))) {
    await es.indices.create({ index: INDEX, mappings });
    return;
  }
  // Warn when the running index can't hold vectors even though hybrid search is configured.
  if (config.embeddingDims) {
    try {
      await es.indices.getFieldMapping({ index: INDEX, fields: ["text_vector"] });
    } catch {
      console.warn("Index lacks text_vector — hybrid search will be lexical-only until you run `npm run backfill`");
    }
  }
}

export async function resetIndex() {
  await es.indices.delete({ index: INDEX, ignore_unavailable: true });
  await es.indices.create({ index: INDEX, mappings });
}
