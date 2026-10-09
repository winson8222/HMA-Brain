// Confluence permissions → labels. Pure functions, unit-tested.
//
// Who can read a page is decided in two layers:
//   1. View permission on the space (users, groups, anonymous).
//   2. The page's view restriction, if it has one, which every descendant inherits. A restriction can only
//      narrow the space permission. So every page doc carries `acl_container` (layer 1) and, when it or an
//      ancestor is restricted, `acl_item` (layer 2): the labels of the NEAREST restricted node. With several
//      restricted ancestors Confluence requires all of them; "nearest" can only over-include, and the live
//      re-check (client.ts canRead) corrects that at query time.
import { createHash } from "node:crypto";
import type { Principal, RawRestriction } from "./client.js";

export const confluenceUser = (site: string, accountId: string) => `confluence:${site}:user:${accountId}`;
export const confluenceGroup = (site: string, groupId: string) => `confluence:${site}:group:${groupId}`;
export const confluenceAnyone = (site: string) => `confluence:${site}:anyone`;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Space View principals → labels. Unknown principal types are skipped (fail closed) and reported.
export function viewLabels(site: string, principals: Principal[]): { labels: string[]; unsupported: string[] } {
  const labels = new Set<string>();
  const unsupported = new Set<string>();
  for (const p of principals) {
    if (p.type === "user" && p.id) labels.add(confluenceUser(site, p.id));
    else if (p.type === "group" && p.id) labels.add(confluenceGroup(site, p.id));
    else if (p.type === "anonymous") labels.add(confluenceAnyone(site));
    else unsupported.add(p.type ?? "unknown");
  }
  return { labels: [...labels].sort(), unsupported: [...unsupported].sort() };
}

// A page's own view restriction → labels; null when it has none (then it inherits its parent's, if any).
export function restrictionLabels(site: string, r: RawRestriction | null): string[] | null {
  if (!r || (!r.users.length && !r.groups.length)) return null;
  return [...r.users.map((u) => confluenceUser(site, u)), ...r.groups.map((g) => confluenceGroup(site, g))].sort();
}

// Effective restriction: the page's own, else the nearest restricted ancestor's (passed in as the parent's effective).
export const effectiveLabels = (own: string[] | null, parentEffective: string[] | null) => own ?? parentEffective;

// ---- query time: the asker's side ----

export function confluenceKeysFor(site: string, account: { accountId: string; groupIds: string[] }): string[] {
  return [confluenceAnyone(site), confluenceUser(site, account.accountId), ...account.groupIds.map((g) => confluenceGroup(site, g))];
}

// Elasticsearch filter for both layers. Goes inside every query, including the kNN clause.
export function confluenceFilter(keys: string[]) {
  return [
    { terms: { acl_container: keys } },
    { bool: { should: [{ term: { restricted: false } }, { terms: { acl_item: keys } }], minimum_should_match: 1 } },
  ];
}

export function canSeeConfluence(d: { acl_container: string[]; restricted: boolean; acl_item: string[] }, keys: string[]): boolean {
  const k = new Set(keys);
  return d.acl_container.some((p) => k.has(p)) && (!d.restricted || d.acl_item.some((p) => k.has(p)));
}

export type LiveCheck = { state: "ok" } | { state: "denied" } | { state: "error"; error: string };

export function recheck(live: LiveCheck | undefined): { ok: true } | { ok: false; reason: string } {
  if (!live) return { ok: false, reason: "not re-checked; withheld to be safe" };
  switch (live.state) {
    case "ok":
      return { ok: true };
    case "denied":
      return { ok: false, reason: "no View permission in Confluence now (access removed, page restricted, or page deleted)" };
    case "error":
      return { ok: false, reason: `couldn't re-check with Confluence (${live.error}); withheld to be safe` };
  }
}
