// npm run seed:jira — builds the Jira demo (seedData.ts; scenario at its top) on a Jira Cloud site:
// people, groups, roles, projects, picker fields, permission and security schemes, issues and comments.
// Writes only to Jira; the app picks everything up through `npm run jira:backfill`. Safe to re-run: things
// are found by name and brought in line, and issues that already exist (by key) are left alone.
//
// `-- --update` also brings existing issues in line with seedData.ts: fields, security level and status,
// and their comments are replaced when they differ (deleting the issue instead would lose its key for good).
//
// Runs as a site admin (JIRA_ADMIN_EMAIL / JIRA_ADMIN_API_TOKEN, normally Carol), never as the crawler.
// Finding people by email here is only for building demo data; the app itself links people with Connect Jira.
// Can't be done by API (see docs/jira-mock-data-plan.md, "After seeding"): the Administer Jira global
// permission for brain-crawler, the crawler's time zone, the Connect Jira OAuth app, and backdated dates.
import "../../../config.js"; // loads .env
import { adfToText } from "../adf.js";
import { call, JiraError, type Creds } from "../client.js";
import { jiraConfig } from "../config.js";
import {
  FIELDS,
  GROUPS,
  ISSUES,
  NEW_ROLES,
  PERMISSION_SCHEMES,
  PERSONA_NAMES,
  PROJECTS,
  SECURITY_SCHEMES,
  type Actor,
  type FieldKey,
  type Grant,
  type IssueSpec,
  type Member,
  type PersonaKey,
} from "./seedData.js";

const need = (name: string) => {
  const v = process.env[name];
  if (!v || v.endsWith("...")) {
    console.error(`Missing ${name} in .env (see .env.example and docs/jira-mock-data-plan.md)`);
    process.exit(1);
  }
  return v.trim();
};

const UPDATE = process.argv.includes("--update");

if (!jiraConfig.baseUrl) need("JIRA_BASE_URL");
const admin: Creds = { email: need("JIRA_ADMIN_EMAIL"), apiToken: need("JIRA_ADMIN_API_TOKEN") };
const EMAILS: Record<PersonaKey, string> = {
  carol: need("CAROL_EMAIL"),
  alice: need("ALICE_EMAIL"),
  bob: need("BOB_EMAIL"),
  dave: need("DAVE_EMAIL"),
  crawler: need("JIRA_EMAIL"),
};

const get = <T>(path: string) => call<T>("GET", path, undefined, admin);
const post = <T>(path: string, body: unknown, creds = admin) => call<T>("POST", path, body, creds);
const put = <T>(path: string, body: unknown) => call<T>("PUT", path, body, admin);
const del = (path: string) => call<void>("DELETE", path, undefined, admin);
const qs = (p: Record<string, string | number>) => new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString();
const is404 = (e: unknown) => e instanceof JiraError && e.status === 404;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const warnings: string[] = [];
const warn = (m: string) => (warnings.push(m), console.warn(`  ! ${m}`));
const step = (m: string) => console.log(`\n${m}`);
const done = (m: string) => console.log(`  ${m}`);

// Plain text → Atlassian Document Format: blank lines split paragraphs, `backticks` become code.
function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n{2,}/).map((para) => ({
      type: "paragraph",
      content: para
        .split("`")
        .map((t, i) => (i % 2 ? { type: "text", text: t, marks: [{ type: "code" }] } : { type: "text", text: t }))
        .filter((n) => n.text),
    })),
  };
}

async function pages<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let startAt = 0; ; ) {
    const r = await get<{ values: T[]; isLast?: boolean; total?: number }>(`${path}${path.includes("?") ? "&" : "?"}${qs({ startAt, maxResults: 50 })}`);
    out.push(...r.values);
    if (r.isLast !== false || !r.values.length) return out;
    startAt += r.values.length;
  }
}

// ---- 1. people ----

type Account = { accountId: string; accountType?: string; emailAddress?: string; active?: boolean };

async function findAccount(key: PersonaKey): Promise<string | null> {
  const override = process.env[`${key.toUpperCase()}_JIRA_ACCOUNT_ID`];
  if (override) return override.trim();
  const email = EMAILS[key].toLowerCase();
  const found = (await get<Account[]>(`/rest/api/3/user/search?${qs({ query: email, maxResults: 10 })}`)).filter((u) => u.accountType === "atlassian");
  const exact = found.filter((u) => u.emailAddress?.toLowerCase() === email);
  if (exact.length === 1) return exact[0].accountId;
  // Emails are often hidden from other users' searches; one result for an email query is that person.
  if (!exact.length && found.length === 1) return found[0].accountId;
  if (found.length > 1) warn(`${EMAILS[key]} matches ${found.length} accounts; set ${key.toUpperCase()}_JIRA_ACCOUNT_ID`);
  return null;
}

