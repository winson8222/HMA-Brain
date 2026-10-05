// The seed data run through the connector's own labelling: proves the demo's who-sees-what matrix
// (docs/jira-mock-data-plan.md) and that every seeded action is allowed by the seeded schemes.
import { describe, expect, it } from "vitest";
import { canSeeJira, jiraKeysFor, toRule, type Holder, type RoleActors } from "../connectors/jira/acl.js";
import { issueToDocs, type ProjectAcl, type RawIssue } from "../connectors/jira/docs.js";
import { GROUPS, ISSUES, PERMISSION_SCHEMES, PROJECTS, SECURITY_SCHEMES, type Grant, type IssueSpec, type PersonaKey } from "../connectors/jira/cli/seedData.js";

const SITE = "demo.atlassian.net";
const acct = (p: PersonaKey) => `acct-${p}`;
const gid = (name: string) => `gid-${name}`;
const fid = { approvers: "customfield_1", owningTeam: "customfield_2" };

function holder(g: Grant): Holder {
  if (g === "reporter" || g === "assignee") return { type: g };
  if ("role" in g) return { type: "projectRole", parameter: g.role };
  if ("group" in g) return { type: "group", value: gid(g.group) };
  if ("user" in g) return { type: "user", parameter: acct(g.user) };
  if ("userField" in g) return { type: "userCustomField", parameter: fid[g.userField] };
  return { type: "groupCustomField", parameter: fid[g.groupField] };
}

const rolesOf = (key: string): RoleActors =>
  Object.fromEntries(
    Object.entries(PROJECTS.find((p) => p.key === key)!.roles).map(([role, actors]) => [
      role,
      { users: actors.flatMap((a) => ("user" in a ? [acct(a.user)] : [])), groups: actors.flatMap((a) => ("group" in a ? [gid(a.group)] : [])) },
    ]),
  );

function aclFor(key: string, permission = "BROWSE_PROJECTS"): ProjectAcl {
  const roles = rolesOf(key);
  const sec = SECURITY_SCHEMES[key];
  return {
    project_id: key,
    key,
    name: key,
    browse: toRule(SITE, PERMISSION_SCHEMES[key].grants[permission].map(holder), roles, acct("carol")),
    levels: sec ? { L: toRule(SITE, sec.members.map((m) => ("user" in m ? { type: "user", parameter: acct(m.user) } : { type: "group", value: gid(m.group) })), roles, null) } : {},
    hash: "",
  };
}

const raw = (s: IssueSpec): RawIssue => ({
  id: s.key,
  key: s.key,
  fields: {
    summary: s.summary,
    reporter: { accountId: acct(s.reporter) },
    assignee: s.assignee ? { accountId: acct(s.assignee) } : null,
    security: s.secured ? { id: "L" } : null,
    ...(s.approvers ? { [fid.approvers]: s.approvers.map((p) => ({ accountId: acct(p) })) } : {}),
    ...(s.owningTeam ? { [fid.owningTeam]: { groupId: gid(s.owningTeam), name: s.owningTeam } } : {}),
  },
});

const keysOf = (p: PersonaKey) =>
  jiraKeysFor(SITE, { accountId: acct(p), groupIds: Object.entries(GROUPS).filter(([, m]) => m.includes(p)).map(([g]) => gid(g)), licensed: true });

// Can person p do `permission` on this issue? Same two layers as browsing: the grant AND (for browsing) the level.
const allowed = (p: PersonaKey, s: IssueSpec, permission: string) => {
  const doc = issueToDocs(SITE, "https://x", raw(s), aclFor(s.key.split("-")[0], permission))[0];
  return canSeeJira(permission === "BROWSE_PROJECTS" ? doc : { ...doc, restricted: false }, keysOf(p));
};
const visible = (p: PersonaKey) => ISSUES.filter((s) => allowed(p, s, "BROWSE_PROJECTS")).map((s) => s.key);

describe("seeded who-sees-what", () => {
  it("matches the plan's matrix", () => {
    expect(visible("alice")).toEqual(["PAY-231", "PAY-240", "PAY-241", "PAY-242", "PAY-244", "VEND-4"]);
    expect(visible("bob")).toEqual(["PAY-231", "PAY-240", "PAY-241", "PAY-242", "PAY-244", "SEC-3", "VEND-5"]);
    expect(visible("carol")).toHaveLength(ISSUES.length);
    expect(visible("dave")).toEqual(["PAY-244", "VEND-1", "VEND-2"]);
    expect(visible("crawler")).toHaveLength(ISSUES.length); // or the connector couldn't index it
  });
});

describe("every seeded action is allowed by the seeded schemes", () => {
  for (const s of ISSUES) {
    it(s.key, () => {
      expect(allowed(s.reporter, s, "CREATE_ISSUES")).toBe(true); // a reporter must be able to create issues
      if (s.assignee) expect(allowed(s.assignee, s, "ASSIGNABLE_USER")).toBe(true);
      for (const c of s.comments) {
        expect(allowed(c.by, s, "BROWSE_PROJECTS")).toBe(true);
        expect(allowed(c.by, s, "ADD_COMMENTS")).toBe(true);
      }
    });
  }
});
