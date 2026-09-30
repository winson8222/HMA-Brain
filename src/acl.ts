// Permission labels. A doc is visible if any of its labels is in the asker's principal list.
// Every label names its workspace, so labels from different workspaces never collide.

export type ConvKind = "channel" | "dm" | "group_dm";

export type ChannelInfo = {
  id: string;
  name: string; // "#payments" style name for channels, "DM: Alice ↔ Carol" for DMs
  is_private: boolean;
  kind: ConvKind;
  participants?: string[]; // DMs only: person IDs of everyone in it (fixed for the DM's lifetime)
};

export const wsMemberPrincipal = (teamId: string) => `slack:${teamId}:member`;
export const channelPrincipal = (teamId: string, channelId: string) => `slack:${teamId}:channel:${channelId}`;
// A person across workspaces: their email, or a workspace-scoped ID if Slack has no email for them.
export const personPrincipal = (personId: string) => `person:${personId}`;

// Public channel: any full workspace member, or a guest who was added to it.
// Private channel: only its members.
// DM / group DM: exactly its participants. Slack never changes who is in a DM.
export function aclForChannel(teamId: string, ch: ChannelInfo): string[] {
  if (ch.kind !== "channel") return (ch.participants ?? []).map(personPrincipal);
  return ch.is_private
    ? [channelPrincipal(teamId, ch.id)]
    : [wsMemberPrincipal(teamId), channelPrincipal(teamId, ch.id)];
}

// Principals from one Slack account (one person may have accounts in several workspaces).
export function principalsForAccount(teamId: string, isGuest: boolean, channelIds: Iterable<string>): string[] {
  const p: string[] = [];
  if (!isGuest) p.push(wsMemberPrincipal(teamId));
  for (const c of channelIds) p.push(channelPrincipal(teamId, c));
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