async function people(): Promise<Record<PersonaKey, string>> {
  step("People");
  const ids = {} as Record<PersonaKey, string>;
  const invited: string[] = [];
  for (const key of Object.keys(EMAILS) as PersonaKey[]) {
    const id = await findAccount(key);
    if (id) {
      ids[key] = id;
      done(`${PERSONA_NAMES[key]}: ${id}`);
      continue;
    }
    try {
      await post("/rest/api/3/user", { emailAddress: EMAILS[key], products: ["jira-software"] });
      invited.push(`${PERSONA_NAMES[key]} (${EMAILS[key]})`);
    } catch (e) {
      throw new Error(`Couldn't find or invite ${PERSONA_NAMES[key]} (${EMAILS[key]}): ${(e as Error).message}. Invite them in admin.atlassian.com, or set ${key.toUpperCase()}_JIRA_ACCOUNT_ID.`);
    }
  }
  if (invited.length) {
    console.log(`\nInvited ${invited.join(", ")}. Each must accept the invite email, then run \`npm run seed:jira\` again.`);
    process.exit(0);
  }
  for (const key of Object.keys(ids) as PersonaKey[]) {
    const u = await get<{ active?: boolean; applicationRoles?: { size?: number } }>(`/rest/api/3/user?${qs({ accountId: ids[key], expand: "applicationRoles" })}`);
    if (u.active === false) warn(`${PERSONA_NAMES[key]}'s account is inactive`);
    else if (!u.applicationRoles?.size) warn(`${PERSONA_NAMES[key]} has no Jira product access yet (accepted the invite? admin.atlassian.com → Users → Grant access)`);
  }
  return ids;
}

// ---- 2. groups ----

async function groups(ids: Record<PersonaKey, string>): Promise<Record<string, string>> {
  step("Groups");
  const out: Record<string, string> = {};
  for (const [name, members] of Object.entries(GROUPS)) {
    let g = (await get<{ values: { groupId: string; name: string }[] }>(`/rest/api/3/group/bulk?${qs({ groupName: name })}`)).values.find((x) => x.name === name);
    if (!g) g = await post<{ groupId: string; name: string }>("/rest/api/3/group", { name });
    out[name] = g.groupId;
    // Exactly these members: a stray member would change who sees what.
    const want = new Set(members.map((m) => ids[m]));
    const have = new Set((await pages<{ accountId: string }>(`/rest/api/3/group/member?${qs({ groupId: g.groupId, includeInactiveUsers: "true" })}`)).map((m) => m.accountId));
    for (const id of want) if (!have.has(id)) await post(`/rest/api/3/group/user?${qs({ groupId: g.groupId })}`, { accountId: id });
    for (const id of have) if (!want.has(id)) await del(`/rest/api/3/group/user?${qs({ groupId: g.groupId, accountId: id })}`);
    done(`${name}: ${members.map((m) => PERSONA_NAMES[m]).join(", ")}`);
  }
  return out;
}

// ---- 3. roles ----

async function roles(): Promise<Record<string, string>> {
  step("Roles");
  let all = await get<{ id: number; name: string }[]>("/rest/api/3/role");
  for (const r of NEW_ROLES) if (!all.some((x) => x.name === r.name)) await post("/rest/api/3/role", r);
  all = await get<{ id: number; name: string }[]>("/rest/api/3/role");
  const out = Object.fromEntries(all.map((r) => [r.name, String(r.id)]));
  for (const p of PROJECTS) for (const name of Object.keys(p.roles)) if (!out[name]) throw new Error(`No "${name}" role on this site; create it under ⚙ Settings → System → roles`);
  done(Object.keys(out).join(", "));
  return out;
}

// ---- 4. projects and role members ----

type Project = { id: string; key: string; style?: string };

