// Person → their Atlassian account and Jira keys, looked up fresh (short cache) at query time.
// The account comes only from the person's own "Connect Jira" (auth.ts), never from matching emails.
import { jiraKeysFor } from "./acl.js";
import { hasProductAccess, JiraError, userGroups } from "./client.js";
import { jiraConfig } from "./config.js";
import { getLink } from "./store.js";

export type JiraAccess = { accountId: string; keys: string[] };

const TTL_MS = 5 * 60_000; // group membership changes reach Search within 5 minutes; the live re-check covers the gap
const cache = new Map<string, { at: number; access: JiraAccess | null }>();

export const forgetAccess = (personId: string) => cache.delete(personId);

// null: this person hasn't connected Jira, or their account is gone from the site. Fail closed: nothing from Jira.
export async function jiraAccess(personId: string): Promise<JiraAccess | null> {
  const hit = cache.get(personId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.access;

  const link = await getLink(personId);
  let access: JiraAccess | null = null;
  if (link) {
    try {
      const { account_id: accountId } = link;
      const [groups, licensed] = await Promise.all([userGroups(accountId), hasProductAccess(accountId)]);
      access = { accountId, keys: jiraKeysFor(jiraConfig.site, { accountId, groupIds: groups.map((g) => g.groupId), licensed }) };
    } catch (e) {
      if (!(e instanceof JiraError && e.status === 404)) throw e; // account deleted: no access
    }
  }
  cache.set(personId, { at: Date.now(), access });
  return access;
}
