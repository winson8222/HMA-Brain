// npm run jira:poll [-- --watch] — apply Jira changes (issues and permissions) since the last run.
// The server does the same when JIRA_SYNC=on; this is for running without the server.
import { explain } from "../client.js";
import { jiraConfig } from "../config.js";
import { pollOnce, summary } from "../sync.js";

const watch = process.argv.includes("--watch");

async function once() {
  const counts = await pollOnce();
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

console.log(`Polling Jira every ${jiraConfig.pollSeconds}s. Ctrl+C to stop.`);
for (;;) {
  try {
    await once();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  ${explain(e)}`);
  }
  await new Promise((r) => setTimeout(r, jiraConfig.pollSeconds * 1000));
}
