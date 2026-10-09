import "../../config.js"; // loads .env

// Confluence lives on the same Atlassian site as Jira and the crawler's API token works for both products,
// so everything defaults to the JIRA_* values. Set CONFLUENCE_* only when Confluence is on another site.
const baseUrl = (process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL || "").replace(/\/$/, "");

export const confluenceConfig = {
  baseUrl,
  // Every label names its site, so two sites (or a renamed one) can never share labels.
  site: baseUrl ? new URL(baseUrl).hostname.toLowerCase() : "",
  email: process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || "",
  apiToken: process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || "",
  // Space keys to ingest, comma-separated. Empty: every space the crawler can view.
  spaces: (process.env.CONFLUENCE_SPACES ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  sync: process.env.CONFLUENCE_SYNC === "on",
  pollSeconds: Number(process.env.CONFLUENCE_POLL_SECONDS || 60),
  // Reconcile: re-list every page (catches deletes) and re-read every page's view restriction (a restriction
  // change may not bump lastmodified). 0 turns it off. Small on the demo site; raise it for a real one.
  reconcileMinutes: Number(process.env.CONFLUENCE_RECONCILE_MINUTES ?? 10),
  index: process.env.CONFLUENCE_INDEX || "brain-confluence",
  stateIndex: process.env.CONFLUENCE_STATE_INDEX || "brain-confluence-state",
};
