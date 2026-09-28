// npm run seed:drive [-- --edit-runbook | --revoke <persona>] — creates the demo "Company A" folder in the admin's
// Drive and shares it with the personas, mirroring the Slack storyline. Writes only to Drive (the crawler picks it up).
// Safe to re-run: existing folders and files are found by name, and only missing shares are added.
// --edit-runbook: adds a failover step to the runbook, to show an update reaching the index (scenario S2).
// --revoke bob:   removes Bob from the Runbooks folder, to show live revocation (S4). Run seed:drive again to restore.
import { Readable } from "node:stream";
import { accountEmail, drive, explain, findFolder, withRetry } from "../client.js";
import { driveConfig } from "../config.js";
import { FOLDER, GOOGLE_DOC, GOOGLE_SHEET, PDF } from "../extract.js";
import { personaEmail, PERSONAS, type Persona } from "../people.js";
import { textPdf } from "./minipdf.js";

// Folder shares are inherited by everything inside (e.g. the runbook is visible to Alice, Bob and Carol via its folder).
// Alice is listed even while she's the admin (owners are skipped), so the story holds after switching to a dedicated admin.
const FOLDERS: { path: string[]; share?: Persona[] }[] = [
  { path: ["Engineering"] },
  { path: ["Engineering", "Runbooks"], share: ["alice", "bob", "carol"] },
  { path: ["Engineering", "Postmortems"] },
  { path: ["Security"] },
  { path: ["Vendors"] },
];

type SeedFile = { folder: string[]; name: string; type: "doc" | "sheet" | "markdown" | "pdf"; share: Persona[]; body: string };

const RUNBOOK = (extraStep = "") => `<h1>Payment service runbook</h1>
<p>Owner: Alice (payments team). Escalation: #payments-incident.</p>
<h2>Symptoms</h2>
<p>Checkout errors, payment API p99 latency above 2s, connection pool saturation alerts on pay-db-1.</p>
<h2>Failover</h2>
<ol>
<li>Confirm the alert in the payments dashboard and page the on-call engineer.</li>
<li>Drain traffic from the primary database pay-db-1.</li>
<li>Promote the replica and restart the payment API pods.</li>
${extraStep}
</ol>
<h2>Rollback</h2>
<p>Disable the migration feature flag <code>tx_schema_v2</code> and redeploy the previous release.</p>`;

const FAILOVER_STEP = () =>
  `<li>Switch writes to replica pay-db-2 and confirm the pool size is at least 200 (added ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC).</li>`;

