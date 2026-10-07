// npm run confluence:backfill [-- --reset] — index every in-scope space, and drop deleted pages.
// Safe to re-run: unchanged pages are skipped. --reset rebuilds the Confluence indexes only.
import { explain } from "../client.js";
import { backfill, confluenceStatus, summary } from "../sync.js";

const reset = process.argv.includes("--reset");
console.log(reset ? "Resetting the Confluence indexes, then backfilling..." : "Backfilling Confluence (unchanged pages are skipped)...");
const started = Date.now();
try {
  const counts = await backfill({ reset });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${summary(counts)}`);
  console.log(`Index now has ${confluenceStatus.chunks} chunks from ${confluenceStatus.spaces.join(", ") || "no spaces"} on ${confluenceStatus.site}.`);
  process.exit(counts.error ? 1 : 0);
} catch (e) {
  console.error(explain(e));
  process.exit(1);
}
