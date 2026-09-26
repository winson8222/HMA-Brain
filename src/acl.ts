// Permission labels. A doc is visible if any of its labels is in the user's principal list.

export type ChannelInfo = { id: string; name: string; is_private: boolean };

export const wsMemberPrincipal = (teamId: string) => `slack:ws:${teamId}:member`;
export const channelPrincipal = (channelId: string) => `slack:channel:${channelId}`;

// Public channel: any full workspace member, or a guest who was added to it.
// Private channel: only its members.
export function aclForChannel(teamId: string, ch: ChannelInfo): string[] {
  return ch.is_private
    ? [channelPrincipal(ch.id)]
    : [wsMemberPrincipal(teamId), channelPrincipal(ch.id)];
}

export function principalsForUser(
  teamId: string,
  userId: string,
  isGuest: boolean,
  channelIds: Iterable<string>,
): string[] {
  const p = [`slack:user:${userId}`];
  if (!isGuest) p.push(wsMemberPrincipal(teamId));
  for (const c of channelIds) p.push(channelPrincipal(c));
  return p;
}

// Elasticsearch filter clause applied to every user query.
export function aclFilter(principals: string[]) {
  return { terms: { acl_container: principals } };
}

export function canSee(acl: string[], principals: string[]): boolean {
  const set = new Set(principals);
  return acl.some((p) => set.has(p));
}