const HANDBOOK = `<h1>Incident response handbook</h1>
<p>Owner: Engineering (payments and platform teams). Applies to every production incident at Company A. Read this before your first on-call shift.</p>
<h2>Severity levels</h2>
<p><b>SEV1</b>: customers cannot pay, or card data may be exposed. Examples: checkout success rate below 90% for five minutes, the payment gateway is down, a suspected data breach. Page the incident commander immediately, at any hour.</p>
<p><b>SEV2</b>: a major feature is degraded but payments still succeed. Examples: refunds delayed, p99 latency above 2 seconds, one region failing over. Page the on-call engineer; they decide whether to escalate.</p>
<p><b>SEV3</b>: a minor feature is broken or an internal tool is down, with a workaround. Handle during working hours.</p>
<p><b>SEV4</b>: cosmetic issues and near misses. File a ticket in the PAY Jira project.</p>
<p>If you are unsure between two levels, pick the higher one. It is always fine to downgrade later.</p>
<h2>Roles</h2>
<p><b>Incident commander (IC)</b>: owns the incident from declaration to resolution. The IC does not debug; they coordinate, decide and keep the timeline. The on-call engineer is the IC until they hand over.</p>
<p><b>Communications lead</b>: posts updates to the status page and the #payments-incident channel, and briefs customer support. For SEV1 they post an update every 30 minutes, even if nothing changed.</p>
<p><b>Scribe</b>: records decisions, actions and timestamps in the incident document, so the postmortem can be written from facts.</p>
<p><b>Subject-matter experts</b>: engineers pulled in by the IC for a specific system, such as the payment database or the card processor integration.</p>
<h2>Declaring an incident</h2>
<ol>
<li>Anyone can declare an incident. Type /incident in Slack with a one-line summary and a suggested severity.</li>
<li>The bot creates a private incident channel and an incident document from the template, and pages the on-call engineer.</li>
<li>The on-call engineer acknowledges within 5 minutes for SEV1 and 15 minutes for SEV2, and becomes the incident commander.</li>
<li>The IC confirms the severity, assigns a communications lead and a scribe, and posts the first update within 15 minutes.</li>
</ol>
<h2>Communication</h2>
<p>Internal updates go to the incident channel; customer-facing updates go to the status page, approved by the communications lead. Never share customer names, card numbers or internal hostnames on the status page.</p>
<p>Update cadence: every 30 minutes for SEV1, every 60 minutes for SEV2, and at resolution for SEV3. Each update says what is affected, what we are doing, and when the next update will come.</p>
<p>Customer support gets a short script from the communications lead for SEV1 and SEV2 incidents, so they can answer tickets consistently.</p>
<h2>Payment-specific playbooks</h2>
<p><b>Card processor outage</b>: check the processor status page and our gateway error rates. If the primary processor is failing, switch traffic to the backup processor with the payments_failover feature flag. Expect a 2% higher decline rate on the backup.</p>
<p><b>Payment database saturation</b>: follow the Payment service runbook in this folder. Drain traffic from pay-db-1, promote the replica, and check the connection pool size before restoring traffic.</p>
<p><b>Fraud spike</b>: if chargeback alerts fire or card-testing traffic appears, raise the risk score threshold in the fraud service and page the risk team. Do not block whole countries without the risk team's approval.</p>
<h2>Escalation</h2>
<p>Escalate from the on-call engineer to the engineering manager after 30 minutes without a clear mitigation for SEV1, or 2 hours for SEV2. Escalate to the CTO for any suspected data breach, and involve the security team immediately. Vendor contacts and SLAs are in the Vendors folder.</p>
<h2>After the incident</h2>
<p>Every SEV1 and SEV2 incident gets a blameless postmortem within 5 working days. The IC owns it. It covers the timeline, root cause, impact in numbers, what went well, and action items.</p>
<p>Action items are filed in the PAY Jira project with an owner and a due date. The engineering manager reviews open action items every Monday.</p>
<h2>On-call expectations</h2>
<p>The on-call rota is in the Engineering folder. On-call engineers keep their laptop and phone with them, stay within 15 minutes of an internet connection, and hand over at 10:00 Singapore time on Mondays with a short note of open issues.</p>
<p>If you are paged overnight for a SEV1 or SEV2, take the next morning off. Swaps are fine; update the rota and tell your manager.</p>`;

const SLA_TEXT = `Vendor SLA agreement
Service level agreement between Company A Pte Ltd and Acme Payments Support Pte Ltd. Confidential: Company A and Acme only.
## 1. Service
Acme provides 24x7 second-line support for the Company A payment gateway, including monitoring, incident response and monthly reporting.
## 2. Availability
Acme commits to 99.9% monthly availability of the support service, measured as the share of minutes in the month when the Acme support line and ticket queue are reachable.
## 3. Response times
Priority 1 (payments failing): response within 15 minutes, updates every 30 minutes.
Priority 2 (degraded service): response within 1 hour.
Priority 3 (questions and minor issues): response within 1 business day.
## 4. Service credits
If monthly availability is below 99.9% but at least 99.0%, Company A receives a credit of 5% of that month's fee. Below 99.0%, the credit is 10%. Credits are capped at 25% of the monthly fee.
## 5. Reporting
Acme sends a monthly SLA report to the vendor-support channel by the 5th working day of the following month, covering availability, response times and all Priority 1 incidents.
## 6. Term
The agreement runs for 12 months from 1 October 2026 and renews automatically unless either party gives 60 days' written notice.
## 7. Contacts
Acme: support desk via the vendor-support channel. Company A: Carol (security) for security matters, and the payments engineering manager for everything else.`;

