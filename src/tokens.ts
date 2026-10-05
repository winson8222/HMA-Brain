// Slack credentials: one entry per workspace (filled in by hand) and one per connected
// person (written by the Connect flow). Kept in a git-ignored JSON file. In a real product
// this module would read and write an encrypted database instead; nothing else changes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

export type WorkspaceCreds = {
  key: string; // short name used by the seed script, e.g. "main" or "vendors"
  botToken: string; // xoxb-…
  appToken?: string; // xapp-…, only needed for live sync
  clientId?: string; // for Connect (OAuth)
  clientSecret?: string;
};

export type UserToken = {
  teamId: string;
  userId: string;
  email?: string;
  token: string; // xoxp-…
  scope: string;
  connectedAt: string;
};

type TokenFile = { workspaces: WorkspaceCreds[]; users: UserToken[] };

let cache: TokenFile | undefined;

export function loadTokens(): TokenFile {
  if (cache) return cache;
  if (existsSync(config.tokensFile)) {
    const f = JSON.parse(readFileSync(config.tokensFile, "utf8"));
    cache = { workspaces: f.workspaces ?? [], users: f.users ?? [] };
  } else if (process.env.SLACK_BOT_TOKEN && !process.env.SLACK_BOT_TOKEN.endsWith("...")) {
    // Backwards compatible: a single workspace from .env, no connected people.
    cache = {
      workspaces: [{ key: "main", botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN }],
      users: [],
    };
  } else {
    console.error(`No Slack credentials: create ${config.tokensFile} (see slack-tokens.example.json and README.md)`);
    process.exit(1);
  }
  return cache;
}

function save() {
  writeFileSync(config.tokensFile, JSON.stringify(loadTokens(), null, 2) + "\n");
}

export const userTokens = (teamId?: string) =>
  loadTokens().users.filter((u) => !teamId || u.teamId === teamId);

export function saveUserToken(t: UserToken) {
  const f = loadTokens();
  f.users = f.users.filter((u) => !(u.teamId === t.teamId && u.userId === t.userId));
  f.users.push(t);
  save();
}

export function removeUserToken(teamId: string, userId: string) {
  const f = loadTokens();
  f.users = f.users.filter((u) => !(u.teamId === teamId && u.userId === userId));
  save();
}
