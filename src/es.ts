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
  },
} as const;

export async function ensureIndex() {
  if (!(await es.indices.exists({ index: INDEX }))) {
    await es.indices.create({ index: INDEX, mappings });
  }
}

export async function resetIndex() {
  await es.indices.delete({ index: INDEX, ignore_unavailable: true });
  await es.indices.create({ index: INDEX, mappings });
}
