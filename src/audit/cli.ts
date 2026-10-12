// npm run audit:log [-- --user bob --doc <ID or title words> --kind permission --denied|--dropped --since 2026-09-01 --text breach --limit 20]
//   Who asked what, what they were shown, and what was withheld (scenario S5); plus permission and content
//   changes, account links and admin actions (--kind search|ask|access|permission|content|account|admin,
//   comma-separated). Newest first.
// npm run audit:verify
//   Checks hashes and retained checkpoint. Exits 1 if integrity or retained trust cannot be verified.
import { demoPeople, findPerson } from "../connectors/drive/people.js";
import { getConnector } from "../connectors/drive/store.js";
import { parseKinds, type Decision } from "./chain.js";
import { recordAudit } from "./record.js";
import { formatRecord } from "./format.js";
import { queryAudit, verifyAudit, initializeAuditCheckpoint, backupAudit, repairAudit } from "./store.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "backup" || args[0] === "repair") {
  try {
    const path = opt("file");
    if (!path || path.startsWith("--")) throw new Error("Supply --file <backup.json>");
    const apply = args.includes("--apply");
    const evidence = opt("evidence");
    if (args[0] === "repair" && apply && (!evidence || evidence.startsWith("--"))) {
      throw new Error("Repair --apply requires --evidence <new-file.json>; stop all app/poller writers first");
    }
    const result = args[0] === "backup" ? await backupAudit(path) : await repairAudit(path, apply ? evidence : undefined);
    console.log(args[0] === "backup"
      ? `Verified backup saved: ${result.checked} records. Keep it private; newer audit writes require a new backup.`
      : apply ? `Restored and verified ${result.checked} records. Original checkpoint retained. Evidence: ${evidence}`
      : `Backup validated against the current checkpoint: ${result.checked} records. No changes made. Stop writers, then add --apply --evidence <new-file.json> to restore.`);
    process.exit(0);
  } catch (e: any) {
    console.error(`Audit ${args[0]} failed: ${String(e?.message ?? e)}. Keep writers stopped if a repair was interrupted.`);
    process.exit(1);
  }
}

if (args[0] === "checkpoint") {
  if (!args.includes("--trust-current-head")) {
    console.error("Explicit trust required: audit:log -- checkpoint --trust-current-head. This accepts the current history as the baseline; it cannot detect deletion before initialization.");
    process.exit(2);
  }
  try {
    const v = await initializeAuditCheckpoint();
    console.log(`Trusted audit baseline saved: ${v.checked} records, head #${v.head?.seq ?? 0}. Earlier suffix deletion cannot be ruled out by this bootstrap.`);
    process.exit(0);
  } catch (e: any) {
    console.error(`Checkpoint initialization failed: ${String(e?.message ?? e)}`);
    process.exit(1);
  }
}

if (args[0] === "verify") {
  try {
    const v = await verifyAudit();
    if (v.ok) await recordAudit({ kind: "admin", actor: "admin", via: "cli", action: "audit_verify", result: `intact: ${v.checked} records` });
    if (v.ok) console.log(`✓ ${v.checked} records, chain and checkpoint verified.${v.head ? ` Head: #${v.head.seq} ${v.head.hash}` : ""}`);
    else {
      console.log(`✕ Verification failed (${v.checked} records checked):`);
      for (const p of v.problems) console.log(`  #${p.seq}: ${p.problem}`);
    }
    process.exit(v.ok ? 0 : 1);
  } catch (e: any) {
    console.error(`Verification failed: ${String(e?.message ?? e)}`);
    process.exit(1);
  }
}

// --user accepts a persona name ("bob"), "admin", or an email.
let actor = opt("user");
if (actor && !actor.includes("@")) {
  const admin = (await getConnector().catch(() => undefined))?.account_email?.toLowerCase() ?? null;
  actor = findPerson(actor, demoPeople(admin))?.email ?? actor;
}
const decision: Decision | undefined = args.includes("--denied") ? "denied" : args.includes("--dropped") ? "dropped" : undefined;

const kindArg = opt("kind");
const kind = parseKinds(kindArg);
if (kindArg && !kind) {
  console.error(`Unknown --kind ${kindArg}. Use search, ask, access, permission, content, account or admin.`);
  process.exit(2);
}
const filter = {
  actor,
  doc: opt("doc"),
  kind,
  decision,
  since: opt("since"),
  until: opt("until"),
  text: opt("text"),
  limit: Number(opt("limit")) || 20,
};
const records = await queryAudit(filter);
const detail = Object.fromEntries(Object.entries({ ...filter, kind: kind?.join(","), limit: undefined }).filter(([, v]) => v)) as Record<string, string>;
await recordAudit({ kind: "admin", actor: "admin", via: "cli", action: "audit_query", detail, result: `${records.length} record(s)` });
console.log(records.length ? records.map(formatRecord).join("\n\n") : "No matching audit records.");
process.exit(0);
