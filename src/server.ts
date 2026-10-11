import { App, LogLevel } from "@slack/bolt";
import express from "express";
import { config } from "./config.js";
import { recordAudit, recordBackfill } from "./audit/record.js";
import { backfillUserDms, cleanupAfterDisconnect, personIdOfToken, userClient } from "./dms.js";
import { ensureIndex, es, INDEX } from "./es.js";
import { registerEvents, status } from "./events.js";
import { embeddingConfigured } from "./embeddings.js";
import { resolveMultiQuery, resolveRetrievalMode, resolveRerank } from "./hybrid.js";
import { auditRouter } from "./audit/routes.js";
import { accessSummary } from "./access.js";
import { llmConfigured } from "./llm.js";
import { authorizeUrl, canConnect, completeConnect } from "./oauth.js";
import { findPerson, getAccess, listPeople } from "./people.js";
import { asker, HttpError, wrap } from "./http.js";
import { confluenceConfigured, connectors, driveConfigured, jiraConfigured } from "./connectors/index.js";
import { ask, search, UnknownSourceError } from "./federated.js";
import { clearSession, getSession, setSession } from "./session.js";
import { workspaceByKey, workspaces } from "./slack.js";
import { reconcileChannels } from "./sync.js";
import { removeUserToken, userTokens } from "./tokens.js";

const wss = await workspaces();

// ---- Slack live sync: one Socket Mode connection per workspace (no public URL needed) ----
// With SLACK_SYNC=off the server only serves queries; another server does the ingesting.
const slackApps = config.slackSync
  ? wss
      .filter((ws) => ws.creds.appToken)
      .map((ws) => {
        const app = new App({
          token: ws.creds.botToken,
          appToken: ws.creds.appToken,
          socketMode: true,
          ignoreSelf: false, // seeded messages are posted by our own bot and must still be indexed
          logLevel: LogLevel.WARN,
        });
        registerEvents(app, ws);
        return { app, ws };
      })
  : [];

// ---- Google Drive: API + Connect (when the Google app is configured), sync (when DRIVE_SYNC=on) ----
// Loaded only when configured, so the server still runs without Google credentials.
const driveRoutes = driveConfigured ? await import("./connectors/drive/routes.js") : null;
const drive = driveConfigured && process.env.DRIVE_SYNC === "on" ? await import("./connectors/drive/sync.js") : null;
// ---- Jira: searched through the connector registry; polled here when JIRA_SYNC=on ----
const jiraRoutes = jiraConfigured ? await import("./connectors/jira/routes.js") : null;
const jira = jiraConfigured && process.env.JIRA_SYNC === "on" ? await import("./connectors/jira/sync.js") : null;
// ---- Confluence: same site and link as Jira; polled here when CONFLUENCE_SYNC=on ----
const confluence = confluenceConfigured && process.env.CONFLUENCE_SYNC === "on" ? await import("./connectors/confluence/sync.js") : null;

// ---- HTTP API + UI ----
const web = express();
web.use(express.json());
web.use(express.static("public"));
web.use(auditRouter); // tamper-evident audit log, admin only (Drive writes to it)
if (driveRoutes) web.use(driveRoutes.driveRouter); // Drive Search/Ask on /drive.html
if (jiraRoutes) web.use(jiraRoutes.jiraRouter); // Connect Jira on /connect.html

async function describePerson(personId: string) {
  const p = await findPerson(personId);
  const a = await getAccess(personId);
  return {
    id: personId,
    name: p?.name ?? personId,
    email: p?.email,
    workspaces: a.workspaces.map((w) => {
      const ws = wss.find((x) => x.teamId === w.teamId)!;
      const items = w.channelIds
        .map((id) => ws.cached(id))
        .filter((c) => c)
        .map((c) => ({ label: "#" + c!.name, private: c!.is_private }));
      return {
        workspace: w.teamName,
        isGuest: w.isGuest,
        items: w.isGuest ? items : [{ label: "all public channels", private: false }, ...items],
      };
    }),
  };
}

