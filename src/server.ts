import { App, LogLevel } from "@slack/bolt";
import express from "express";
import { ask } from "./ask.js";
import { config } from "./config.js";
import { backfillUserDms, cleanupAfterDisconnect, personIdOfToken, userClient } from "./dms.js";
import { ensureIndex, es, INDEX } from "./es.js";
import { registerEvents, status } from "./events.js";
import { llmConfigured } from "./llm.js";
import { authorizeUrl, canConnect, completeConnect } from "./oauth.js";
import { findPerson, getAccess, listPeople } from "./people.js";
import { auditLog, search, type AskMode } from "./search.js";
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

// ---- HTTP API + UI ----
const web = express();
web.use(express.json());
web.use(express.static("public"));

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      if (!(e instanceof HttpError)) console.error(e);
      res.status(e instanceof HttpError ? e.status : 500).json({ error: String(e?.message ?? e) });
    });

// Who is asking. Me mode: only the signed-in cookie counts, never the request body.
// Demo mode (ALLOW_IMPERSONATION=on): the UI may pick any person, for the side-by-side compare.
function asker(req: express.Request): { personId: string; mode: AskMode } {
  const { personId, asMe } = req.body ?? {};
  if (asMe || !config.allowImpersonation) {
    const me = getSession(req);
    if (!me) throw new HttpError(401, "Sign in first: open the Connect page and connect your Slack.");
    return { personId: me, mode: "me" };
  }
  if (!personId) throw new HttpError(400, "personId is required");
  return { personId: String(personId), mode: "demo" };
}

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

web.post(
  "/api/search",
  wrap(async (req, res) => {
    const { personId, mode } = asker(req);
    const q = String(req.body?.q ?? "");
    if (!q) throw new HttpError(400, "q is required");
    const results = await search(personId, q, mode);
    // Identical shape whether nothing matched or everything matching was restricted.
    res.json(results.length ? { results } : { results, message: "No results found" });
  }),
);

web.post(
  "/api/ask",
  wrap(async (req, res) => {
    const { personId, mode } = asker(req);
    const q = String(req.body?.q ?? "");
    if (!q) throw new HttpError(400, "q is required");
    res.json(await ask(personId, q, mode));
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
      workspaces: wss.map((w) => w.teamName),
      liveSync: slackApps.length > 0,
      llm: llmConfigured() ? process.env.LLM_MODEL : null,
      ...status,
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
    const n = await backfillUserDms(ws, token);
    console.log(`connected ${token.email ?? token.userId} in ${ws.teamName}, indexed ${n} DM messages`);
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
  console.log(`HMA Brain on ${config.publicUrl} (${sync}; workspaces: ${wss.map((w) => w.teamName).join(", ")})`);
});
