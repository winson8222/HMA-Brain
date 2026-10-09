// npm run confluence:poll [-- --watch | --sweep] — apply Confluence changes since the last run.
// The server does the same when CONFLUENCE_SYNC=on; this is for running without the server.
import { explain } from "../client.js";
import { confluenceConfig } from "../config.js";
import { pollOnce, summary, sweep } from "../sync.js";

const watch = process.argv.includes("--watch");
const doSweep = process.argv.includes("--sweep");

async function once() {
  const counts = doSweep ? await sweep() : await pollOnce();
  if (counts) console.log(`${new Date().toLocaleTimeString()}  ${summary(counts)}`);
}

if (!watch) {
  try {
    await once();
    process.exit(0);
  } catch (e) {
    console.error(explain(e));
    process.exit(1);
  }
}

console.log(`Polling Confluence every ${confluenceConfig.pollSeconds}s. Ctrl+C to stop.`);
for (;;) {
  try {
    await once();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  ${explain(e)}`);
  }
  await new Promise((r) => setTimeout(r, confluenceConfig.pollSeconds * 1000));
}