web.get("/api/config", (_req, res) => {
  res.json({ allowImpersonation: config.allowImpersonation });
});

web.get(
  "/api/me",
  wrap(async (req, res) => {
    const me = getSession(req);
    if (!me) return res.json({ signedIn: false });
    const mine = userTokens().filter((t) => personIdOfToken(t) === me);
    res.json({
      signedIn: true,
      ...(await describePerson(me)),
      connections: wss.map((ws) => ({
        teamId: ws.teamId,
        workspace: ws.teamName,
        connected: mine.some((t) => t.teamId === ws.teamId),
      })),
    });
  }),
);

web.post("/api/signout", (_req, res) => {
  clearSession(res); // keeps their Slack token; Disconnect is separate
  res.json({ ok: true });
});

// The people the UI may act as. With impersonation off, only yourself.
web.get(
  "/api/users",
  wrap(async (req, res) => {
    if (!config.allowImpersonation) {
      const me = getSession(req);
      return res.json(me ? [await describePerson(me)] : []);
    }
    const people = await listPeople({ refresh: true });
    res.json(await Promise.all(people.map((p) => describePerson(p.id))));
  }),
);

// Which sources a person can search. The UI shows one checkbox per connector.
web.get("/api/connectors", (_req, res) => {
  res.json(connectors.map((c) => ({ name: c.name, label: c.label })));
});

// Search/Ask over the chosen connectors (body.sources, e.g. ["slack","drive"]; default: all of them).
function query(req: express.Request) {
  const { personId, mode } = asker(req);
  const q = String(req.body?.q ?? "");
  if (!q) throw new HttpError(400, "q is required");
  return { personId, mode, q, sources: req.body?.sources };
}
const badSources = (e: unknown) => {
  throw e instanceof UnknownSourceError ? new HttpError(400, e.message) : e;
};

web.post(
  "/api/search",
  wrap(async (req, res) => {
    const { personId, mode, q, sources } = query(req);
    const out = await search(personId, q, mode, sources).catch(badSources);
    // Identical shape whether nothing matched or everything matching was restricted.
    res.json(out.results.length ? out : { ...out, message: "No results found" });
  }),
);

web.post(
  "/api/ask",
  wrap(async (req, res) => {
    const { personId, mode, q, sources } = query(req);
    res.json(await ask(personId, q, mode, sources).catch(badSources));
  }),
);

// Drive files and Jira projects a person can see, for the access chips. Same "who is asking" rules as Search.
web.post(
  "/api/access",
  wrap(async (req, res) => {
    const { personId } = asker(req);
    res.json(await accessSummary(personId));
  }),
);

web.get(
  "/api/status",
  wrap(async (_req, res) => {
    const { count } = await es.count({ index: INDEX });
    res.json({
      indexedMessages: count,
      workspaces: wss.map((w) => w.teamName),
      liveSync: slackApps.length > 0,
      llm: llmConfigured() ? process.env.LLM_MODEL : null,
      retrievalMode: resolveRetrievalMode(),
      rerank: resolveRerank(),
      multiQuery: resolveMultiQuery() || null,
      embeddings: embeddingConfigured() ? process.env.EMBEDDING_MODEL : null,
      ...status,
      ...(drive ? { drive: drive.driveStatus } : {}),
      ...(jira ? { jira: jira.jiraStatus } : {}),
      ...(confluence ? { confluence: confluence.confluenceStatus } : {}),
    });
  }),
);

// ---- Connect (sign in + grant DM access) ----

web.get("/connect", (_req, res) => res.redirect("/connect.html"));

web.get(
  "/api/connections",
  wrap(async (_req, res) => {
    const people = await listPeople();
    res.json(
      wss.map((ws) => ({
        key: ws.key,
        workspace: ws.teamName,
        canConnect: canConnect(ws),
        connected: userTokens(ws.teamId).map((t) => people.find((p) => p.id === personIdOfToken(t))?.name ?? t.email ?? t.userId),
      })),
    );
  }),
);