async function projects(ids: Record<PersonaKey, string>, groupIds: Record<string, string>, roleIds: Record<string, string>): Promise<Record<string, Project>> {
  step("Projects");
  const out: Record<string, Project> = {};
  for (const spec of PROJECTS) {
    let p: Project;
    try {
      p = await get<Project>(`/rest/api/3/project/${spec.key}`);
    } catch (e) {
      if (!is404(e)) throw e;
      await post("/rest/api/3/project", {
        key: spec.key,
        name: spec.name,
        projectTypeKey: "software",
        projectTemplateKey: "com.pyxis.greenhopper.jira:gh-simplified-kanban-classic", // company-managed Kanban
        leadAccountId: ids.carol,
        assigneeType: "UNASSIGNED",
      });
      p = await get<Project>(`/rest/api/3/project/${spec.key}`);
      done(`${spec.key}: created`);
    }
    if (p.style === "next-gen") throw new Error(`${spec.key} is team-managed. Delete it (or pick another key) and re-run: the connector needs company-managed projects.`);
    out[spec.key] = p;

    // Exactly these role members; Jira adds defaults (e.g. atlassian-addons-admin) that would blur the demo.
    for (const [roleName, actors] of Object.entries(spec.roles)) {
      const roleId = roleIds[roleName];
      const r = await get<{ actors?: { actorUser?: { accountId: string }; actorGroup?: { groupId: string } }[] }>(`/rest/api/3/project/${spec.key}/role/${roleId}`);
      const haveUsers = new Set((r.actors ?? []).flatMap((a) => (a.actorUser ? [a.actorUser.accountId] : [])));
      const haveGroups = new Set((r.actors ?? []).flatMap((a) => (a.actorGroup ? [a.actorGroup.groupId] : [])));
      const wantUsers = new Set(actors.flatMap((a: Actor) => ("user" in a ? [ids[a.user]] : [])));
      const wantGroups = new Set(actors.flatMap((a: Actor) => ("group" in a ? [groupIds[a.group]] : [])));
      const addUsers = [...wantUsers].filter((u) => !haveUsers.has(u));
      const addGroups = [...wantGroups].filter((g) => !haveGroups.has(g));
      if (addUsers.length) await post(`/rest/api/3/project/${spec.key}/role/${roleId}`, { user: addUsers });
      if (addGroups.length) await post(`/rest/api/3/project/${spec.key}/role/${roleId}`, { groupId: addGroups });
      for (const u of haveUsers) if (!wantUsers.has(u)) await del(`/rest/api/3/project/${spec.key}/role/${roleId}?${qs({ user: u })}`);
      for (const g of haveGroups) if (!wantGroups.has(g)) await del(`/rest/api/3/project/${spec.key}/role/${roleId}?${qs({ groupId: g })}`);
    }
    done(`${spec.key}: roles set`);
  }
  return out;
}

// ---- 4b. work types ----

// A new site may only have Epic and Story. The seeded issues are Tasks and Bugs, and placeholders are Tasks.
async function workTypes(projectsByKey: Record<string, Project>) {
  step("Work types");
  const want = [...new Set(["Task", ...ISSUES.map((i) => i.type)])];
  type IssueType = { id: string; name: string; scope?: unknown };
  let all = (await get<IssueType[]>("/rest/api/3/issuetype")).filter((t) => !t.scope); // skip team-managed projects' own types
  for (const name of want) {
    if (!all.some((t) => t.name === name)) await post("/rest/api/3/issuetype", { name, description: `${name} (created by seed:jira)`, type: "standard" });
  }
  all = (await get<IssueType[]>("/rest/api/3/issuetype")).filter((t) => !t.scope);
  const ids = want.map((n) => all.find((t) => t.name === n)!.id);

  for (const p of Object.values(projectsByKey)) {
    const [link] = await pages<{ issueTypeScheme: { id: string; isDefault?: boolean } }>(`/rest/api/3/issuetypescheme/project?${qs({ projectId: p.id })}`);
    if (!link || link.issueTypeScheme.isDefault) continue; // the default scheme offers every work type
    const have = new Set((await pages<{ issueTypeId: string }>(`/rest/api/3/issuetypescheme/mapping?${qs({ issueTypeSchemeId: link.issueTypeScheme.id })}`)).map((m) => m.issueTypeId));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) await put(`/rest/api/3/issuetypescheme/${link.issueTypeScheme.id}/issuetype`, { issueTypeIds: missing });
  }
  done(`${want.join(", ")} available in ${Object.keys(projectsByKey).join(", ")}`);
}

// ---- 5. picker fields ----

type FieldInfo = { id: string; name: string; schema?: { custom?: string }; searcherKey?: string; isLocked?: boolean };

