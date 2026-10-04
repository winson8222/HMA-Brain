// npm run jira:backfill [-- --reset] — index every in-scope Jira project, and drop deleted issues.
// Safe to re-run: unchanged issues are skipped. --reset rebuilds the Jira indexes only (Slack's and Drive's are untouched).
import { explain } from "../client.js";
import { backfill, jiraStatus, summary } from "../sync.js";

const reset = process.argv.includes("--reset");
console.log(reset ? "Resetting the Jira indexes, then backfilling..." : "Backfilling Jira (unchanged issues are skipped)...");
const started = Date.now();
try {
  const counts = await backfill({ reset });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${summary(counts)}`);
  console.log(`Index now has ${jiraStatus.chunks} chunks from ${jiraStatus.projects.join(", ") || "no projects"} on ${jiraStatus.site}.`);
  process.exit(counts.error ? 1 : 0);
} catch (e) {
  console.error(explain(e));
  process.exit(1);
}
