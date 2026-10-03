// npm run seed:drive [-- <flag>]: builds the demo "Company A" folder in the admin's Drive from seedContent.ts
// and shares it with the personas. Writes only to Drive (the crawler picks it up). Safe to re-run: folders and
// files are found by name, and missing shares are added back (which also undoes --close-vendor-access).
// Files that belong to a later story day are skipped; `npm run seed:story` creates them on their day.
//   --edit-runbook          S2: the runbook owner's update (pay-db-2 retired, promote pay-db-3, pool at least 400)
//   --close-vendor-access   S4: remove Dave's share on the postmortem
//   --reset                 between rehearsals: runbook back to the original, every share restored
//   --batch 0|1|2|4         set the DB migration plan's status (0 before the outage, 1 paused, 2 resumed, 4 late Oct)
//   --rewrite               rewrite every file from seedContent.ts (their latest versions)
import { accountEmail, explain } from "../client.js";
import { closeVendorAccess, seed, setMigrationStage, setRunbook, sgtNow } from "./seedOps.js";
import { MIGRATION_STAGES } from "./seedContent.js";

async function main() {
  const has = (flag: string) => process.argv.includes(flag);
  if (has("--edit-runbook")) {
    await setRunbook({ editedAt: sgtNow() });
    return console.log("Runbook updated: pay-db-2 retired, failover to pay-db-3, pool at least 400.");
  }
  if (has("--close-vendor-access")) return closeVendorAccess();
  const b = process.argv.indexOf("--batch");
  if (b >= 0) {
    const stage = Number(process.argv[b + 1]);
    if (!MIGRATION_STAGES.includes(stage)) throw new Error(`--batch needs one of: ${MIGRATION_STAGES.join(", ")}`);
    await setMigrationStage(stage);
    return console.log(`DB migration plan status set to stage ${stage}.`);
  }
  await seed((await accountEmail())?.toLowerCase() ?? "", has("--rewrite"));
  if (has("--reset")) {
    await setRunbook("after");
    console.log("Runbook back to the original (pay-db-2, pool 200).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(explain(e));
    process.exit(1);
  });
