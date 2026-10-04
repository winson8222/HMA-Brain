// "Connect Jira": the signed-in person approves Atlassian's read:me scope once, and Atlassian tells us
// their account ID. We store only person → account ID; the token is never saved. Search still runs as the
// service account, with Jira's own permission check for that account ID (query.ts), so the link is all we need.
import { randomBytes } from "node:crypto";
import { sign, verify } from "../../session.js";
import { jiraConfig } from "./config.js";

export const oauthConfigured = () => !!(jiraConfig.oauthClientId && jiraConfig.oauthClientSecret);

// The state names who started Connect. The callback only links when the same person is still signed in
// in that browser, so nobody can trick someone else into linking their Atlassian account to the wrong person.
export function authorizeUrl(personId: string): string {
  const state = sign({ p: personId, n: randomBytes(8).toString("hex") }, 10 * 60_000);
  const q = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: jiraConfig.oauthClientId,
    scope: "read:me",
    redirect_uri: jiraConfig.redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `https://auth.atlassian.com/authorize?${q}`;
}

// The person to link, or why not. Pure, unit-tested.
export function linkTarget(state: string, signedIn: string | undefined): { personId: string } | { error: string } {
  const s = verify<{ p: string }>(state);
  if (!s) return { error: "This Connect Jira link has expired or wasn't started here. Start again from the Connect page." };
  if (!signedIn || signedIn !== s.p) return { error: "You're no longer signed in as the person who started Connect Jira. Sign in and start again." };
  return { personId: s.p };
}

// code → the Atlassian account that approved. The access token is used once here and then dropped.
export async function accountForCode(code: string): Promise<{ accountId: string; name: string | null }> {
  const t = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: jiraConfig.oauthClientId,
      client_secret: jiraConfig.oauthClientSecret,
      code,
      redirect_uri: jiraConfig.redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!t.ok) throw new Error(`Atlassian rejected the sign-in (${t.status} ${(await t.text()).slice(0, 200)})`);
  const { access_token } = (await t.json()) as { access_token: string };

  const me = await fetch("https://api.atlassian.com/me", { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!me.ok) throw new Error(`Couldn't read your Atlassian profile (${me.status})`);
  const p = (await me.json()) as { account_id?: string; name?: string; account_status?: string };
  if (!p.account_id) throw new Error("Atlassian didn't return an account ID");
  if (p.account_status && p.account_status !== "active") throw new Error("That Atlassian account isn't active");
  return { accountId: p.account_id, name: p.name ?? null };
}
