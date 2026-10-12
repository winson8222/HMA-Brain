// Source connection flags for the search controls. Never enumerate source content here.
import { confluenceConfigured, connectors, driveConfigured, jiraConfigured } from "./connectors/index.js";
import { findPerson } from "./people.js";

export type Access = { connected: Record<string, boolean> };

export async function accessSummary(personId: string): Promise<Access> {
  const [person, drive, jira, confluence] = await Promise.all([
    findPerson(personId),
    driveConfigured ? import("./connectors/drive/people.js").then(({ isRealEmail }) => isRealEmail(personId)) : false,
    jiraConfigured ? import("./connectors/jira/people.js").then(({ jiraAccess }) => jiraAccess(personId)) : null,
    confluenceConfigured ? import("./connectors/confluence/people.js").then(({ confluenceAccess }) => confluenceAccess(personId)) : null,
  ]);
  const has: Record<string, boolean> = { slack: !!person?.accounts.length, drive, jira: !!jira, confluence: !!confluence };
  return { connected: Object.fromEntries(connectors.map((c) => [c.name, has[c.name] ?? true])) };
}
