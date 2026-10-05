// npm run drive:doctor — checks the whole Drive setup and lists what's left to do: blockers first, then warnings.
// Read-only: it changes nothing in Drive or Elasticsearch.
import { existsSync, readFileSync } from "node:fs";
import { verifyAudit } from "../../../audit/store.js";
import { es } from "../../../es.js";
import { chat, llmConfigured } from "../../../llm.js";
import { driveKeysFor } from "../acl.js";
import { accountEmail, explain, isConnected } from "../client.js";
import { driveConfig } from "../config.js";
import { demoPeople, setupWarnings } from "../people.js";
import { countDocs, countFileStates, ensureDriveIndices, getConnector } from "../store.js";
import { resolveRoot } from "../sync.js";

const mustFix: string[] = [];
const shouldFix: string[] = [];
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string, fix: string) => {
  console.log(`  ✕ ${msg}`);
  mustFix.push(fix);
};
const warn = (msg: string, fix?: string) => {
  console.log(`  ! ${msg}`);
  if (fix) shouldFix.push(fix);
};
function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

console.log("Google");
let account: string | null = null;
if (!isConnected()) bad("Drive isn't connected", "Connect Drive: `npm run drive:connect`, signed in as the admin account.");
else {
  try {
    account = await accountEmail();
    ok(`connected as ${account}`);
  } catch (e) {
    bad(explain(e), "Reconnect Drive: `npm run drive:connect` (Testing-mode tokens expire after 7 days).");
  }
}
if (account) {
  try {
    const root = await resolveRoot();
    ok(`root folder "${root.name}" (${root.id})`);
  } catch (e) {
    bad(explain(e), "Create the demo folder: `npm run seed:drive`.");
  }
}

console.log("\nIndex");
await ensureDriveIndices();
const conn = await getConnector();
const files = await countFileStates();
if (!conn?.last_backfill_at) bad("never backfilled", "Index Drive: `npm run drive:backfill`.");
else ok(`${files} files, ${await countDocs()} chunks; last backfill ${ago(conn.last_backfill_at)}, last poll ${ago(conn.last_poll_at)}`);
if (conn?.account_email && account && conn.account_email.toLowerCase() !== account) {
  warn(`index was built as ${conn.account_email} but the token is ${account}`, "Rebuild for the new admin: `npm run drive:backfill` (a poll also does it automatically).");
}
const lastSync = Math.max(Date.parse(conn?.last_poll_at ?? "") || 0, Date.parse(conn?.last_backfill_at ?? "") || 0);
if (lastSync && Date.now() - lastSync > 3 * driveConfig.pollSeconds * 1000) {
  warn(
    `no sync for ${Math.round((Date.now() - lastSync) / 60000)} min, so Drive changes aren't showing up`,
    "Keep Drive current: set DRIVE_SYNC=on and run `npm run dev` (or `npm run drive:poll -- --watch`).",
  );
}

console.log("\nPeople (what each can see)");
const admin = account ?? conn?.account_email?.toLowerCase() ?? null;
for (const p of demoPeople(admin)) {
  const r = await es.search({
    index: driveConfig.index,
    size: 0,
    query: { bool: { filter: [{ terms: { acl_container: driveKeysFor(p.email) } }] } },
    aggs: { files: { cardinality: { field: "file_id" } } },
  });
  ok(`${p.name} (${p.email})${p.admin ? " [admin]" : ""}: ${(r.aggregations?.files as any)?.value ?? 0} of ${files} files`);
}
for (const w of setupWarnings(admin)) {
  if (w.includes("is also the Drive admin")) warn(w, "Before the real demo: switch to a dedicated admin account (docs/drive-setup.md, “Switch to a dedicated admin”).");
  else if (w.startsWith("CAROL_EMAIL")) warn(w, "Set CAROL_EMAIL in .env (the email Carol uses in Slack), then `npm run seed:drive` to share her files.");
  else warn(w);
}

console.log("\nAsk, audit, admin");
if (!llmConfigured()) bad("no LLM configured", "Set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in .env (README section 3).");
else {
  try {
    await chat([{ role: "user", content: "Reply with OK." }], { maxTokens: 20 }); // one tiny real call: is the key accepted?
    ok(`LLM: ${process.env.LLM_MODEL} answers`);
  } catch (e: any) {
    bad(`LLM ${process.env.LLM_MODEL} failed: ${String(e?.message ?? e).slice(0, 140)}`, "Put a working LLM_API_KEY in .env (TokenHub: console.tencentcloud.com/tokenhub → API Key; activate the model first). Ask needs it; Search doesn't.");
  }
}
if ((process.env.ADMIN_TOKEN ?? "").length >= 16) ok("ADMIN_TOKEN set (audit log and Connect on /drive.html)");
else bad("ADMIN_TOKEN not set", "Set ADMIN_TOKEN (16+ random characters) in .env to use the admin panel on /drive.html.");
try {
  const v = await verifyAudit();
  if (v.ok) ok(`audit chain intact (${v.checked} records)`);
  else bad(`audit chain broken: ${v.problems.map((p) => `#${p.seq} ${p.problem}`).join("; ")}`, "Investigate the audit log: `npm run audit:verify`.");
} catch (e) {
  bad(`audit log unreadable: ${explain(e)}`, "Check Elasticsearch is running: `docker compose up -d`.");
}

console.log("\nSecurity");
const compose = existsSync("docker-compose.yml") ? readFileSync("docker-compose.yml", "utf8") : "";
if (/["']9200:9200["']/.test(compose)) {
  warn("Elasticsearch (no password) is reachable from your network", "Bind Elasticsearch to this machine only: ports \"127.0.0.1:9200:9200\" in docker-compose.yml (Slack fix #1).");
} else ok("Elasticsearch bound to localhost");

const list = (title: string, items: string[]) => (items.length ? `\n${title}:\n${items.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}` : "");
console.log(list("Must fix", mustFix) + list("Should fix before the demo", shouldFix) || "\nAll good.");
process.exit(0);