// A field Jira can use in a permission grant: the right type AND searchable (has a search template).
// A site may already have a same-named field (e.g. a built-in "Approvers" without a searcher): give it a
// searcher if Jira lets us, otherwise create our own field next to it.
async function pickerField(f: (typeof FIELDS)[FieldKey]): Promise<string> {
  const found = (await pages<FieldInfo>(`/rest/api/3/field/search?${qs({ type: "custom", query: f.name, expand: "searcherKey,isLocked" })}`)).filter(
    (x) => x.name === f.name && x.schema?.custom === f.type,
  );
  const ready = found.find((x) => x.searcherKey);
  if (ready) return ready.id;
  for (const x of found.filter((x) => !x.isLocked)) {
    try {
      await put(`/rest/api/3/field/${x.id}`, { searcherKey: f.searcherKey });
      done(`${f.name}: made existing field ${x.id} searchable`);
      return x.id;
    } catch (e) {
      warn(`${f.name}: couldn't make existing field ${x.id} searchable (${(e as Error).message}); creating a new one`);
    }
  }
  if (found.length) warn(`${f.name}: the site already has a field with this name (${found.map((x) => x.id).join(", ")}) that can't be used in permission grants; creating a separate "${f.name}" field`);
  return (await post<{ id: string }>("/rest/api/3/field", { name: f.name, description: f.description, type: f.type, searcherKey: f.searcherKey })).id;
}

async function fields(): Promise<Record<FieldKey, string>> {
  step("Picker fields");
  const out = {} as Record<FieldKey, string>;
  for (const [key, f] of Object.entries(FIELDS) as [FieldKey, (typeof FIELDS)[FieldKey]][]) {
    out[key] = await pickerField(f);
    const id = out[key];

    // A field with no context can't hold a value anywhere. Left global: harmless, and simpler than per-project.
    const contexts = await pages<{ id: string }>(`/rest/api/3/field/${id}/context`);
    if (!contexts.length) await post(`/rest/api/3/field/${id}/context`, { name: "Default", projectIds: [], issueTypeIds: [] });

    // On the project's screens, or Jira refuses to set it when creating or editing issues.
    const screens = (await pages<{ id: number; name: string }>(`/rest/api/3/screens?${qs({ queryString: `${f.project}:` })}`)).filter((s) => s.name.startsWith(`${f.project}:`));
    if (!screens.length) warn(`no screens named "${f.project}: …" found; add ${f.name} to ${f.project}'s screens by hand`);
    for (const s of screens) {
      const [tab] = await get<{ id: number }[]>(`/rest/api/3/screens/${s.id}/tabs`);
      if (!tab) continue;
      const onTab = await get<{ id: string }[]>(`/rest/api/3/screens/${s.id}/tabs/${tab.id}/fields`);
      if (!onTab.some((x) => x.id === id)) await post(`/rest/api/3/screens/${s.id}/tabs/${tab.id}/fields`, { fieldId: id });
    }
    done(`${f.name}: ${id} (on ${screens.length} ${f.project} screen(s))`);
  }
  return out;
}

// ---- 6. permission schemes ----

function holder(g: Grant, ids: Record<PersonaKey, string>, groupIds: Record<string, string>, roleIds: Record<string, string>, fieldIds: Record<FieldKey, string>) {
  if (g === "reporter" || g === "assignee") return { type: g };
  if ("role" in g) return { type: "projectRole", parameter: roleIds[g.role] };
  if ("group" in g) return { type: "group", value: groupIds[g.group] }; // by ID: names can change
  if ("user" in g) return { type: "user", parameter: ids[g.user] };
  if ("userField" in g) return { type: "userCustomField", parameter: fieldIds[g.userField] };
  return { type: "groupCustomField", parameter: fieldIds[g.groupField] };
}

async function permissionSchemes(...ctx: [Record<PersonaKey, string>, Record<string, string>, Record<string, string>, Record<FieldKey, string>]) {
  step("Permission schemes");
  const existing = (await get<{ permissionSchemes: { id: number; name: string }[] }>("/rest/api/3/permissionscheme")).permissionSchemes;
  for (const [projectKey, s] of Object.entries(PERMISSION_SCHEMES)) {
    const permissions = Object.entries(s.grants).flatMap(([permission, grants]) => grants.map((g) => ({ permission, holder: holder(g, ...ctx) })));
    const body = { name: s.name, description: "Created by npm run seed:jira (HMA Brain demo).", permissions };
    let id = existing.find((x) => x.name === s.name)?.id;
    if (id) await put(`/rest/api/3/permissionscheme/${id}`, body); // replaces every grant: exactly the seed's
    else id = (await post<{ id: number }>("/rest/api/3/permissionscheme", body)).id;
    await put(`/rest/api/3/project/${projectKey}/permissionscheme`, { id });
    done(`${s.name} → ${projectKey} (${permissions.length} grants)`);
  }
}

// ---- 7. issue security schemes ----

type Level = { id: string; name: string };

