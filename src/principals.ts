// Works out what a user can access, straight from Slack.
import { principalsForUser } from "./acl.js";
import { getWorkspace, web } from "./slack.js";

export type UserAccess = {
  userId: string;
  isGuest: boolean;
  channelIds: string[];
  principals: string[];
  fetchedAt: number;
};

const MAX_AGE_MS = 60_000;
const cache = new Map<string, UserAccess>();

export async function getAccess(userId: string, opts: { fresh?: boolean } = {}): Promise<UserAccess> {
  const hit = cache.get(userId);
  if (!opts.fresh && hit && Date.now() - hit.fetchedAt < MAX_AGE_MS) return hit;

  const { teamId } = await getWorkspace();
  const info = await web.users.info({ user: userId });
  const isGuest = !!(info.user?.is_restricted || info.user?.is_ultra_restricted);

  // Channels this user is a member of (private ones only if the bot is also in them).
  const channelIds: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await web.users.conversations({
      user: userId,
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    channelIds.push(...(r.channels ?? []).map((c: any) => c.id));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const access = {
    userId,
    isGuest,
    channelIds,
    principals: principalsForUser(teamId, userId, isGuest, channelIds),
    fetchedAt: Date.now(),
  };
  cache.set(userId, access);
  return access;
}

// Called on member_joined_channel / member_left_channel.
export function invalidate(userId: string) {
  cache.delete(userId);
}
