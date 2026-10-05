// npm run verify — checks Elasticsearch matches Slack, in every workspace:
// same messages, and correct permission labels, for channels and connected people's DMs.
import type { WebClient } from "@slack/web-api";
import { aclForChannel, type ChannelInfo } from "./acl.js";
import { userDmConversations } from "./dms.js";
import { es, INDEX } from "./es.js";
import { conversationMessages, workspaces, type Workspace } from "./slack.js";
import { messageToDoc, type BrainDoc } from "./slackDocs.js";
import { userTokens } from "./tokens.js";

let ok = true;
const rows: Record<string, string | number>[] = [];

async function check(ws: Workspace, ch: ChannelInfo, client: WebClient) {
  const expected = new Set(
    (await conversationMessages(client, ch.id)).map((m) => messageToDoc(m, ch, ws.ctx())?.doc_id).filter(Boolean) as string[],
  );
  const r = await es.search<BrainDoc>({
    index: INDEX,
    size: 10000,
    query: { bool: { filter: [{ term: { team_id: ws.teamId } }, { term: { channel_id: ch.id } }] } },
    _source: ["acl_container"],
  });
  const indexed = new Set(r.hits.hits.map((h) => h._id!));
  const wantAcl = JSON.stringify([...aclForChannel(ws.teamId, ch)].sort());
  const badAcl = r.hits.hits.filter((h) => JSON.stringify([...h._source!.acl_container].sort()) !== wantAcl).length;
  const missing = [...expected].filter((id) => !indexed.has(id)).length;
  const extra = [...indexed].filter((id) => !expected.has(id)).length;
  const pass = missing === 0 && extra === 0 && badAcl === 0;
  ok &&= pass;
  rows.push({
    workspace: ws.teamName,
    conversation: ch.kind === "channel" ? "#" + ch.name : ch.name,
    type: ch.kind === "channel" ? (ch.is_private ? "private" : "public") : ch.kind,
    in_slack: expected.size,
    in_es: indexed.size,
    missing,
    extra,
    wrong_label: badAcl,
    result: pass ? "PASS" : "FAIL",
  });
}

for (const ws of await workspaces()) {
  for (const c of await ws.listChannels()) {
    if (c.is_member) await check(ws, ws.rememberChannel(c), ws.web);
  }
  const seen = new Set<string>();
  for (const t of userTokens(ws.teamId)) {
    for (const { info, client } of await userDmConversations(ws, t)) {
      if (seen.has(info.id)) continue;
      seen.add(info.id);
      await check(ws, info, client);
    }
  }
}

console.table(rows);
console.log(ok ? "Everything matches." : "Mismatch found. Run `npm run backfill` to rebuild.");
process.exit(ok ? 0 : 1);
