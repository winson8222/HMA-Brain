import { config } from "../../config.js"; // also loads .env

const baseUrl = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");

export const jiraConfig = {
  // https://<site>.atlassian.net (Jira Cloud). The crawler signs in with an API token of a service account.
  baseUrl,
  // Every Jira label names its site, so two Jira sites (or a renamed one) can never share labels.
  site: baseUrl ? new URL(baseUrl).hostname.toLowerCase() : "",
  email: process.env.JIRA_EMAIL ?? "",
  apiToken: process.env.JIRA_API_TOKEN ?? "",
  // Project keys to ingest, comma-separated. Empty: every project the service account can browse.
  projects: (process.env.JIRA_PROJECTS ?? "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean),
  // Poll Jira for issues updated since the last run. Several servers can poll at once.
  sync: process.env.JIRA_SYNC === "on",
  pollSeconds: Number(process.env.JIRA_POLL_SECONDS || 60),
  // Full reconcile: re-list every issue (catches deletes, which JQL can't see) and re-read every
  // project's permission scheme. 0 turns it off.
  reconcileMinutes: Number(process.env.JIRA_RECONCILE_MINUTES ?? 60),
  // Atlassian OAuth 2.0 (3LO) app for "Connect Jira": each person proves which Atlassian account is theirs.
  // Only the read:me scope; their token is thrown away once we know their account ID.
  oauthClientId: process.env.JIRA_OAUTH_CLIENT_ID ?? "",
  oauthClientSecret: process.env.JIRA_OAUTH_CLIENT_SECRET ?? "",
  redirectUri: process.env.JIRA_REDIRECT_URI || `${config.publicUrl}/connect/jira/callback`,
  index: process.env.JIRA_INDEX || "brain-jira",
  stateIndex: process.env.JIRA_STATE_INDEX || "brain-jira-state",
};
