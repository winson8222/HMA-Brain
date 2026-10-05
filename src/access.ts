// What a person can see outside Slack, for the access chips in the UI ("Viewing as" and Connections).
// Lists only names, computed with the same permission filters Search and Ask use, so it never shows
// anything the person couldn't already get in a result.
import { driveConfigured, jiraConfigured } from "./connectors/index.js";
import { es } from "./es.js";

export type Access = {
  drive?: { files: string[] };
  jira?: { linked: boolean; projects: { key: string; name: string }[] };
};

export async function accessSummary(personId: string): Promise<Access> {
  const [drive, jira] = await Promise.all([
    driveConfigured ? driveFiles(personId) : undefined,
    jiraConfigured ? jiraProjects(personId) : undefined,
  ]);
  return { ...(drive && { drive }), ...(jira && { jira }) };
}

const missingIndex = (e: any) => e?.meta?.body?.error?.type === "index_not_found_exception";

// Drive identity is the person's email; anyone without one has no Drive access (fail closed).
async function driveFiles(personId: string): Promise<Access["drive"]> {
  const [{ isRealEmail }, { driveKeysFor }, { driveConfig }] = await Promise.all([
    import("./connectors/drive/people.js"),
    import("./connectors/drive/acl.js"),
    import("./connectors/drive/config.js"),
  ]);
  if (!isRealEmail(personId)) return { files: [] };
  try {
    const r = await es.search({
      index: driveConfig.index,
      size: 0,
      query: { bool: { filter: [{ terms: { acl_container: driveKeysFor(personId) } }] } },
      aggs: { titles: { terms: { field: "title.keyword", size: 50, order: { _key: "asc" } } } },
    });
    return { files: ((r.aggregations?.titles as any)?.buckets ?? []).map((b: any) => String(b.key)) };
  } catch (e) {
    if (missingIndex(e)) return { files: [] };
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
