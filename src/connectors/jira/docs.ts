// Jira issue → Elasticsearch chunk docs. Pure functions, unit-tested.
import { labelsFor, sha256, type Rule } from "./acl.js";
import { adfToText } from "./adf.js";

// One project's permission picture, read from its schemes (see schemes.ts). Issues are labelled from it.
export type ProjectAcl = {
  project_id: string;
  key: string;
  name: string;
  browse: Rule; // Browse Projects grants
  levels: Record<string, Rule>; // issue security level ID → its members
  hash: string; // changes whenever anything above changes: the project's issues must be relabelled
};

export type JiraDoc = {
  doc_id: string; // jira:<site>:<issueId>:<chunk>
  source: "jira";
  issue_id: string;
  issue_key: string; // PAY-240
  project_id: string;
  project_key: string;
  project_name: string;
  chunk_index: number;
  summary: string;
  status: string | null;
  issue_type: string | null;
  text: string;
  reporter_id: string | null;
  reporter_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  ts: string;
  permalink: string;
  acl_container: string[]; // Browse Projects, see acl.ts
  restricted: boolean; // has an issue security level
  acl_item: string[]; // that level's members; empty when not restricted
  security_level: string | null;
  content_hash: string; // covers the text AND the labels: a permission change rewrites the issue too
};

type User = { accountId?: string | null; displayName?: string | null } | null | undefined;
export type RawComment = { id: string; author?: User; body?: unknown; created?: string; visibility?: { type?: string; value?: string } | null };
export type RawIssue = {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    priority?: { name?: string } | null;
    project?: { id?: string; key?: string; name?: string };
    reporter?: User;
    assignee?: User;
    labels?: string[];
    created?: string;
    updated?: string;
    security?: { id?: string; name?: string } | null;
    comment?: { comments?: RawComment[] };
    [customField: string]: unknown; // picker fields named in permission grants (see pickerFields)
  };
};

// Fields every issue read asks for.
export const ISSUE_FIELDS = ["summary", "description", "status", "issuetype", "priority", "project", "reporter", "assignee", "labels", "created", "updated", "security", "comment"];

// The picker fields a project's grants read, which every issue read in that project must also fetch.
export const pickerFields = (acl: ProjectAcl) =>
  [...new Set([acl.browse, ...Object.values(acl.levels)].flatMap((r) => [...r.userFields, ...r.groupFields]))].sort();

export const CHUNK_CHARS = 3000; // about 800 tokens, like Drive
const MAX_CHUNKS = 20;

export const jiraDocId = (site: string, issueId: string, n: number) => `jira:${site}:${issueId}:${n}`;

function split(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

// The issue's own text, then its comments packed into chunks. A comment restricted to a role or group
// is left out: it has its own audience, narrower than the issue's, which these labels can't express.
export function issueChunks(issue: RawIssue): string[] {
  const f = issue.fields;
  const facts = [
    f.issuetype?.name && `Type: ${f.issuetype.name}`,
    f.status?.name && `Status: ${f.status.name}`,
    f.priority?.name && `Priority: ${f.priority.name}`,
    f.assignee?.displayName && `Assignee: ${f.assignee.displayName}`,
    f.reporter?.displayName && `Reporter: ${f.reporter.displayName}`,
    f.labels?.length && `Labels: ${f.labels.join(", ")}`,
  ].filter(Boolean);
  const body = [facts.join(" · "), adfToText(f.description)].filter(Boolean).join("\n\n");

  const chunks = body ? split(body, CHUNK_CHARS) : [""];
  let cur = "";
  for (const c of f.comment?.comments ?? []) {
    if (c.visibility) continue;
    const text = adfToText(c.body);
    if (!text) continue;
    const entry = `Comment by ${c.author?.displayName ?? "unknown"} (${c.created?.slice(0, 10) ?? "?"}):\n${text}`;
    for (const piece of split(entry, CHUNK_CHARS)) {
      if (cur && cur.length + 2 + piece.length > CHUNK_CHARS) {
        chunks.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS);
}

export function issueToDocs(site: string, baseUrl: string, issue: RawIssue, acl: ProjectAcl): JiraDoc[] {
  const f = issue.fields;
  const who = { reporter: f.reporter?.accountId ?? null, assignee: f.assignee?.accountId ?? null, fields: f };
  const levelId = f.security?.id ?? null;
  // A level we couldn't read members for gives no item labels: the issue is then visible to nobody here.
  const level = levelId ? acl.levels[levelId] : undefined;
  const header = `${issue.key}: ${f.summary ?? ""}`;
  const chunks = issueChunks(issue);
  const acl_container = labelsFor(site, acl.browse, who);
  const acl_item = level ? labelsFor(site, level, who) : [];
  const base = {
    source: "jira" as const,
    issue_id: issue.id,
    issue_key: issue.key,
    project_id: acl.project_id,
    project_key: acl.key,
    project_name: acl.name,
    summary: f.summary ?? "",
    status: f.status?.name ?? null,
    issue_type: f.issuetype?.name ?? null,
    reporter_id: who.reporter,
    reporter_name: f.reporter?.displayName ?? null,
    assignee_id: who.assignee,
    assignee_name: f.assignee?.displayName ?? null,
    created_at: f.created ?? null,
    updated_at: f.updated ?? null,
    ts: f.updated ?? new Date().toISOString(),
    permalink: `${baseUrl}/browse/${issue.key}`,
    acl_container,
    restricted: !!levelId,
    acl_item,
    security_level: f.security?.name ?? null,
    content_hash: sha256(JSON.stringify([header, chunks, acl_container, !!levelId, acl_item])),
  };
  return chunks.map((c, i) => ({ ...base, doc_id: jiraDocId(site, issue.id, i), chunk_index: i, text: c ? `${header}\n\n${c}` : header }));
}

// A JQL date for `updated >= "..."`, in the service account's time zone (JQL has no offsets, only minutes).
export function jqlTime(at: Date, timeZone = "UTC"): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