// Returns each project's levels by name.
async function securitySchemes(projectsByKey: Record<string, Project>, ids: Record<PersonaKey, string>, groupIds: Record<string, string>): Promise<Record<string, Record<string, Level>>> {
  step("Issue security");
  const out: Record<string, Record<string, Level>> = {};
  // Security level members take the group NAME (Jira rejects the ID here: "The group <id> isn't a valid parameter").
  const member = (m: Member) => ("user" in m ? { type: "user", parameter: ids[m.user] } : { type: "group", parameter: m.group });
  const existing = (await get<{ issueSecuritySchemes: { id: number; name: string }[] }>("/rest/api/3/issuesecurityschemes")).issueSecuritySchemes;
  for (const [projectKey, s] of Object.entries(SECURITY_SCHEMES)) {
    let schemeId = existing.find((x) => x.name === s.name)?.id;
    if (!schemeId) {
      schemeId = Number(
        (
          await post<{ id: string | number }>("/rest/api/3/issuesecurityschemes", {
            name: s.name,
            description: "Created by npm run seed:jira (HMA Brain demo).",
            levels: s.levels.map((l) => ({ name: l.level, description: l.description, isDefault: false, members: l.members.map(member) })),
          })
        ).id,
      );
    }
    const levels: Record<string, Level> = {};
    for (const l of s.levels) {
      const find = async () => (await get<{ levels?: { id: string | number; name: string }[] }>(`/rest/api/3/issuesecurityschemes/${schemeId}`)).levels?.find((x) => x.name === l.level);
      let level = await find();
      if (!level) {
        // Without members: users sent here are stored with no account ID. The sync below adds them.
        await put(`/rest/api/3/issuesecurityschemes/${schemeId}/level`, { levels: [{ name: l.level, description: l.description, isDefault: false }] });
        level = await find();
      }
      if (!level) throw new Error(`Couldn't create level "${l.level}" in ${s.name}`);
      const levelId = String(level.id);

      // Members: add what's missing. The crawler must be in every level, or restricted issues are never indexed.
      // This endpoint ignores levelId and lists the whole scheme, so filter by level.
      type LevelMember = { id: string; issueSecurityLevelId: string; holder: { type: string; parameter?: string; value?: string } };
      const all = await pages<LevelMember>(`/rest/api/3/issuesecurityschemes/level/member?${qs({ schemeId, levelId })}`);
      const inLevel = all.filter((h) => String(h.issueSecurityLevelId) === levelId);
      // A user member with no account ID (left by an older seed) grants nothing: remove it.
      for (const h of inLevel.filter((h) => h.holder.type === "user" && !h.holder.parameter && !h.holder.value))
        await del(`/rest/api/3/issuesecurityschemes/${schemeId}/level/${levelId}/member/${h.id}`);
      const have = inLevel.filter((h) => !(h.holder.type === "user" && !h.holder.parameter && !h.holder.value));
      // Jira reports a group member by name (parameter) and ID (value); match either.
      const isMember = (m: Member, h: { type: string; parameter?: string; value?: string }) =>
        "user" in m ? h.type === "user" && (h.parameter === ids[m.user] || h.value === ids[m.user]) : h.type === "group" && (h.parameter === m.group || h.value === groupIds[m.group]);
      const missing = l.members.filter((m) => !have.some((h) => isMember(m, h.holder))).map(member);
      if (missing.length) await put(`/rest/api/3/issuesecurityschemes/${schemeId}/level/${levelId}/member`, { members: missing });
      levels[l.level] = { id: levelId, name: l.level };
    }
    const levelId = levels[s.levels[0].level].id; // what old levels map to if the scheme has to be swapped

    // Attaching a scheme runs as a background task in Jira: wait for it, so issues can use the level.
    const project = projectsByKey[projectKey];
    type SchemeRef = { id?: number | string };
    const current: SchemeRef = await get<SchemeRef>(`/rest/api/3/project/${project.id}/issuesecuritylevelscheme`).catch((e) => (is404(e) ? {} : Promise.reject(e)));
    if (String(current.id ?? "") !== String(schemeId)) {
      try {
        // Simplest: set it on the project itself (fine while the project's issues have no level yet).
        await put(`/rest/api/3/project/${project.id}`, { issueSecurityScheme: Number(schemeId) });
      } catch (e) {
        // Fallback: the dedicated (asynchronous) endpoint, which wants every old level mapped to a new one.
        const oldLevels = current.id
          ? ((await get<{ levels?: { id: string | number }[] }>(`/rest/api/3/issuesecurityschemes/${current.id}`)).levels ?? []).map((l) => String(l.id))
          : [];
        const oldToNewSecurityLevelMappings = (oldLevels.length ? oldLevels : ["-1"]).map((oldLevelId) => ({ oldLevelId, newLevelId: levelId }));
        warn(`setting ${s.name} on ${projectKey} directly failed (${(e as Error).message}); trying the scheme-association endpoint`);
        await put("/rest/api/3/issuesecurityschemes/project", { projectId: project.id, schemeId: String(schemeId), oldToNewSecurityLevelMappings });
      }
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const now: SchemeRef = await get<SchemeRef>(`/rest/api/3/project/${project.id}/issuesecuritylevelscheme`).catch(() => ({}));
        if (String(now.id ?? "") === String(schemeId)) break;
        if (i === 29) warn(`${s.name} is still being attached to ${projectKey}; if secured issues fail below, wait a minute and re-run`);
      }
    }
    out[projectKey] = levels;
    done(`${s.name} → ${projectKey} (levels ${s.levels.map((l) => `"${l.level}"`).join(", ")})`);
  }
  return out;
}