const FILES: SeedFile[] = [
  { folder: ["Engineering", "Runbooks"], name: "Payment service runbook", type: "doc", share: [], body: RUNBOOK() },
  {
    folder: ["Engineering", "Postmortems"],
    name: "Payment outage postmortem",
    type: "doc",
    share: ["alice", "carol"],
    body: `<h1>Payment outage postmortem</h1>
<p>Incident window: 09:40 to 11:15. Impact: 18% of checkouts failed.</p>
<h2>Root cause</h2>
<p>The database connection pool was exhausted after the migration flag tx_schema_v2 was enabled. Each request held two connections during the dual-write phase.</p>
<h2>Follow-up tickets</h2>
<ul><li>PAY-240: raise pool limits and add back-pressure.</li><li>PAY-241: alert on pool saturation above 80%.</li></ul>`,
  },
  {
    folder: ["Engineering"],
    name: "DB migration plan",
    type: "doc",
    share: ["alice", "bob", "carol"],
    body: `<h1>Transactions DB migration plan</h1>
<h2>Status</h2>
<p>Step 3 is blocked by a schema lock on the transactions table (PAY-231). Steps 1 and 2 are complete.</p>
<h2>Steps</h2>
<ol><li>Create the new schema.</li><li>Dual-write behind tx_schema_v2.</li><li>Backfill historical rows.</li><li>Switch reads and remove the old columns.</li></ol>
<h2>Rollback</h2>
<p>Turn off tx_schema_v2; the old schema stays authoritative until step 4.</p>`,
  },
  {
    folder: ["Engineering"],
    name: "On-call rota",
    type: "sheet",
    share: ["alice", "bob", "carol"],
    body: "Week,Primary,Secondary,Service\n2026-W39,Alice,Bob,payments\n2026-W40,Bob,Alice,payments\n2026-W41,Alice,Carol,payments",
  },
  {
    folder: ["Engineering"],
    name: "README.md",
    type: "markdown",
    share: ["alice", "bob", "carol"],
    body: "# Engineering handbook\n\nStart here. Runbooks live in Engineering/Runbooks, postmortems in Engineering/Postmortems.\n\n## Deploys\n\nDeploys go out Tuesday and Thursday. Payment changes need two reviewers.\n",
  },
  {
    folder: ["Security"],
    name: "Q3 breach report",
    type: "doc",
    share: ["carol"],
    body: `<h1>Q3 security incident report</h1>
<p>Classification: restricted to the security team.</p>
<h2>Summary</h2>
<p>An API key for the payment gateway was committed to a public repository and found by an external scanner. The key was rotated on 14 Aug. No fraudulent transactions were found.</p>
<h2>Open vulnerabilities</h2>
<p>CVE-2026-1234 in the auth service: patch in progress, due 30 Sep.</p>`,
  },
  {
    folder: ["Vendors"],
    name: "Vendor onboarding guide",
    type: "doc",
    share: ["carol", "dave"],
    body: `<h1>Vendor onboarding guide</h1>
<p>For contractors joining Company A projects.</p>
<h2>Access</h2>
<p>Contractors get the #vendor-support channel and this folder only. Request anything else through your Company A contact.</p>
<h2>SLA reporting</h2>
<p>Send monthly SLA reports to vendor-support by the 5th working day.</p>`,
  },
  // Long enough to be split into several chunks.
  { folder: ["Engineering", "Runbooks"], name: "Incident response handbook", type: "doc", share: [], body: HANDBOOK },
  // A real PDF, to show text extraction from stored files.
  { folder: ["Vendors"], name: "Vendor SLA agreement.pdf", type: "pdf", share: ["carol", "dave"], body: SLA_TEXT },
];

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findFile(name: string, parentId: string): Promise<string | null> {
  const r = await withRetry(() =>
    drive.files.list({ q: `name = '${q(name)}' and '${parentId}' in parents and mimeType != '${FOLDER}' and trashed = false`, fields: "files(id)" }),
  );
  return r.data.files?.[0]?.id ?? null;
}

async function ensureFolder(name: string, parentId: string): Promise<string> {
  const found = await findFolder(name, parentId);
  if (found) return found.id!;
  const r = await withRetry(() => drive.files.create({ requestBody: { name, mimeType: FOLDER, parents: [parentId] }, fields: "id" }));
  console.log(`  created folder ${name}`);
  return r.data.id!;
}

const warned = new Set<Persona>();

