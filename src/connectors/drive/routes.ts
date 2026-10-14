// Drive's HTTP API: sync status (shown on the main page) and "Sync now" (Connections page).
// Mounted by server.ts when the Google app is configured in .env. The crawler is connected
// with `npm run drive:connect`; Drive Search/Ask runs through the connector registry.
import express from "express";
import { wrap as sharedWrap } from "../../http.js";
import { llmConfigured } from "../../llm.js";
import { getSession } from "../../session.js";
import { accountEmail, explain, isConnected } from "./client.js";
import { getConnector } from "./store.js";
import { driveStatus, loadStatus, pollOnce, summary } from "./sync.js";
import { recordAudit } from "../../audit/record.js";

export const driveRouter = express.Router();

type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;
const wrap = (fn: Handler) => sharedWrap(fn, explain);

async function adminEmail(): Promise<string | null> {
  const conn = await getConnector().catch(() => undefined);
  if (conn?.account_email) return conn.account_email.toLowerCase();
  return isConnected() ? accountEmail().catch(() => null) : null;
}

driveRouter.get(
  "/api/drive/status",
  wrap(async (_req, res) => {
    if (!driveStatus.polling) await loadStatus().catch(() => {}); // no poller keeping it current
    const admin = await adminEmail();
    // Only things that are broken right now. Demo-setup advice (admin is a persona, Carol unset) is in drive:doctor.
    const warnings: string[] = [];
    if (!isConnected()) warnings.unshift("Google Drive isn't connected. An admin needs to run `npm run drive:connect`.");
    else if (driveStatus.authError) warnings.unshift("The Google token expired or was revoked. An admin needs to run `npm run drive:connect` again.");
    if (!driveStatus.polling) warnings.push("Polling is off (DRIVE_SYNC=off), so Drive changes show up only after `npm run drive:poll` or Sync now.");
    res.json({ ...driveStatus, connected: isConnected(), account: driveStatus.account ?? admin, llm: llmConfigured() ? process.env.LLM_MODEL : null, warnings });
  }),
);

// "Sync now": apply Drive's changes immediately instead of waiting for the next poll (handy in a demo).
let lastManualSync = 0;
driveRouter.post(
  "/api/drive/sync",
  wrap(async (req, res) => {
    if (Date.now() - lastManualSync < 5000) return res.json({ skipped: "just synced" });
    lastManualSync = Date.now();
    const counts = await pollOnce({ force: true }); // "Sync now" doesn't wait for files being edited
    // Anyone on the Connections page may press it, so the actor is whoever is signed in.
    await recordAudit({
      kind: "admin",
      actor: getSession(req) ?? "anonymous",
      via: "web",
      action: "sync_now",
      detail: { source: "drive" },
      result: counts ? summary(counts) : "skipped: a sync is already running",
    });
    res.json(counts ? { counts } : { skipped: "a sync is already running" });
  }),
);
