// npm run backfill — rebuild the index from Slack.
import { resetIndex } from "./es.js";
import { backfillAll } from "./sync.js";

await resetIndex();
console.log("Index reset. Backfilling from Slack...");
await backfillAll();
console.log("Backfill done.");