async function ensureShares(fileId: string, label: string, personas: Persona[], admin: string) {
  const r = await withRetry(() => drive.permissions.list({ fileId, fields: "permissions(emailAddress)" }));
  const have = new Set((r.data.permissions ?? []).map((p) => p.emailAddress?.toLowerCase()));
  for (const p of personas) {
    const email = personaEmail(p);
    if (!email) {
      if (!warned.has(p)) console.warn(`  ${p.toUpperCase()}_EMAIL is not set in .env: not sharing anything with ${p}`);
      warned.add(p);
      continue;
    }
    if (email === admin || have.has(email)) continue;
    try {
      await withRetry(() =>
        drive.permissions.create({ fileId, sendNotificationEmail: false, requestBody: { type: "user", role: "reader", emailAddress: email } }),
      );
      console.log(`  shared ${label} with ${p}`);
    } catch (e: any) {
      console.warn(`  couldn't share ${label} with ${p} (${email}): ${e?.message ?? e}`);
    }
  }
}

const MEDIA = {
  doc: ["text/html", GOOGLE_DOC],
  sheet: ["text/csv", GOOGLE_SHEET],
  markdown: ["text/markdown", "text/markdown"],
  pdf: [PDF, PDF],
} as const;

const mediaBody = (f: SeedFile) => (f.type === "pdf" ? Readable.from([textPdf(f.body)]) : f.body);

// Remove a persona's direct share on the Runbooks folder; the runbook and handbook inside lose it too.
async function revoke(persona: Persona) {
  const email = personaEmail(persona);
  if (!email) throw new Error(`${persona.toUpperCase()}_EMAIL is not set in .env`);
  const rootId = (await findFolder(driveConfig.rootFolderName, "root"))?.id;
  const eng = rootId && (await findFolder("Engineering", rootId))?.id;
  const runbooks = eng && (await findFolder("Runbooks", eng))?.id;
  if (!runbooks) throw new Error("No Company A/Engineering/Runbooks folder. Run `npm run seed:drive` first.");
  const r = await withRetry(() => drive.permissions.list({ fileId: runbooks, fields: "permissions(id,emailAddress)" }));
  const perm = r.data.permissions?.find((p) => p.emailAddress?.toLowerCase() === email);
  if (!perm) return console.log(`${persona} has no direct share on Runbooks; nothing to revoke.`);
  await withRetry(() => drive.permissions.delete({ fileId: runbooks, permissionId: perm.id! }));
  console.log(`Removed ${persona} from Engineering/Runbooks. Their next question is already filtered (live re-check);`);
  console.log("the index catches up on the next poll. Run `npm run seed:drive` to share it again.");
}

async function main() {
  const revokeIdx = process.argv.indexOf("--revoke");
  if (revokeIdx >= 0) {
    const p = process.argv[revokeIdx + 1] as Persona;
    if (!PERSONAS.includes(p)) throw new Error(`--revoke needs one of: ${PERSONAS.join(", ")}`);
    return revoke(p);
  }
  const admin = (await accountEmail())?.toLowerCase() ?? "";
  console.log(`Seeding "${driveConfig.rootFolderName}" in ${admin}'s Drive`);
  const rootId = await ensureFolder(driveConfig.rootFolderName, "root");
  const folderIds = new Map<string, string>([["", rootId]]);
  for (const f of FOLDERS) {
    const parent = folderIds.get(f.path.slice(0, -1).join("/"))!;
    const id = await ensureFolder(f.path.at(-1)!, parent);
    folderIds.set(f.path.join("/"), id);
    if (f.share) await ensureShares(id, f.path.join("/"), f.share, admin);
  }

  let runbookId = "";
  for (const f of FILES) {
    const parent = folderIds.get(f.folder.join("/"))!;
    let id = await findFile(f.name, parent);
    if (!id) {
      const [mediaType, fileType] = MEDIA[f.type];
      const r = await withRetry(() =>
        drive.files.create({ requestBody: { name: f.name, mimeType: fileType, parents: [parent] }, media: { mimeType: mediaType, body: mediaBody(f) }, fields: "id" }),
      );
      id = r.data.id!;
      console.log(`  created ${[...f.folder, f.name].join("/")}`);
    }
    await ensureShares(id, f.name, f.share, admin);
    if (f.name === "Payment service runbook") runbookId = id;
  }

  if (process.argv.includes("--edit-runbook")) {
    await withRetry(() => drive.files.update({ fileId: runbookId, media: { mimeType: "text/html", body: RUNBOOK(FAILOVER_STEP()) } }));
    console.log("  runbook updated: new failover step added (the next poll should pick it up)");
  }
  console.log(`Done. Root folder ID: ${rootId}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(explain(e));
    process.exit(1);
  });
