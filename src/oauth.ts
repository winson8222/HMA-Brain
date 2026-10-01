// "Connect my Slack": a person approves read access to their DMs in one workspace.
// Slack returns a user token (xoxp-…), stored with the person's email.
import { randomBytes } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { config } from "./config.js";
import { sign, verify } from "./session.js";
import { emailOf, workspaceByKey, type Workspace } from "./slack.js";
import { saveUserToken, type UserToken } from "./tokens.js";

// Read DMs and group DMs. im:write, mpim:write and chat:write are demo-only (the seed script
// posts demo DMs as each persona); remove them in a real product.
export const USER_SCOPES = ["im:history", "mpim:history", "im:read", "mpim:read", "im:write", "mpim:write", "chat:write"];

export const redirectUri = () => `${config.publicUrl}/slack/oauth/callback`;

export function canConnect(ws: Workspace) {
  return !!(ws.creds.clientId && ws.creds.clientSecret);
}

export function authorizeUrl(ws: Workspace): string {
  const state = sign({ k: ws.key, n: randomBytes(8).toString("hex") }, 10 * 60_000);
  const q = new URLSearchParams({
    client_id: ws.creds.clientId!,
    user_scope: USER_SCOPES.join(","),
    redirect_uri: redirectUri(),
    state,
    team: ws.teamId,
  });
  return `https://slack.com/oauth/v2/authorize?${q}`;
}

export async function completeConnect(code: string, state: string): Promise<{ ws: Workspace; token: UserToken }> {
  const s = verify<{ k: string }>(state);
  if (!s) throw new Error("This Connect link has expired. Start again from the Connect page.");
  const ws = await workspaceByKey(s.k);
  if (!ws || !canConnect(ws)) throw new Error("Unknown workspace");

  const r: any = await new WebClient().oauth.v2.access({
    client_id: ws.creds.clientId!,
    client_secret: ws.creds.clientSecret!,
    code,
    redirect_uri: redirectUri(),
  });
  if (r.team?.id !== ws.teamId) throw new Error(`You approved a different workspace than ${ws.teamName}.`);

  const user = await ws.getUser(r.authed_user.id);
  const token: UserToken = {
    teamId: ws.teamId,
    userId: r.authed_user.id,
    email: emailOf(user),
    token: r.authed_user.access_token,
    scope: r.authed_user.scope,
    connectedAt: new Date().toISOString(),
  };
  saveUserToken(token);
  return { ws, token };
}
