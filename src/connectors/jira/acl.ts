// Jira permissions → labels. Pure functions, unit-tested.
//
// Who can see an issue in Jira is decided in two layers:
//   1. Browse Projects in the project's permission scheme (groups, project roles, users, "anyone",
//      "any logged-in user", reporter, assignee, project lead, ...).
//   2. The issue's security level, if it has one: the person must ALSO be one of that level's members.
// So every issue doc carries two labels: `acl_container` (layer 1) and, when it has a security level,
// `acl_item` (layer 2). A person may see it if they match the first AND (no level OR the second).
import { createHash } from "node:crypto";

// A grant as Jira returns it, in a permission scheme or an issue security level.
export type Holder = { type: string; parameter?: string | null; value?: string | null };

// Project role → its members, read from the project (roles are per project).
export type RoleActors = Record<string, { users: string[]; groups: string[] }>;

// A set of holders resolved as far as possible without a specific issue: fixed labels, plus the parts
// that depend on the issue: its reporter / assignee, and the people or groups named in picker fields.
export type Rule = {
  labels: string[];
  reporter: boolean;
  assignee: boolean;
  userFields: string[]; // custom field IDs (user pickers): the users named in them may see the issue
  groupFields: string[]; // custom field IDs (group pickers): members of the groups named in them may see it
  unsupported: string[];
};

export const jiraUser = (site: string, accountId: string) => `jira:${site}:user:${accountId}`;
export const jiraGroup = (site: string, groupId: string) => `jira:${site}:group:${groupId}`;
export const jiraAnyone = (site: string) => `jira:${site}:anyone`;
export const jiraLoggedIn = (site: string) => `jira:${site}:loggedin`;

// Holder types we can't turn into labels yet (Service Management customers, ...).
// They're skipped, so the people they grant see less than in Jira: safe, just incomplete.
export function toRule(site: string, holders: Holder[], roles: RoleActors, projectLead: string | null): Rule {
  const labels = new Set<string>();
  const unsupported = new Set<string>();
  const userFields = new Set<string>();
  const groupFields = new Set<string>();
  let reporter = false;
  let assignee = false;
  for (const h of holders) {
    switch (h.type) {
      case "anyone":
        labels.add(jiraAnyone(site));
        break;
      case "applicationRole": // any user with access to the product
        labels.add(jiraLoggedIn(site));
        break;
      case "group": // value is the group ID; parameter (the name) is deprecated and can change
        if (h.value) labels.add(jiraGroup(site, h.value));
        else unsupported.add("group without an ID");
        break;
      case "user":
        if (h.parameter) labels.add(jiraUser(site, h.parameter));
        break;
      case "projectRole": {
        const actors = roles[String(h.parameter)];
        if (!actors) {
          unsupported.add(`projectRole ${h.parameter} (members not readable)`);
          break;
        }
        for (const u of actors.users) labels.add(jiraUser(site, u));
        for (const g of actors.groups) labels.add(jiraGroup(site, g));
        break;
      }
      case "projectLead":
        if (projectLead) labels.add(jiraUser(site, projectLead));
        break;
      case "reporter":
      case "reporterWithCreatePermission":
        reporter = true;
        break;
      case "assignee":
      case "assigneeWithAssignablePermission":
        assignee = true;
        break;
      case "userCustomField": // parameter is the field ID, e.g. customfield_10050 ("Approvers")
        if (h.parameter) userFields.add(h.parameter);
        break;
      case "groupCustomField":
        if (h.parameter) groupFields.add(h.parameter);
        break;
      default:
        unsupported.add(h.type);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { labels: sorted(labels), reporter, assignee, userFields: sorted(userFields), groupFields: sorted(groupFields), unsupported: sorted(unsupported) };
}

// A picker field's value: one object or a list (single or multi picker); empty when unset.
const pickerValues = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []) as Record<string, unknown>[];
export const pickedUsers = (v: unknown) => pickerValues(v).flatMap((x) => (typeof x.accountId === "string" ? [x.accountId] : []));
// Groups by ID only: a value without groupId (older data) is skipped, like group grants.
export const pickedGroups = (v: unknown) => pickerValues(v).flatMap((x) => (typeof x.groupId === "string" ? [x.groupId] : []));

// The rule applied to one issue: its reporter, assignee and picker-field values become labels if the rule allows them.
export function labelsFor(
  site: string,
  rule: Rule,
  issue: { reporter: string | null; assignee: string | null; fields?: Record<string, unknown> },
): string[] {
  const out = new Set(rule.labels);
  if (rule.reporter && issue.reporter) out.add(jiraUser(site, issue.reporter));
  if (rule.assignee && issue.assignee) out.add(jiraUser(site, issue.assignee));
  for (const f of rule.userFields) for (const u of pickedUsers(issue.fields?.[f])) out.add(jiraUser(site, u));
  for (const f of rule.groupFields) for (const g of pickedGroups(issue.fields?.[f])) out.add(jiraGroup(site, g));
  return [...out].sort();
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- query time: the asker's side ----

// A person's Jira keys, from their Atlassian account (found by email) and its groups.
export function jiraKeysFor(site: string, account: { accountId: string; groupIds: string[]; licensed: boolean }): string[] {
  return [
    jiraAnyone(site),
    jiraUser(site, account.accountId),
    ...(account.licensed ? [jiraLoggedIn(site)] : []),
    ...account.groupIds.map((g) => jiraGroup(site, g)),
  ];
}

// Elasticsearch filter for both layers. Goes inside every query, including the kNN clause.
export function jiraFilter(keys: string[]) {
  return [
    { terms: { acl_container: keys } },
    { bool: { should: [{ term: { restricted: false } }, { terms: { acl_item: keys } }], minimum_should_match: 1 } },
  ];
}

export function canSeeJira(d: { acl_container: string[]; restricted: boolean; acl_item: string[] }, keys: string[]): boolean {
  const k = new Set(keys);
  return d.acl_container.some((p) => k.has(p)) && (!d.restricted || d.acl_item.some((p) => k.has(p)));
}

// What the live re-check found for one issue: Jira's own answer to "can this account browse it now?"
export type LiveCheck = { state: "ok" } | { state: "denied" } | { state: "error"; error: string };

export function recheck(live: LiveCheck | undefined): { ok: true } | { ok: false; reason: string } {
  if (!live) return { ok: false, reason: "not re-checked; withheld to be safe" };
  switch (live.state) {
    case "ok":
      return { ok: true };
    case "denied":
      return { ok: false, reason: "no Browse permission in Jira now (access removed, security level, or issue deleted)" };
    case "error":
      return { ok: false, reason: `couldn't re-check with Jira (${live.error}); withheld to be safe` };
  }
}
