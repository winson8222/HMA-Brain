// Jira Cloud REST API v3 client for the crawler: runs as a service account with an API token.
// The account needs Browse on every project to ingest, and the "Administer Jira" global permission to
// read permission schemes and to ask Jira whether another person can browse an issue (the live re-check).
import { jiraConfig } from "./config.js";
import { ISSUE_FIELDS, type RawIssue } from "./docs.js";
import type { Holder } from "./acl.js";

export class JiraError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const isAuthError = (e: any) => e instanceof JiraError && (e.status === 401 || e.status === 403);

export function explain(e: any): string {
  if (e instanceof JiraError && e.status === 401) return "Jira rejected the API token. Check JIRA_EMAIL / JIRA_API_TOKEN in .env.";
  if (e instanceof JiraError && e.status === 403) return `Jira said the service account isn't allowed to do that (${e.message}).`;
  return String(e?.message ?? e);
}

export type Creds = { email: string; apiToken: string };
const basic = (c: Creds) => "Basic " + Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
type Method = "GET" | "POST" | "PUT" | "DELETE";

// creds: the crawler's by default. Only the seed script passes others (the admin's, a persona's own).
export async function call<T>(method: Method, path: string, body?: unknown, creds: Creds = jiraConfig): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${jiraConfig.baseUrl}${path}`, {
      method,
      headers: { Authorization: basic(creds), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    // Jira Cloud rate limits with 429 + Retry-After; 5xx are usually transient.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const after = Number(res.headers.get("retry-after")) * 1000 || Math.min(32_000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, after + Math.random() * 250));
      continue;
    }
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join("; ") || j.message || msg;
    } catch {}
    throw new JiraError(res.status, `${method} ${path.split("?")[0]}: ${res.status} ${msg}`);
  }
}

const get = <T>(path: string) => call<T>("GET", path);
const post = <T>(path: string, body: unknown) => call<T>("POST", path, body);
const q = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();

// ---- calls ----

// timeZone matters: JQL dates like `updated >= "2026-10-02 09:00"` are read in this account's time zone.
export const myself = () => get<{ accountId: string; emailAddress?: string; displayName?: string; timeZone?: string }>("/rest/api/3/myself");

export type Project = { id: string; key: string; name: string; style?: string; lead?: { accountId?: string } };

export async function listProjects(keys: string[]): Promise<Project[]> {
  const out: Project[] = [];
  for (let startAt = 0; ; ) {
    const r = await get<{ values: Project[]; isLast: boolean }>(
      `/rest/api/3/project/search?${q({ startAt, maxResults: 50, expand: "lead" })}${keys.map((k) => `&keys=${encodeURIComponent(k)}`).join("")}`,
    );
    out.push(...r.values);
    if (r.isLast || !r.values.length) return out;
    startAt += r.values.length;
  }
}

// Enhanced JQL search (the old /search endpoint is gone). Paged with nextPageToken.
// extraFields: picker fields the project's permission grants read (docs.ts pickerFields).
export async function* searchIssues(jql: string, extraFields: string[] = []): AsyncGenerator<RawIssue[]> {
  let nextPageToken: string | undefined;
  do {
    const r = await post<{ issues: RawIssue[]; nextPageToken?: string }>("/rest/api/3/search/jql", {
      jql,
      fields: [...ISSUE_FIELDS, ...extraFields],
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    yield r.issues ?? [];
    nextPageToken = r.nextPageToken;
  } while (nextPageToken);
}

// Just the IDs, for finding deleted issues (JQL can't return deleted ones).
export async function issueIds(jql: string): Promise<string[]> {
  const out: string[] = [];
  let nextPageToken: string | undefined;
  do {
    const r = await post<{ issues: { id: string }[]; nextPageToken?: string }>("/rest/api/3/search/jql", {
      jql,
      fields: ["id"],
      maxResults: 5000,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    out.push(...(r.issues ?? []).map((i) => i.id));
    nextPageToken = r.nextPageToken;
  } while (nextPageToken);
  return out;
}

// ---- permissions (need "Administer Jira") ----

export async function browseGrants(projectId: string): Promise<Holder[]> {
  const r = await get<{ permissions?: { permission: string; holder: Holder }[] }>(`/rest/api/3/project/${projectId}/permissionscheme?expand=permissions`);
  return (r.permissions ?? []).filter((p) => p.permission === "BROWSE_PROJECTS").map((p) => p.holder);
}

// Role ID → its members in this project.
export async function projectRoles(projectId: string): Promise<Record<string, { users: string[]; groups: string[] }>> {
  const roles = await get<Record<string, string>>(`/rest/api/3/project/${projectId}/role`); // name → URL ending in the role ID
  const out: Record<string, { users: string[]; groups: string[] }> = {};
  for (const url of Object.values(roles)) {
    const id = url.split("/").pop()!;
    const r = await get<{ actors?: { actorUser?: { accountId?: string }; actorGroup?: { groupId?: string } }[] }>(`/rest/api/3/project/${projectId}/role/${id}`);
    out[id] = {
      users: (r.actors ?? []).flatMap((a) => (a.actorUser?.accountId ? [a.actorUser.accountId] : [])),
      groups: (r.actors ?? []).flatMap((a) => (a.actorGroup?.groupId ? [a.actorGroup.groupId] : [])),
    };
  }
  return out;
}

// The project's issue security scheme ID, or null when it has none.
export async function securitySchemeId(projectId: string): Promise<string | null> {
  try {
    const r = await get<{ id?: number | string }>(`/rest/api/3/project/${projectId}/issuesecuritylevelscheme`);
    return r.id != null ? String(r.id) : null;
  } catch (e) {
    if (e instanceof JiraError && e.status === 404) return null;
    throw e;
  }
}

// Level ID → the holders that are members of it.
export async function securityLevelMembers(schemeId: string): Promise<Record<string, Holder[]>> {
  const out: Record<string, Holder[]> = {};
  for (let startAt = 0; ; ) {
    const r = await get<{ values: { issueSecurityLevelId: string | number; holder: Holder }[]; isLast: boolean }>(
      `/rest/api/3/issuesecurityschemes/level/member?${q({ schemeId, startAt, maxResults: 50 })}`,
    );
    for (const m of r.values) (out[String(m.issueSecurityLevelId)] ??= []).push(m.holder);
    if (r.isLast || !r.values.length) return out;
    startAt += r.values.length;
  }
}

// ---- people ----

export const userGroups = (accountId: string) => get<{ groupId: string; name: string }[]>(`/rest/api/3/user/groups?${q({ accountId })}`);

export async function hasProductAccess(accountId: string): Promise<boolean> {
  const r = await get<{ applicationRoles?: { size?: number } }>(`/rest/api/3/user?${q({ accountId, expand: "applicationRoles" })}`);
  return (r.applicationRoles?.size ?? 0) > 0;
}

// The live re-check: Jira's own answer to "which of these issues can this account browse right now?"
// Covers everything (scheme, roles, groups, security level, reporter/assignee rules, deleted issues).
export async function browsableIssues(accountId: string, issueIds: string[]): Promise<Set<string>> {
  const r = await post<{ projectPermissions?: { permission: string; issues?: number[] }[] }>("/rest/api/3/permissions/check", {
    accountId,
    projectPermissions: [{ permissions: ["BROWSE_PROJECTS"], issues: issueIds.map(Number) }],
  });
  const p = r.projectPermissions?.find((x) => x.permission === "BROWSE_PROJECTS");
  return new Set((p?.issues ?? []).map(String));
}

// Global permissions of the service account, e.g. ["ADMINISTER"] → { ADMINISTER: true }.
export async function myPermissions(keys: string[]): Promise<Record<string, boolean>> {
  const r = await get<{ permissions: Record<string, { havePermission: boolean }> }>(`/rest/api/3/mypermissions?${q({ permissions: keys.join(",") })}`);
  return Object.fromEntries(keys.map((k) => [k, !!r.permissions?.[k]?.havePermission]));
}
