// What a person can see outside Slack, for the access chips in the UI ("Viewing as" and Connections).
// Lists only names, computed with the same permission filters Search and Ask use, so it never shows
// anything the person couldn't already get in a result.
import { confluenceConfigured, connectors, driveConfigured, jiraConfigured } from "./connectors/index.js";
import { es } from "./es.js";
import { findPerson } from "./people.js";

export type Access = {
  // Per source: does this person have an identity there at all (Slack account, Drive email, linked
  // Atlassian account)? The UI only offers sources the person is connected to.
  connected: Record<string, boolean>;
  drive?: { files: string[] };
  jira?: { linked: boolean; projects: { key: string; name: string }[] };
  confluence?: { linked: boolean; spaces: { key: string; name: string }[] };
};

export async function accessSummary(personId: string): Promise<Access> {
  const [person, drive, jira, confluence] = await Promise.all([
    findPerson(personId),
    driveConfigured ? driveFiles(personId) : undefined,
    jiraConfigured ? jiraProjects(personId) : undefined,
    confluenceConfigured ? confluenceSpaces(personId) : undefined,
  ]);
  const has: Record<string, boolean> = {
    slack: !!person?.accounts.length,
    drive: !!drive?.email,
    jira: !!jira?.linked,
    confluence: !!confluence?.linked,
  };
  const connected = Object.fromEntries(connectors.map((c) => [c.name, has[c.name] ?? true]));
  return {
    connected,
    ...(drive && { drive: { files: drive.files } }),
    ...(jira && { jira }),
    ...(confluence && { confluence }),
  };
}

const missingIndex = (e: any) => e?.meta?.body?.error?.type === "index_not_found_exception";

// Drive identity is the person's email; anyone without one has no Drive access (fail closed).
async function driveFiles(personId: string): Promise<{ email: boolean; files: string[] }> {
  const [{ isRealEmail }, { driveKeysFor }, { driveConfig }] = await Promise.all([
    import("./connectors/drive/people.js"),
    import("./connectors/drive/acl.js"),
    import("./connectors/drive/config.js"),
  ]);
  if (!isRealEmail(personId)) return { email: false, files: [] };
  try {
    const r = await es.search({
      index: driveConfig.index,
      size: 0,
      query: { bool: { filter: [{ terms: { acl_container: driveKeysFor(personId) } }] } },
      aggs: { titles: { terms: { field: "title.keyword", size: 50, order: { _key: "asc" } } } },
    });
    return { email: true, files: ((r.aggregations?.titles as any)?.buckets ?? []).map((b: any) => String(b.key)) };
  } catch (e) {
    if (missingIndex(e)) return { email: true, files: [] };
    throw e;
  }
}

// Jira access comes only from the person's own Connect Jira link; not linked means no Jira results.
async function jiraProjects(personId: string): Promise<Access["jira"]> {
  const [{ jiraAccess }, { jiraFilter }, { jiraConfig }] = await Promise.all([
    import("./connectors/jira/people.js"),
    import("./connectors/jira/acl.js"),
    import("./connectors/jira/config.js"),
  ]);
  const access = await jiraAccess(personId);
  if (!access) return { linked: false, projects: [] };
  try {
    const r = await es.search({
      index: jiraConfig.index,
      size: 0,
      query: { bool: { filter: jiraFilter(access.keys) } },
      aggs: {
        projects: {
          terms: { field: "project_key", size: 50, order: { _key: "asc" } },
          aggs: { name: { terms: { field: "project_name", size: 1 } } },
        },
      },
    });
    const buckets = (r.aggregations?.projects as any)?.buckets ?? [];
    return {
      linked: true,
      projects: buckets.map((b: any) => ({ key: String(b.key), name: String(b.name?.buckets?.[0]?.key ?? b.key) })),
    };
  } catch (e) {
    if (missingIndex(e)) return { linked: true, projects: [] };
    throw e;
  }
}

// Confluence uses the same Atlassian link as Jira (Connect Jira); not linked means no Confluence results.
async function confluenceSpaces(personId: string): Promise<Access["confluence"]> {
  const [{ confluenceAccess }, { confluenceFilter }, { confluenceConfig }] = await Promise.all([
    import("./connectors/confluence/people.js"),
    import("./connectors/confluence/acl.js"),
    import("./connectors/confluence/config.js"),
  ]);
  const access = await confluenceAccess(personId);
  if (!access) return { linked: false, spaces: [] };
  try {
    const r = await es.search({
      index: confluenceConfig.index,
      size: 0,
      query: { bool: { filter: confluenceFilter(access.keys) } },
      aggs: {
        spaces: {
          terms: { field: "space_key", size: 50, order: { _key: "asc" } },
          aggs: { name: { terms: { field: "space_name", size: 1 } } },
        },
      },
    });
    const buckets = (r.aggregations?.spaces as any)?.buckets ?? [];
    return {
      linked: true,
      spaces: buckets.map((b: any) => ({ key: String(b.key), name: String(b.name?.buckets?.[0]?.key ?? b.key) })),
    };
  } catch (e) {
    if (missingIndex(e)) return { linked: true, spaces: [] };
    throw e;
  }
}