// ---- 8. issues ----

const PLACEHOLDER = "[seed placeholder, deleted by seed:jira]";
const keyNum = (key: string) => Number(key.split("-")[1]);

async function jql(query: string): Promise<{ id: string; key: string }[]> {
  const out: { id: string; key: string }[] = [];
  let nextPageToken: string | undefined;
  do {
    const r = await post<{ issues: { id: string; key: string }[]; nextPageToken?: string }>("/rest/api/3/search/jql", {
      jql: query,
      fields: ["summary"],
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    out.push(...r.issues);
    nextPageToken = r.nextPageToken;
  } while (nextPageToken);
  return out;
}

async function visibleTo(key: string, creds?: Creds): Promise<boolean> {
  try {
    await call("GET", `/rest/api/3/issue/${key}?fields=summary`, undefined, creds);
    return true;
  } catch (e) {
    if (is404(e)) return false;
    throw e;
  }
}

// Carol can miss an issue whose security level she isn't (yet) in; the crawler is in every level. Treating such an
// issue as missing would burn a key on a placeholder, so ask both.
const exists = async (key: string) => (await visibleTo(key, admin)) || (!!jiraConfig.apiToken && (await visibleTo(key)));

async function deleteIssues(keys: string[]) {
  for (let i = 0; i < keys.length; i += 5) await Promise.all(keys.slice(i, i + 5).map((k) => del(`/rest/api/3/issue/${k}`).catch((e) => warn(`couldn't delete placeholder ${k}: ${e.message}`))));
}

async function createPlaceholders(project: string, type: string, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let left = n; left > 0; left -= 50) {
    const batch = Array.from({ length: Math.min(50, left) }, () => ({ fields: { project: { key: project }, issuetype: { name: type }, summary: PLACEHOLDER } }));
    const r = await post<{ issues: { key: string }[]; errors?: unknown[] }>("/rest/api/3/issue/bulk", { issueUpdates: batch });
    if (r.errors?.length) throw new Error(`placeholder issues failed: ${JSON.stringify(r.errors[0]).slice(0, 300)}`);
    out.push(...r.issues.map((i) => i.key));
  }
  return out;
}

type Ctx = { ids: Record<PersonaKey, string>; groupIds: Record<string, string>; fieldIds: Record<FieldKey, string>; levels: Record<string, Record<string, Level>> };

// Everything but project and type, which the placeholder that becomes the issue already has.
function issueFields(spec: IssueSpec, c: Ctx) {
  const project = spec.key.split("-")[0];
  const level = spec.level ? c.levels[project]?.[spec.level] : undefined;
  if (spec.level && !level) throw new Error(`${spec.key} needs security level "${spec.level}", but ${project} has none`);
  return {
    summary: spec.summary,
    description: adf(spec.description),
    labels: spec.labels,
    reporter: { accountId: c.ids[spec.reporter] },
    ...(spec.assignee ? { assignee: { accountId: c.ids[spec.assignee] } } : {}),
    ...(level ? { security: { id: level.id } } : {}),
    ...(spec.approvers ? { [c.fieldIds.approvers]: spec.approvers.map((p) => ({ accountId: c.ids[p] })) } : {}),
    ...(spec.owningTeam ? { [c.fieldIds.owningTeam]: { name: spec.owningTeam } } : {}),
  };
}

async function moveTo(key: string, status: string) {
  const now = (await get<{ fields: { status?: { name?: string } } }>(`/rest/api/3/issue/${key}?fields=status`)).fields.status?.name?.toLowerCase();
  if (now === status.toLowerCase()) return;
  // Kanban templates start issues in "Backlog" (or "Selected for Development") instead of "To Do".
  if (status === "To Do" && (now === "backlog" || now === "selected for development")) return;
  const { transitions } = await get<{ transitions: { id: string; to: { name: string } }[] }>(`/rest/api/3/issue/${key}/transitions`);
  const t = transitions.find((x) => x.to.name.toLowerCase() === status.toLowerCase());
  if (t) await post(`/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
  else warn(`${key}: no transition to "${status}" (available: ${transitions.map((x) => x.to.name).join(", ")})`);
}

async function comment(spec: IssueSpec) {
  for (const c of spec.comments) {
    const token = c.by === "carol" ? null : process.env[`${c.by.toUpperCase()}_JIRA_API_TOKEN`];
    const as: Creds = token ? { email: EMAILS[c.by], apiToken: token.trim() } : admin;
    const text = c.by === "carol" || token ? c.text : `On behalf of ${PERSONA_NAMES[c.by]}: ${c.text}`;
    const body = { body: adf(text), ...(c.restrictedToRole ? { visibility: { type: "role", value: c.restrictedToRole } } : {}) };
    // Jira applies new permissions with a short delay: right after an issue is created, its reporter or
    // assignee can get "issue does not exist" for a few seconds. Retry those briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await post(`/rest/api/3/issue/${spec.key}/comment`, body, as);
        break;
      } catch (e) {
        if (!is404(e) || attempt >= 5) throw e;
        await sleep(2000 * (attempt + 1));
      }
    }
  }
}

// --update: an existing issue's fields, status and comments, brought in line with its spec.
type Existing = { fields: { issuetype?: { name?: string }; security?: { id?: string } | null } };
type ExistingComment = { id: string; body?: unknown; visibility?: { value?: string } | null };

// A level just created or joined applies with a short delay: until then even Carol gets "issue does not
// exist" for an issue she has just moved into it. Wait for it to be readable again.
async function readable(key: string) {
  for (let attempt = 0; !(await visibleTo(key, admin)); attempt++) {
    if (attempt >= 8) throw new Error(`${key}: not readable after setting its security level; check that Carol is a member of it (jira:doctor), then re-run with --update`);
    await sleep(2000 * (attempt + 1));
  }
}

async function update(spec: IssueSpec, c: Ctx) {
  const now = await get<Existing>(`/rest/api/3/issue/${spec.key}?fields=issuetype,security`);
  if (now.fields.issuetype?.name !== spec.type) warn(`${spec.key}: is a ${now.fields.issuetype?.name}, not a ${spec.type}; work type left as is`);
  await put(`/rest/api/3/issue/${spec.key}`, {
    fields: {
      ...issueFields(spec, c),
      ...(spec.assignee ? {} : { assignee: null }),
      ...(!spec.level && now.fields.security ? { security: null } : {}),
    },
  });
  await readable(spec.key);
  await moveTo(spec.key, spec.status);

  // Comments match when the texts (ignoring the "On behalf of …" prefix) and restrictions match, in order.
  const have = (await get<{ comments: ExistingComment[] }>(`/rest/api/3/issue/${spec.key}/comment?maxResults=100`)).comments;
  const norm = (t: string) => t.replace(/^On behalf of \w+: /, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  const same =
    have.length === spec.comments.length &&
    have.every((h, i) => norm(adfToText(h.body)) === norm(spec.comments[i].text) && (h.visibility?.value ?? undefined) === spec.comments[i].restrictedToRole);
  if (same) {
    done(`${spec.key}: updated (comments unchanged)`);
    return;
  }
  for (const h of have) await del(`/rest/api/3/issue/${spec.key}/comment/${h.id}`);
  await comment(spec);
  done(`${spec.key}: updated, ${have.length} old comment(s) replaced by ${spec.comments.length}`);
}

async function finish(spec: IssueSpec) {
  await moveTo(spec.key, spec.status);
  await comment(spec);
  done(`${spec.key}: ${spec.summary}`);
}

// Issue numbers can't be chosen, only reached: Jira hands out the next number and never reuses one. So for
// each missing issue, create one probe of its type. Probe got the number: turn it into the issue. Below it:
// fill the gap with placeholders, then create the issue. Above it: the number is gone; skip with a warning.
async function issues(c: Ctx) {
  step("Issues");
  for (const project of PROJECTS.map((p) => p.key)) {
    // Placeholders from an earlier run that stopped halfway. One that holds a seeded key becomes that issue
    // (deleting it would lose the key for good); the rest are deleted.
    const leftovers = await jql(`project = ${project} AND summary ~ "\\"seed placeholder\\""`);
    const reuse = new Set(leftovers.map((i) => i.key).filter((k) => ISSUES.some((x) => x.key === k)));
    await deleteIssues(leftovers.map((i) => i.key).filter((k) => !reuse.has(k)));

    const placeholders: string[] = [];
    const specs = ISSUES.filter((i) => i.key.startsWith(`${project}-`)).sort((a, b) => keyNum(a.key) - keyNum(b.key));
    for (const spec of specs) {
      if (reuse.has(spec.key)) {
        await put(`/rest/api/3/issue/${spec.key}`, { fields: issueFields(spec, c) });
        await readable(spec.key);
        await finish(spec);
        continue;
      }
      if (await exists(spec.key)) {
        if (UPDATE) {
          await update(spec, c);
          continue;
        }
        // Left as is, except an issue an earlier run created but didn't finish (no comments yet).
        const { total } = await get<{ total: number }>(`/rest/api/3/issue/${spec.key}/comment?maxResults=1`);
        if (!total && spec.comments.length) {
          await finish(spec);
          continue;
        }
        done(`${spec.key}: already there, left as is`);
        continue;
      }
      const target = keyNum(spec.key);
      const [probe] = await createPlaceholders(project, spec.type, 1);
      const n = keyNum(probe);
      if (n > target) {
        placeholders.push(probe);
        warn(`${spec.key}: ${project}'s numbering is already past ${target} (next was ${probe}), so this issue can't get its key. Skipped.`);
        continue;
      }
      if (n === target) {
        await put(`/rest/api/3/issue/${probe}`, { fields: issueFields(spec, c) });
      } else {
        placeholders.push(probe, ...(await createPlaceholders(project, "Task", target - n - 1)));
        const r = await post<{ key: string }>("/rest/api/3/issue", { fields: { project: { key: project }, issuetype: { name: spec.type }, ...issueFields(spec, c) } });
        if (r.key !== spec.key) {
          placeholders.push(r.key);
          warn(`${spec.key}: got ${r.key} instead (someone else created an issue meanwhile?). Removed it; re-run to retry.`);
          continue;
        }
      }
      await finish(spec);
    }
    if (placeholders.length) {
      console.log(`  deleting ${placeholders.length} ${project} placeholder(s)…`);
      await deleteIssues(placeholders);
    }
  }
}

// ---- run ----

console.log(`Seeding Jira demo data on ${jiraConfig.site} as ${admin.email}${UPDATE ? " (--update: existing issues are rewritten)" : ""}`);
try {
  const perms = await get<{ permissions: Record<string, { havePermission: boolean }> }>(`/rest/api/3/mypermissions?${qs({ permissions: "ADMINISTER" })}`);
  if (!perms.permissions?.ADMINISTER?.havePermission) throw new Error(`${admin.email} isn't a Jira admin on ${jiraConfig.site}. JIRA_ADMIN_* must be a site admin (Carol).`);

  const ids = await people();
  const groupIds = await groups(ids);
  const roleIds = await roles();
  const projectsByKey = await projects(ids, groupIds, roleIds);
  await workTypes(projectsByKey);
  const fieldIds = await fields();
  await permissionSchemes(ids, groupIds, roleIds, fieldIds);
  const levels = await securitySchemes(projectsByKey, ids, groupIds);
  await issues({ ids, groupIds, fieldIds, levels });

  // The one grant with no public API. The connector can't read schemes or re-check results without it.
  if (jiraConfig.apiToken) {
    const crawler = await call<{ permissions: Record<string, { havePermission: boolean }> }>("GET", `/rest/api/3/mypermissions?${qs({ permissions: "ADMINISTER" })}`).catch(() => null);
    if (!crawler?.permissions?.ADMINISTER?.havePermission) warn("the crawler doesn't have Administer Jira yet: ⚙ Settings → System → Global permissions → Administer Jira → group brain-crawler");
  }
  const silent = (["alice", "bob", "dave"] as PersonaKey[]).filter((p) => !process.env[`${p.toUpperCase()}_JIRA_API_TOKEN`]);
  if (silent.length) console.log(`\nComments by ${silent.map((p) => PERSONA_NAMES[p]).join(", ")} were posted by ${admin.email} as "On behalf of …" (set *_JIRA_API_TOKEN to post them as themselves on a fresh seed).`);
  console.log(warnings.length ? `\nDone with ${warnings.length} warning(s) above.` : "\nDone. Next: npm run jira:doctor, then npm run jira:backfill.");
  process.exit(0);
} catch (e) {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
}
