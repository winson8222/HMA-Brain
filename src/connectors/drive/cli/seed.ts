// npm run seed:drive [-- <flag>]: builds the demo "Company A" folder in the admin's Drive from seedContent.ts
// and shares it with the personas. Writes only to Drive (the crawler picks it up). Safe to re-run: folders and
// files are found by name, and missing shares are added back (which also undoes --close-vendor-access).
//   --edit-runbook          S2: the runbook owner's update (pay-db-2 retired, promote pay-db-3, pool at least 400)
//   --close-vendor-access   S4: remove Dave's share on the postmortem
//   --reset                 between rehearsals: runbook back to the original, every share restored
//   --rewrite               rewrite every file from seedContent.ts (after editing the content)
import { accountEmail, explain } from "../client.js";
import { closeVendorAccess, seed, setRunbook, sgtNow } from "./seedOps.js";

async function main() {
  const has = (flag: string) => process.argv.includes(flag);
  if (has("--edit-runbook")) {
    await setRunbook(sgtNow());
    return console.log("Runbook updated: pay-db-2 retired, failover to pay-db-3, pool at least 400.");
  }
  if (has("--close-vendor-access")) return closeVendorAccess();
  await seed((await accountEmail())?.toLowerCase() ?? "", has("--rewrite"));
  if (has("--reset")) {
    await setRunbook();
    console.log("Runbook back to the original (pay-db-2, pool 200).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(explain(e));
    process.exit(1);
  });
