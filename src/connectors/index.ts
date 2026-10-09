// The only place that knows which platforms exist. Search and Ask run over whatever is registered here.
// Adding a platform: implement Connector in src/connectors/<name>/ and add it below.
import { slack } from "./slack/index.js";
import type { Connector } from "./types.js";

// Drive loads only when the Google app is configured, so the server still runs without Google credentials.
export const driveConfigured =
  /\.apps\.googleusercontent\.com$/.test(process.env.GOOGLE_CLIENT_ID ?? "") &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !process.env.GOOGLE_CLIENT_SECRET.endsWith("...");

// Jira loads only when a site and the service account's API token are set.
export const jiraConfigured =
  /^https:\/\/[^/]+/.test(process.env.JIRA_BASE_URL ?? "") && !!process.env.JIRA_EMAIL && !!process.env.JIRA_API_TOKEN && !process.env.JIRA_API_TOKEN.endsWith("...");

// Confluence shares Jira's site and crawler token by default (see confluence/config.ts).
export const confluenceConfigured =
  /^https:\/\/[^/]+/.test(process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL || "") &&
  !!(process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL) &&
  !!(process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN) &&
  !(process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || "").endsWith("...") &&
  process.env.CONFLUENCE_SYNC !== undefined; // opt in: set CONFLUENCE_SYNC=on|off to enable the connector

export const connectors: Connector[] = [
  slack,
  ...(driveConfigured ? [(await import("./drive/index.js")).drive] : []),
  ...(jiraConfigured ? [(await import("./jira/index.js")).jira] : []),
  ...(confluenceConfigured ? [(await import("./confluence/index.js")).confluence] : []),
];

export const connectorByName = (name: string) => connectors.find((c) => c.name === name);
