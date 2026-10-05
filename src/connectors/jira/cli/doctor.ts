// npm run jira:doctor — check the Jira setup: token, admin permission, projects, permission schemes,
// Connect Jira, and who has linked their Atlassian account.
import { oauthConfigured } from "../auth.js";
import { explain, listProjects, myPermissions, myself } from "../client.js";
import { jiraConfig } from "../config.js";
import { jiraAccess } from "../people.js";
import { allLinks, ensureJiraIndices } from "../store.js";
import { projectAcl } from "../schemes.js";

let problems = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => (problems++, console.log(`  FAIL  ${m}`));
const warn = (m: string) => console.log(`  warn  ${m}`);

if (!jiraConfig.baseUrl || !jiraConfig.email || !jiraConfig.apiToken) {
  console.error("Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env (see .env.example).");
  process.exit(1);
}
console.log(`Jira site ${jiraConfig.site}`);
try {
  const me = await myself();
  ok(`signed in as ${me.emailAddress ?? me.displayName} (time zone ${me.timeZone ?? "unknown"})`);

  const perms = await myPermissions(["ADMINISTER"]);
  if (perms.ADMINISTER) ok("service account has Administer Jira");
  else bad("service account lacks Administer Jira: permission schemes can't be read and results can't be re-checked, so Jira search returns nothing");

  const projects = await listProjects(jiraConfig.projects);
  const missing = jiraConfig.projects.filter((k) => !projects.some((p) => p.key === k));
  if (missing.length) bad(`can't see project(s) ${missing.join(", ")}`);
  if (!projects.length) bad("no projects visible to the service account");
  for (const p of projects) {
    try {
      const acl = await projectAcl(p);
      const levels = Object.keys(acl.levels).length;
      const b = acl.browse;
      const fields = [...b.userFields.map((f) => `user field ${f}`), ...b.groupFields.map((f) => `group field ${f}`)];
      const msg =
        `${p.key}${p.style === "next-gen" ? " (team-managed)" : ""}: ${b.labels.length} browse label(s)` +
        `${b.reporter ? " + reporter" : ""}${b.assignee ? " + assignee" : ""}${fields.length ? ` + ${fields.join(" + ")}` : ""}` +
        `${levels ? `, ${levels} security level(s)` : ""}`;
      if (!b.labels.length && !b.reporter && !b.assignee && !fields.length) warn(`${msg}: nobody would see its issues here`);
      else ok(msg);
    } catch (e) {
      bad(`${p.key}: can't read permissions (${explain(e)}); its issues won't be indexed`);
    }
  }

  if (oauthConfigured()) ok(`Connect Jira is set up (callback ${jiraConfig.redirectUri})`);
  else bad("Connect Jira isn't set up (JIRA_OAUTH_CLIENT_ID / JIRA_OAUTH_CLIENT_SECRET): nobody can link their account, so nobody sees Jira results");

  await ensureJiraIndices();
  const links = await allLinks();
  if (!links.length) warn("nobody has connected Jira yet (Connect page → Connect Jira)");
  for (const l of links) {
    const a = await jiraAccess(l.person_id);
    if (a) ok(`${l.person_id} → ${l.account_name ?? "Atlassian account"} (${l.account_id}), ${a.keys.length} key(s)`);
    else warn(`${l.person_id} is linked to ${l.account_id}, but that account is gone from ${jiraConfig.site}: they see nothing from Jira`);
  }
} catch (e) {
  bad(explain(e));
}
console.log(problems ? `\n${problems} problem(s).` : "\nAll good.");
process.exit(problems ? 1 : 0);
