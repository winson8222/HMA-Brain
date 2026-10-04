// Read one project's permission picture from Jira: Browse Projects grants, role members, security levels.
import { sha256, toRule, type Rule } from "./acl.js";
import { browseGrants, projectRoles, securityLevelMembers, securitySchemeId, type Project } from "./client.js";
import { jiraConfig } from "./config.js";
import type { ProjectAcl } from "./docs.js";

export async function projectAcl(p: Project): Promise<ProjectAcl> {
  const site = jiraConfig.site;
  const [grants, roles, schemeId] = await Promise.all([browseGrants(p.id), projectRoles(p.id), securitySchemeId(p.id)]);
  const lead = p.lead?.accountId ?? null;
  const browse = toRule(site, grants, roles, lead);
  const levels: Record<string, Rule> = {};
  if (schemeId) for (const [id, holders] of Object.entries(await securityLevelMembers(schemeId))) levels[id] = toRule(site, holders, roles, lead);

  const unsupported = [...browse.unsupported, ...Object.values(levels).flatMap((l) => l.unsupported)];
  if (unsupported.length) console.warn(`Jira ${p.key}: skipped grants we can't label yet (${[...new Set(unsupported)].join(", ")}); those people see less here than in Jira`);

  const picture = { browse, levels: Object.fromEntries(Object.entries(levels).sort(([a], [b]) => a.localeCompare(b))) };
  return { project_id: p.id, key: p.key, name: p.name, ...picture, hash: sha256(JSON.stringify(picture)) };
}
