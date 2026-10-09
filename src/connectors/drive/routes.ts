// Drive's HTTP API (used by public/drive.html) and the in-app "Connect Google Drive" flow.
// Mounted by server.ts when the Google app is configured in .env.
import express from "express";
import { randomBytes } from "node:crypto";
import { requireAdmin } from "../../admin.js";
import { config } from "../../config.js";
import { es } from "../../es.js";
import { asker as sharedAsker, HttpError, wrap as sharedWrap } from "../../http.js";
import { llmConfigured } from "../../llm.js";
import { getSession } from "../../session.js";
import { driveKeysFor } from "./acl.js";
import { newOAuthClient, saveToken, SCOPES } from "./auth.js";
import { accountEmail, explain, isConnected, loadToken } from "./client.js";
import { driveConfig } from "./config.js";
import { demoPeople, findPerson, isRealEmail, type Person } from "./people.js";
import { driveAsk, driveSearch } from "./query.js";
import { ensureDriveIndices, getConnector } from "./store.js";
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

async function people(): Promise<Person[]> {
  return demoPeople(await adminEmail());
}

// Me mode: the signed-in person, by their email. A person with no email (a workspace-scoped Slack ID)
// has no Google identity, so they get no Drive access: fail closed.
function signedInPerson(personId: string): Person {
  if (!isRealEmail(personId)) throw new HttpError(403, "Your account has no email, so it can't be matched to Google Drive.");
  return { name: personId, email: personId.toLowerCase(), admin: false, role: "" };
}

// Same rules as Slack's /api/search: Me mode takes identity only from the login cookie, and picking
// another person (Demo mode) is allowed only with ALLOW_IMPERSONATION=on, from the demo people.
async function asker(req: express.Request): Promise<{ person: Person; q: string }> {
  const { personId, mode } = sharedAsker(req, "email");
  const q = req.body?.q;
  if (typeof q !== "string" || !q.trim()) throw new HttpError(400, "q is required");
  const person = mode === "me" ? signedInPerson(personId) : findPerson(personId, await people());
  if (!person) throw new HttpError(400, "email must be one of the demo people");
  return { person, q: q.trim().slice(0, 500) };
}

// The file names each person can see, for the chips under the picker (their own access only).
async function visibleTitles(email: string): Promise<string[]> {
  const r = await es.search({
    index: driveConfig.index,
    size: 0,
    query: { bool: { filter: [{ terms: { acl_container: driveKeysFor(email) } }] } },
    aggs: { titles: { terms: { field: "title.keyword", size: 50, order: { _key: "asc" } } } },
  });
  return ((r.aggregations?.titles as any)?.buckets ?? []).map((b: any) => String(b.key));
}

driveRouter.get(
  "/api/drive/people",
  wrap(async (req, res) => {
    await ensureDriveIndices();
    // With impersonation off, only yourself: the page can't ask as anyone else anyway.
    const me = getSession(req);
    const list = config.allowImpersonation ? await people() : me ? [signedInPerson(me)] : [];
    res.json(await Promise.all(list.map(async (p) => ({ ...p, files: await visibleTitles(p.email) }))));
  }),
);

driveRouter.post(
  "/api/drive/search",
  wrap(async (req, res) => {
    const a = await asker(req);
    const { results } = await driveSearch(a.person.email, a.q);
    // Identical shape whether nothing matched or everything matching was restricted.
    res.json(results.length ? { results } : { results, message: "No results found" });
  }),
);

driveRouter.post(
  "/api/drive/ask",
  wrap(async (req, res) => {
    const a = await asker(req);
    res.json((await driveAsk(a.person.email, a.q)).answer);
  }),
);

driveRouter.get(
  "/api/drive/status",
  wrap(async (_req, res) => {
    if (!driveStatus.polling) await loadStatus().catch(() => {}); // no poller keeping it current
    const admin = await adminEmail();
    // Only things that are broken right now. Demo-setup advice (admin is a persona, Carol unset) is in drive:doctor.
    const warnings: string[] = [];
    if (!isConnected()) warnings.unshift("Google Drive isn't connected. An admin can connect it at the bottom of this page.");
    else if (driveStatus.authError) warnings.unshift("The Google token expired or was revoked. An admin needs to reconnect Drive.");
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
    // Anyone on the Drive page may press it, so the actor is whoever is signed in.
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

// ---- Connect Google Drive (admin only) ----
// The admin signs in with Google and approves read access; we keep the refresh token server-side.
// The redirect URI must be registered on the Google OAuth client (default: <PUBLIC_URL>/connect/google/callback).

const pending = new Map<string, number>(); // OAuth state → expiry
const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || `${config.publicUrl}/connect/google/callback`;

driveRouter.post("/api/drive/connect", requireAdmin, (_req, res) => {
  for (const [s, exp] of pending) if (exp < Date.now()) pending.delete(s);
  const state = randomBytes(16).toString("hex");
  pending.set(state, Date.now() + 10 * 60_000);
  // prompt=consent makes Google return a refresh token even if this account approved the app before.
  const url = newOAuthClient(redirectUri()).generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
  res.json({ url });
});

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (res: express.Response, status: number, message: string) =>
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Connect Google Drive</title>` +
        `<body style="font:15px system-ui;max-width:560px;margin:48px auto;padding:0 16px">` +
        `<p>${esc(message)}</p><p><a href="/drive.html">Back to the Drive page</a></p></body>`,
    );

driveRouter.get("/connect/google/callback", async (req, res) => {
  const state = String(req.query.state ?? "");
  const exp = pending.get(state);
  pending.delete(state);
  if (!exp || exp < Date.now()) return page(res, 400, "This sign-in wasn't started here or has expired. Start again from the Drive page.");
  if (req.query.error) return page(res, 400, `Google sign-in was cancelled or failed (${String(req.query.error)}).`);
  try {
    const { tokens } = await newOAuthClient(redirectUri()).getToken(String(req.query.code ?? ""));
    if (!tokens.refresh_token) {
      return page(res, 400, "Google didn't return a refresh token. Remove HMA Brain at https://myaccount.google.com/permissions, then connect again.");
    }
    saveToken(tokens);
    loadToken();
    const who = await accountEmail();
    await recordAudit({ kind: "account", actor: who ?? "admin", via: "web", source: "drive", action: "connect", account: who ?? undefined });
    Object.assign(driveStatus, { connected: true, authError: false, lastError: null });
    const before = (await getConnector())?.account_email?.toLowerCase();
    const note = before && before !== who ? ` The index was built as ${before}, so the first sync rebuilds it from this account's Drive.` : "";
    pollOnce().catch((e) => console.error(`Drive sync after connect failed: ${explain(e)}`));
    page(res, 200, `Google Drive connected as ${who}. Syncing now.${note}`);
  } catch (e) {
    page(res, 500, `Couldn't connect: ${explain(e)}`);
  }
});
