// "Connect Jira" for the signed-in person (public/connect.html). Mounted by server.ts when Jira is configured.
import express from "express";
import { HttpError, wrap } from "../../http.js";
import { getSession } from "../../session.js";
import { accountForCode, authorizeUrl, linkTarget, oauthConfigured } from "./auth.js";
import { ensureJiraIndices, deleteLink, getLink, putLink } from "./store.js";
import { forgetAccess } from "./people.js";
import { recordAudit } from "../../audit/record.js";

export const jiraRouter = express.Router();

function me(req: express.Request): string {
  const p = getSession(req);
  if (!p) throw new HttpError(401, "Sign in first: connect your Slack on this page.");
  return p;
}

jiraRouter.get(
  "/api/jira/me",
  wrap(async (req, res) => {
    const p = getSession(req);
    if (!p) return res.json({ canConnect: oauthConfigured(), linked: false });
    await ensureJiraIndices();
    const link = await getLink(p);
    res.json({ canConnect: oauthConfigured(), linked: !!link, account: link?.account_name ?? null, linkedAt: link?.linked_at ?? null });
  }),
);

jiraRouter.get(
  "/connect/jira/start",
  wrap(async (req, res) => {
    if (!oauthConfigured()) throw new HttpError(400, "Connect Jira isn't set up (JIRA_OAUTH_CLIENT_ID / JIRA_OAUTH_CLIENT_SECRET).");
    res.redirect(authorizeUrl(me(req)));
  }),
);

jiraRouter.get("/connect/jira/callback", async (req, res) => {
  const back = (q: Record<string, string>) => res.redirect(`/connect.html?${new URLSearchParams(q)}`);
  if (req.query.error) return back({ error: `Atlassian said: ${req.query.error}` });
  const target = linkTarget(String(req.query.state ?? ""), getSession(req));
  if ("error" in target) return back({ error: target.error });
  try {
    const account = await accountForCode(String(req.query.code ?? ""));
    await ensureJiraIndices();
    await putLink(target.personId, account.accountId, account.name);
    forgetAccess(target.personId);
    console.log(`Jira: linked ${target.personId} to Atlassian account ${account.accountId}`);
    await recordAudit({ kind: "account", actor: target.personId, via: "web", source: "atlassian", action: "connect", account: account.name ?? account.accountId });
    back({ connected: `Jira (${account.name ?? account.accountId})` });
  } catch (e: any) {
    console.error(e);
    back({ error: e?.message ?? String(e) });
  }
});

jiraRouter.post(
  "/api/jira/disconnect",
  wrap(async (req, res) => {
    const p = me(req);
    const link = await getLink(p);
    await deleteLink(p);
    forgetAccess(p);
    if (link) await recordAudit({ kind: "account", actor: p, via: "web", source: "atlassian", action: "disconnect", account: link.account_name ?? link.account_id });
    res.json({ ok: true });
  }),
);