web.get(
  "/slack/oauth/start",
  wrap(async (req, res) => {
    const ws = await workspaceByKey(String(req.query.ws));
    if (!ws || !canConnect(ws)) throw new HttpError(400, "This workspace has no clientId/clientSecret in slack-tokens.json");
    res.redirect(authorizeUrl(ws));
  }),
);

web.get("/slack/oauth/callback", async (req, res) => {
  const back = (q: Record<string, string>) => res.redirect(`/connect.html?${new URLSearchParams(q)}`);
  if (req.query.error) return back({ error: `Slack said: ${req.query.error}` });
  try {
    const { ws, token } = await completeConnect(String(req.query.code), String(req.query.state));
    setSession(res, personIdOfToken(token));
    await recordAudit({ kind: "account", actor: personIdOfToken(token), via: "web", source: "slack", action: "connect", account: `${ws.teamName} (${token.userId})` });
    const n = await backfillUserDms(ws, token);
    console.log(`connected ${token.email ?? token.userId} in ${ws.teamName}, indexed ${n} DM messages`);
    await recordBackfill("slack", "event", n, `Slack ${ws.teamName}: DMs of ${personIdOfToken(token)} after connecting, ${n} messages`);
    back({ connected: ws.teamName });
  } catch (e: any) {
    console.error(e);
    back({ error: e?.message ?? String(e) });
  }
});

// Revoke your token in one workspace and drop DMs no connected participant still allows.
web.post(
  "/api/disconnect",
  wrap(async (req, res) => {
    const me = getSession(req);
    if (!me) throw new HttpError(401, "Not signed in");
    const ws = wss.find((w) => w.teamId === req.body?.teamId);
    if (!ws) throw new HttpError(400, "Unknown workspace");
    let removed = 0;
    for (const t of userTokens(ws.teamId).filter((t) => personIdOfToken(t) === me)) {
      await userClient(t).auth.revoke().catch(() => {}); // already revoked is fine
      removeUserToken(t.teamId, t.userId);
      removed += await cleanupAfterDisconnect(ws, me);
      await recordAudit({ kind: "account", actor: me, via: "web", source: "slack", action: "disconnect", account: `${ws.teamName} (${t.userId})` });
    }
    res.json({ ok: true, removedConversations: removed });
  }),
);

// ---- start ----
await ensureIndex();
for (const ws of wss) await ws.listChannels();
for (const { app, ws } of slackApps) {
  await app.start();
  setInterval(() => reconcileChannels(ws).catch(console.error), 5 * 60_000);
}
if (drive) {
  await drive.loadStatus();
  drive.startPolling();
}
if (jira) {
  await jira.loadStatus();
  jira.startPolling();
}
if (confluence) {
  await confluence.loadStatus();
  confluence.startPolling();
}
if (config.sessionSecretIsRandom) console.warn("SESSION_SECRET not set: everyone is signed out when the server restarts.");
web.listen(config.port, (err?: Error) => {
  if (err) {
    // e.g. EADDRINUSE: another copy of the server is still running on this port.
    console.error(`Can't start on port ${config.port}: ${err.message}. Is another copy of the server still running?`);
    process.exit(1);
  }
  const sync = slackApps.length
    ? `live Slack sync on for ${slackApps.map((s) => s.ws.teamName).join(", ")}`
    : "live Slack sync OFF: run `npm run backfill` for new messages";
  const driveSync =
    (drive ? `; Drive polling every ${process.env.DRIVE_POLL_SECONDS || 60}s` : "") +
    (jira ? `; Jira polling every ${process.env.JIRA_POLL_SECONDS || 60}s` : "") +
    (confluence ? `; Confluence polling every ${process.env.CONFLUENCE_POLL_SECONDS || 60}s` : "");
  if (driveRoutes) console.log(`Drive Search/Ask: ${config.publicUrl}/drive.html`);
  console.log(`HMA Brain on ${config.publicUrl} (${sync}; workspaces: ${wss.map((w) => w.teamName).join(", ")}${driveSync})`);
});
