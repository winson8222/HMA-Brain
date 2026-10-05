// npm run drive:backfill [-- --reset] — index everything under the Company A folder.
// Safe to re-run: unchanged files are skipped. --reset rebuilds the Drive indexes only (Slack's are untouched).
import { explain } from "../client.js";
import { backfill, driveStatus, summary } from "../sync.js";

const reset = process.argv.includes("--reset");
console.log(reset ? "Resetting the Drive indexes, then backfilling..." : "Backfilling Drive (unchanged files are skipped)...");
const started = Date.now();
try {
  const counts = await backfill({ reset });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${summary(counts)}`);
  console.log(`Index now has ${driveStatus.files} files (${driveStatus.chunks} chunks) from "${driveStatus.rootFolder}", read as ${driveStatus.account}.`);
  process.exit(counts.error ? 1 : 0);
} catch (e) {
  console.error(explain(e));
  process.exit(1);
}
