// npm run drive:poll [-- --watch] — apply Drive changes since the last run (once, or every DRIVE_POLL_SECONDS).
// The server does the same when DRIVE_SYNC=on; this is for running without the server.
import { explain } from "../client.js";
import { driveConfig } from "../config.js";
import { driveStatus, pollOnce, summary } from "../sync.js";

async function once() {
  const counts = await pollOnce();
  if (!counts) return;
  const lag = driveStatus.lastRun?.maxLagSeconds;
  console.log(`${new Date().toLocaleTimeString()}  ${summary(counts)}${lag != null ? ` (max lag ${lag}s)` : ""}`);
}

if (!process.argv.includes("--watch")) {
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
