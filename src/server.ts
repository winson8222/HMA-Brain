import { App, LogLevel } from "@slack/bolt";
import express from "express";
import { config, requireEnv } from "./config.js";
import { channelPrincipal, wsMemberPrincipal } from "./acl.js";
import { ensureIndex, es, INDEX } from "./es.js";
import { registerEvents, status } from "./events.js";
import { getAccess } from "./principals.js";
import { ask } from "./ask.js";
import { auditRouter } from "./audit/routes.js";
import { llmConfigured } from "./llm.js";
import { auditLog, search } from "./search.js";
import { cachedChannels, displayName, getWorkspace, isHuman, listChannels, listUsers } from "./slack.js";
import { reconcileChannels } from "./sync.js";

// ---- Slack live sync (Socket Mode: no public URL needed) ----
// With SLACK_SYNC=off the server only serves queries; another server does the ingesting.
const slackApp = config.slackSync
  ? new App({
      token: requireEnv("SLACK_BOT_TOKEN"),
      appToken: requireEnv("SLACK_APP_TOKEN"),
      socketMode: true,
      ignoreSelf: false, // seeded messages are posted by our own bot and must still be indexed
      logLevel: LogLevel.WARN,
    })
  : null;
if (slackApp) registerEvents(slackApp);

// ---- Google Drive: API + Connect (when the Google app is configured), sync (when DRIVE_SYNC=on) ----
// Loaded only when configured, so the server still runs without Google credentials.
const driveConfigured =
  /\.apps\.googleusercontent\.com$/.test(process.env.GOOGLE_CLIENT_ID ?? "") && !!process.env.GOOGLE_CLIENT_SECRET && !process.env.GOOGLE_CLIENT_SECRET.endsWith("...");
const driveRoutes = driveConfigured ? await import("./connectors/drive/routes.js") : null;
const drive = driveConfigured && process.env.DRIVE_SYNC === "on" ? await import("./connectors/drive/sync.js") : null;

// ---- HTTP API + UI ----
const web = express();
web.use(express.json());
web.use(express.static("public"));
web.use(auditRouter); // tamper-evident audit log, admin only (Drive writes to it)
if (driveRoutes) web.use(driveRoutes.driveRouter); // Drive Search/Ask on /drive.html

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      console.error(e);
      res.status(500).json({ error: String(e?.message ?? e) });
    });

// Demo only: the UI picks "who am I". A real deployment would use Slack sign-in.
web.get(
  "/api/users",
  wrap(async (_req, res) => {
    const { teamId } = await getWorkspace();
    const names = new Map(cachedChannels().map((c) => [channelPrincipal(c.id), c]));
    const users = (await listUsers()).filter(isHuman);
    res.json(
      await Promise.all(
        users.map(async (u) => {
          const a = await getAccess(u.id);
          return {
            id: u.id,
            name: displayName(u),
            isGuest: a.isGuest,
            access: a.principals
              .filter((p) => !p.startsWith("slack:user:"))
              .map((p) =>
                p === wsMemberPrincipal(teamId)
                  ? { label: "all public channels", private: false }
                  : { label: "#" + (names.get(p)?.name ?? p), private: !!names.get(p)?.is_private },
              ),
          };
        }),
      ),
    );
  }),
);

web.post(
  "/api/search",
  wrap(async (req, res) => {
    const { userId, q } = req.body ?? {};
    if (!userId || !q) return res.status(400).json({ error: "userId and q are required" });
    const results = await search(String(userId), String(q));
    // Identical shape whether nothing matched or everything matching was restricted.
    res.json(results.length ? { results } : { results, message: "No results found" });
  }),
);

web.post(
  "/api/ask",
  wrap(async (req, res) => {
    const { userId, q } = req.body ?? {};
    if (!userId || !q) return res.status(400).json({ error: "userId and q are required" });
    res.json(await ask(String(userId), String(q)));
  }),
);

web.get("/api/log", (_req, res) => {
  res.json(auditLog);
});

web.get(
  "/api/status",
  wrap(async (_req, res) => {
    const { count } = await es.count({ index: INDEX });
    res.json({
      indexedMessages: count,
      llm: llmConfigured() ? process.env.LLM_MODEL : null,
      ...status,
      ...(drive ? { drive: drive.driveStatus } : {}),
    });
  }),
);

// ---- start ----
await ensureIndex();
await listChannels();
if (slackApp) {
  await slackApp.start();
  setInterval(() => reconcileChannels().catch(console.error), 5 * 60_000);
}
if (drive) {
  await drive.loadStatus();
  drive.startPolling();
}
web.listen(config.port, () => {
  const sync = slackApp ? "live Slack sync on" : "live Slack sync OFF (SLACK_SYNC=off): run `npm run backfill` for new messages";
  const driveSync = drive ? `, Drive polling every ${process.env.DRIVE_POLL_SECONDS || 60}s` : "";
  if (driveRoutes) console.log(`Drive Search/Ask: http://localhost:${config.port}/drive.html`);
  console.log(`Internal Brain demo on http://localhost:${config.port} (${sync}${driveSync})`);
});
