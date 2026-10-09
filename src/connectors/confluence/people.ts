// Person → their Atlassian account and Confluence keys, looked up fresh (short cache) at query time.
// The account comes from the person's "Connect Jira" link: Confluence is on the same site, so the
// Atlassian account ID is the same person. Never from matching emails.
import { getLink } from "../jira/store.js";
import { confluenceKeysFor } from "./acl.js";
import { ConfluenceError, userGroups } from "./client.js";
import { confluenceConfig } from "./config.js";

export type ConfluenceAccess = { accountId: string; keys: string[] };

const TTL_MS = 5 * 60_000; // group changes reach Search within 5 minutes; the live re-check covers the gap
const cache = new Map<string, { at: number; access: ConfluenceAccess | null }>();

export const forgetAccess = (personId: string) => cache.delete(personId);

// null: this person hasn't connected their Atlassian account, or it's gone from the site. Fail closed: nothing.
export async function confluenceAccess(personId: string): Promise<ConfluenceAccess | null> {
  const hit = cache.get(personId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.access;

  const link = await getLink(personId);
  let access: ConfluenceAccess | null = null;
  if (link) {
    try {
      const { account_id: accountId } = link;
      const groups = await userGroups(accountId);
      access = { accountId, keys: confluenceKeysFor(confluenceConfig.site, { accountId, groupIds: groups.map((g) => g.id) }) };
    } catch (e) {
      if (!(e instanceof ConfluenceError && e.status === 404)) throw e; // account deleted: no access
    }
  }
  cache.set(personId, { at: Date.now(), access });
  return access;
}
