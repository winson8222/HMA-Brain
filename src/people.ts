// People across workspaces, linked by email, and what each one can access, straight from Slack.
import { personPrincipal, principalsForAccount } from "./acl.js";
import { displayName, emailOf, isHuman, workspaces, type Workspace } from "./slack.js";

export type Account = { ws: Workspace; userId: string };

export type Person = { id: string; name: string; email?: string; accounts: Account[] };

export type WorkspaceAccess = {
  teamId: string;
  teamName: string;
  isGuest: boolean;
  channelIds: string[];
};

export type Access = {
  personId: string;
  principals: string[];
  workspaces: WorkspaceAccess[];
  fetchedAt: number;
};

// Everyone who is a real person in at least one workspace.
export async function listPeople(opts: { refresh?: boolean } = {}): Promise<Person[]> {
  const people = new Map<string, Person>();
  for (const ws of await workspaces()) {
    const users = opts.refresh ? await ws.listUsers() : ws.cachedUsers();
    for (const u of users.filter(isHuman)) {
      const id = ws.personIdOf(u);
      const p: Person = people.get(id) ?? { id, name: displayName(u), email: emailOf(u), accounts: [] };
      p.accounts.push({ ws, userId: u.id });
      people.set(id, p);
    }
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function findPerson(personId: string): Promise<Person | undefined> {
  const hit = (await listPeople()).find((p) => p.id === personId);
  return hit ?? (await listPeople({ refresh: true })).find((p) => p.id === personId);
}

const MAX_AGE_MS = 60_000;
const cache = new Map<string, Access>();

export async function getAccess(personId: string, opts: { fresh?: boolean } = {}): Promise<Access> {
  const hit = cache.get(personId);
  if (!opts.fresh && hit && Date.now() - hit.fetchedAt < MAX_AGE_MS) return hit;

  const person = await findPerson(personId);
  const principals = [personPrincipal(personId)]; // DMs they're in
  const perWs: WorkspaceAccess[] = [];

  for (const { ws, userId } of person?.accounts ?? []) {
    const info = await ws.web.users.info({ user: userId });
    const isGuest = !!(info.user?.is_restricted || info.user?.is_ultra_restricted);

    // Channels this account is in (private ones only if the bot is also in them).
    const channelIds: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await ws.web.users.conversations({
        user: userId,
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      channelIds.push(...(r.channels ?? []).map((c: any) => c.id));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);

    principals.push(...principalsForAccount(ws.teamId, isGuest, channelIds));
    perWs.push({ teamId: ws.teamId, teamName: ws.teamName, isGuest, channelIds });
  }

  const access = { personId, principals, workspaces: perWs, fetchedAt: Date.now() };
  cache.set(personId, access);
  return access;
}

// Called on member_joined_channel / member_left_channel.
export async function invalidateAccount(ws: Workspace, userId: string) {
  const u = await ws.getUser(userId).catch(() => undefined);
  cache.delete(u ? ws.personIdOf(u) : `${ws.teamId}:${userId}`);
}
