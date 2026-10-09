// Building the non-search audit records: permission and content changes seen by a sync. Pure, unit-tested.
import type { Access, AuditItem, ContentChangeEvent, PermissionChangeEvent, SyncVia } from "./chain.js";

// What we knew about an item before and after a sync step.
export type Snapshot = { title: string; path?: string; access: Access; modified_at: string | null };

const sorted = (a: string[] | undefined) => [...new Set(a ?? [])].sort();

// Normalised, so the same access always compares (and hashes) the same.
export function access(labels: string[], restrictedTo?: string[] | null): Access {
  return restrictedTo ? { labels: sorted(labels), restricted_to: sorted(restrictedTo) } : { labels: sorted(labels) };
}

export const sameAccess = (a: Access, b: Access) =>
  JSON.stringify([sorted(a.labels), a.restricted_to ? sorted(a.restricted_to) : null]) ===
  JSON.stringify([sorted(b.labels), b.restricted_to ? sorted(b.restricted_to) : null]);

// "lost: drive:user:dave@x.com; gained: drive:user:erin@x.com; now restricted to: …"
export function describeAccessChange(before: Access, after: Access): string {
  const diff = (a: string[] = [], b: string[] = []) => ({ lost: a.filter((x) => !b.includes(x)), gained: b.filter((x) => !a.includes(x)) });
  const parts: string[] = [];
  const l = diff(before.labels, after.labels);
  if (l.lost.length) parts.push(`lost: ${l.lost.join(", ")}`);
  if (l.gained.length) parts.push(`gained: ${l.gained.join(", ")}`);
  if (!before.restricted_to && after.restricted_to) parts.push(`now restricted to: ${after.restricted_to.join(", ") || "nobody"}`);
  else if (before.restricted_to && !after.restricted_to) parts.push("restriction removed");
  else if (before.restricted_to && after.restricted_to) {
    const r = diff(before.restricted_to, after.restricted_to);
    if (r.lost.length) parts.push(`restriction lost: ${r.lost.join(", ")}`);
    if (r.gained.length) parts.push(`restriction gained: ${r.gained.join(", ")}`);
  }
  return parts.join("; ") || "unchanged";
}

// The records one sync step produces for one item: none, a permission change, a content change, or both.
// A new item is "added" unless quietAdd (a first backfill, summarised once instead).
// contentChanged: set it when the source knows better than the modified time (Drive bumps modifiedTime
// on a sharing change, so a sharing-only change would otherwise also look like an edit).
// permissionChangedAt: when the sharing changed, if the source says (Drive's change feed). An edit's time is
// the item's own modified time (next.modified_at).
export function changeEvents(
  source: string,
  via: SyncVia,
  id: string,
  prev: Snapshot | null,
  next: Snapshot,
  opts: { quietAdd?: boolean; detectedAt?: string; indexedAt?: string; contentChanged?: boolean; permissionChangedAt?: string | null } = {},
): (PermissionChangeEvent | ContentChangeEvent)[] {
  const item: AuditItem = { id, source, title: next.title, ...(next.path ? { path: next.path } : {}) };
  const now = new Date().toISOString();
  const detected_at = opts.detectedAt ?? now;
  const indexed_at = opts.indexedAt ?? now;
  const content = (change: "added" | "updated"): ContentChangeEvent => ({
    kind: "content_change",
    actor: "system",
    via,
    source,
    change,
    item,
    changed_at: next.modified_at,
    detected_at,
    indexed_at,
  });
  if (!prev) return opts.quietAdd ? [] : [content("added")];
  const out: (PermissionChangeEvent | ContentChangeEvent)[] = [];
  if (!sameAccess(prev.access, next.access)) {
    out.push({
      kind: "permission_change",
      actor: "system",
      via,
      source,
      item,
      old_access: prev.access,
      new_access: next.access,
      summary: describeAccessChange(prev.access, next.access),
      changed_at: opts.permissionChangedAt ?? null,
      detected_at,
    });
  }
  const edited = opts.contentChanged ?? prev.modified_at !== next.modified_at;
  if (edited || prev.title !== next.title || (prev.path ?? "") !== (next.path ?? "")) out.push(content("updated"));
  return out;
}

// changedAt: when it was deleted in the source, if the source says; otherwise null (only detected_at is known).
export function deletedEvent(source: string, via: SyncVia, item: AuditItem, changedAt: string | null = null, detectedAt?: string): ContentChangeEvent {
  const now = new Date().toISOString();
  return { kind: "content_change", actor: "system", via, source, change: "deleted", item, changed_at: changedAt, detected_at: detectedAt ?? now, indexed_at: now };
}
