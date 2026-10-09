// npm run confluence:doctor — check the Confluence setup: token, spaces and their View grants, the
// Confluence Administrator permission (needed for the live re-check), and who has linked their Atlassian account.
import { allLinks, ensureJiraIndices } from "../../jira/store.js";
import { canRead, currentUser, explain, isAuthError, listPages, listSpaces } from "../client.js";
import { confluenceConfig } from "../config.js";
import { confluenceAccess } from "../people.js";
import { spaceAcl } from "../spaces.js";
import { ensureConfluenceIndices } from "../store.js";

let problems = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => (problems++, console.log(`  FAIL  ${m}`));
const warn = (m: string) => console.log(`  warn  ${m}`);

if (!confluenceConfig.baseUrl || !confluenceConfig.email || !confluenceConfig.apiToken) {
  console.error("Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN (or the JIRA_* values) in .env.");
  process.exit(1);
}
console.log(`Confluence site ${confluenceConfig.site}`);
try {
  const me = await currentUser();
  ok(`signed in as ${me.email ?? me.displayName ?? me.accountId}`);

  const spaces = await listSpaces(confluenceConfig.spaces);
  const missing = confluenceConfig.spaces.filter((k) => !spaces.some((s) => s.key.toUpperCase() === k));
  if (missing.length) bad(`can't see space(s) ${missing.join(", ")}`);
  if (!spaces.length) bad("no spaces visible to the service account");
  let samplePage: string | null = null;
  for (const s of spaces) {
    try {
      const acl = await spaceAcl(s);
      if (!acl.view.length) warn(`${s.key}: no View grants we can label; nobody would see its pages here`);
      else ok(`${s.key} (${s.name}): ${acl.view.length} View label(s)`);
      if (!samplePage) for await (const page of listPages(s.id, false)) if ((samplePage = page[0]?.id ?? null)) break;
    } catch (e) {
      bad(`${s.key}: can't read permissions (${explain(e)}); its pages won't be indexed`);
    }
  }

  // The live re-check needs Confluence Administrator: checking any page for our own account proves it.
  if (!samplePage) warn("no pages yet, so the permission check (Confluence Administrator) couldn't be tested");
  else {
    try {
      await canRead(me.accountId, samplePage);
      ok("service account can run the permission check (Confluence Administrator)");
    } catch (e) {
      if (isAuthError(e)) bad("service account lacks Confluence Administrator: results can't be re-checked, so Confluence search returns nothing");
      else bad(`permission check failed: ${explain(e)}`);
    }
  }

  await ensureConfluenceIndices();
  await ensureJiraIndices();
  const links = await allLinks();
  if (!links.length) warn("nobody has connected their Atlassian account yet (Connect page → Connect Jira)");
  for (const l of links) {
    const a = await confluenceAccess(l.person_id);
    if (a) ok(`${l.person_id} → ${l.account_name ?? "Atlassian account"} (${l.account_id}), ${a.keys.length} key(s)`);
    else warn(`${l.person_id} is linked to ${l.account_id}, but that account has no Confluence access on ${confluenceConfig.site}`);
  }
} catch (e) {
  bad(explain(e));
}
console.log(problems ? `\n${problems} problem(s).` : "\nAll good.");
process.exit(problems ? 1 : 0);
