// npm run drive:poll [-- --watch] — apply Drive changes since the last run (once, or every DRIVE_POLL_SECONDS).
// A single run applies everything now; --watch waits for edited files to be quiet (DRIVE_QUIET_SECONDS), like the server.
// The server does the same when DRIVE_SYNC=on; this is for running without the server.
import { explain } from "../client.js";
import { driveConfig } from "../config.js";
import { driveStatus, pollOnce, summary } from "../sync.js";

const watch = process.argv.includes("--watch");

async function once() {
  const counts = await pollOnce({ force: !watch });
  if (!counts) return;
  const lag = driveStatus.lastRun?.maxLagSeconds;
  console.log(`${new Date().toLocaleTimeString()}  ${summary(counts)}${lag != null ? ` (max lag ${lag}s)` : ""}`);
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

console.log(`Polling Drive every ${driveConfig.pollSeconds}s. Ctrl+C to stop.`);
for (;;) {
  try {
    await once();
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString()}  ${explain(e)}`);
  }
  await new Promise((r) => setTimeout(r, driveConfig.pollSeconds * 1000));
}
