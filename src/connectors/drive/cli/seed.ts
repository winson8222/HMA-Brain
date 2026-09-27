// npm run seed:drive [-- --edit-runbook] — creates the demo "Company A" folder in the admin's Drive and shares
// it with the personas, mirroring the Slack storyline. Writes only to Drive (the crawler picks it up).
// Safe to re-run: existing folders and files are found by name, and only missing shares are added.
// --edit-runbook: adds a failover step to the runbook, to show an update reaching the index (scenario S2).
import { accountEmail, drive, findFolder, withRetry } from "../client.js";
import { driveConfig } from "../config.js";
import { FOLDER, GOOGLE_DOC, GOOGLE_SHEET } from "../extract.js";

type Persona = "alice" | "bob" | "carol" | "dave";
const EMAILS: Record<Persona, string | undefined> = {
  alice: process.env.ALICE_EMAIL,
  bob: process.env.BOB_EMAIL,
  carol: process.env.CAROL_EMAIL,
  dave: process.env.DAVE_EMAIL,
};

// Folder shares are inherited by everything inside (e.g. the runbook is visible to Bob and Carol via its folder).
const FOLDERS: { path: string[]; share?: Persona[] }[] = [
  { path: ["Engineering"] },
  { path: ["Engineering", "Runbooks"], share: ["bob", "carol"] },
  { path: ["Engineering", "Postmortems"] },
  { path: ["Security"] },
  { path: ["Vendors"] },
];

type SeedFile = { folder: string[]; name: string; type: "doc" | "sheet" | "markdown"; share: Persona[]; body: string };

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

const FILES: SeedFile[] = [
  { folder: ["Engineering", "Runbooks"], name: "Payment service runbook", type: "doc", share: [], body: RUNBOOK() },
  {
    folder: ["Engineering", "Postmortems"],
    name: "Payment outage postmortem",
    type: "doc",
    share: ["carol"],
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
    share: ["bob", "carol"],
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
    share: ["bob", "carol"],
    body: "Week,Primary,Secondary,Service\n2026-W39,Alice,Bob,payments\n2026-W40,Bob,Alice,payments\n2026-W41,Alice,Carol,payments",
  },
  {
    folder: ["Engineering"],
    name: "README.md",
    type: "markdown",
    share: ["bob", "carol"],
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

async function ensureShares(fileId: string, label: string, personas: Persona[], admin: string) {
  const r = await withRetry(() => drive.permissions.list({ fileId, fields: "permissions(emailAddress)" }));
  const have = new Set((r.data.permissions ?? []).map((p) => p.emailAddress?.toLowerCase()));
  for (const p of personas) {
    const email = EMAILS[p]?.toLowerCase();
    if (!email || email.endsWith("...") || email === "you@gmail.com") {
      console.warn(`  skip sharing ${label} with ${p}: ${p.toUpperCase()}_EMAIL is not set in .env`);
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

const MEDIA = { doc: ["text/html", GOOGLE_DOC], sheet: ["text/csv", GOOGLE_SHEET], markdown: ["text/markdown", "text/markdown"] } as const;

async function main() {
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
        drive.files.create({ requestBody: { name: f.name, mimeType: fileType, parents: [parent] }, media: { mimeType: mediaType, body: f.body }, fields: "id" }),
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
    console.error(e?.message ?? e);
    process.exit(1);
  });
