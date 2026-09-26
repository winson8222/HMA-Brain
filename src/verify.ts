// npm run verify — checks Elasticsearch matches Slack: same messages, correct permission labels.
import { aclForChannel } from "./acl.js";
import { es, INDEX } from "./es.js";
import { channelMessages, docCtx, listChannels, rememberChannel } from "./slack.js";
import { messageToDoc, type BrainDoc } from "./slackDocs.js";

const ctx = await docCtx();
let ok = true;
const rows: Record<string, string | number>[] = [];

for (const c of await listChannels()) {
  if (!c.is_member) continue;
  const ch = rememberChannel(c);
  const expected = new Set(
    (await channelMessages(ch.id)).map((m) => messageToDoc(m, ch, ctx)?.doc_id).filter(Boolean) as string[],
  );

  const r = await es.search<BrainDoc>({
    index: INDEX,
    size: 10000,
    query: { term: { channel_id: ch.id } },
    _source: ["acl_container"],
  });
  const indexed = new Set(r.hits.hits.map((h) => h._id!));
  const wantAcl = JSON.stringify(aclForChannel(ctx.teamId, ch));
  const badAcl = r.hits.hits.filter((h) => JSON.stringify(h._source!.acl_container) !== wantAcl).length;

  const missing = [...expected].filter((id) => !indexed.has(id)).length;
  const extra = [...indexed].filter((id) => !expected.has(id)).length;
  const pass = missing === 0 && extra === 0 && badAcl === 0;
  ok &&= pass;
  rows.push({
    channel: "#" + ch.name,
    private: ch.is_private ? "yes" : "no",
    in_slack: expected.size,
    in_es: indexed.size,
    missing,
    extra,
    wrong_label: badAcl,
    result: pass ? "PASS" : "FAIL",
  });
}

console.table(rows);
console.log(ok ? "All channels match." : "Mismatch found. Run `npm run backfill` to rebuild.");
process.exit(ok ? 0 : 1);
