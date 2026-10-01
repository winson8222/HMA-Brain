// npm run audit:log [-- --user bob --doc <Drive file ID or doc ID> --denied|--dropped --since 2026-09-01 --text breach --limit 20]
//   Who asked what, what they were shown, and what was withheld (scenario S5). Newest first.
// npm run audit:verify
//   Re-computes the hash chain. Exits 1 if any record was edited, deleted or reordered.
import { demoPeople, findPerson } from "../connectors/drive/people.js";
import { getConnector } from "../connectors/drive/store.js";
import type { Decision } from "./chain.js";
import { formatRecord } from "./format.js";
import { queryAudit, verifyAudit } from "./store.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "verify") {
  const v = await verifyAudit();
  if (v.ok) console.log(`✓ ${v.checked} records, chain intact.${v.head ? ` Head: #${v.head.seq} ${v.head.hash}` : ""}`);
  else {
    console.log(`✕ Chain broken (${v.checked} records checked):`);
    for (const p of v.problems) console.log(`  #${p.seq}: ${p.problem}`);
  }
  process.exit(v.ok ? 0 : 1);
}

// --user accepts a persona name ("bob"), "admin", or an email.
let actor = opt("user");
if (actor && !actor.includes("@")) {
  const admin = (await getConnector().catch(() => undefined))?.account_email?.toLowerCase() ?? null;
  actor = findPerson(actor, demoPeople(admin))?.email ?? actor;
}
const decision: Decision | undefined = args.includes("--denied") ? "denied" : args.includes("--dropped") ? "dropped" : undefined;

const records = await queryAudit({
  actor,
  doc: opt("doc"),
  decision,
  since: opt("since"),
  until: opt("until"),
  text: opt("text"),
  limit: Number(opt("limit")) || 20,
});
console.log(records.length ? records.map(formatRecord).join("\n\n") : "No matching audit records.");
process.exit(0);
