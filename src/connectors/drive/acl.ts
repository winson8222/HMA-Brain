// Drive sharing → permission labels. Pure functions, unit-tested.
import { createHash } from "node:crypto";

export type DrivePermission = {
  type?: string | null;
  role?: string | null;
  emailAddress?: string | null;
  domain?: string | null;
  allowFileDiscovery?: boolean | null;
  deleted?: boolean | null;
};

export const driveUserPrincipal = (email: string) => `drive:user:${email.toLowerCase()}`;
export const driveGroupPrincipal = (email: string) => `drive:group:${email.toLowerCase()}`;
export const driveDomainPrincipal = (domain: string) => `drive:domain:${domain.toLowerCase()}`;
export const DRIVE_ANYONE = "drive:anyone";

// Every role (reader, commenter, writer, owner) can read. A file's permission list already includes
// access inherited from its folders, so this is the complete set.
// "Anyone with the link" / domain links with allowFileDiscovery=false get no label: having the link
// is not the same as being allowed to find the file by searching.
export function permsToAcl(perms: DrivePermission[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const p of perms ?? []) {
    if (p.deleted) continue;
    switch (p.type) {
      case "user":
        if (p.emailAddress) out.add(driveUserPrincipal(p.emailAddress));
        break;
      case "group":
        if (p.emailAddress) out.add(driveGroupPrincipal(p.emailAddress));
        break;
      case "domain":
        if (p.domain && p.allowFileDiscovery) out.add(driveDomainPrincipal(p.domain));
        break;
      case "anyone":
        if (p.allowFileDiscovery) out.add(DRIVE_ANYONE);
        break;
    }
  }
  return [...out].sort();
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Labels are sorted, so the same sharing always gives the same hash.
export const aclHash = (acl: string[]) => sha256(acl.join("\n"));

// ---- query time: the asker's side ----

// Personal Google accounts have no domain to share with, so gmail.com etc. never gets a domain key.
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// A person's Drive keys, from their login email: their own address, their Workspace domain, and
// discoverable public files. Google Groups aren't expanded yet (needs the Workspace Admin SDK),
// so a file shared only with a group is visible to nobody here: safe, just incomplete.
export function driveKeysFor(email: string): string[] {
  const e = email.trim().toLowerCase();
  const keys = [driveUserPrincipal(e), DRIVE_ANYONE];
  const domain = e.split("@")[1];
  if (domain && !CONSUMER_DOMAINS.has(domain)) keys.push(driveDomainPrincipal(domain));
  return keys;
}

// What the live re-check found for one file, read fresh from Drive just before answering.
export type LiveCheck = { state: "ok"; acl: string[] } | { state: "gone" } | { state: "trashed" } | { state: "error"; error: string };

// Can this person still see the file right now? Anything we can't confirm is withheld (fail closed).
export function recheck(live: LiveCheck | undefined, keys: string[]): { ok: true } | { ok: false; reason: string } {
  if (!live) return { ok: false, reason: "not re-checked; withheld to be safe" };
  switch (live.state) {
    case "ok":
      return live.acl.some((p) => keys.includes(p)) ? { ok: true } : { ok: false, reason: "access removed in Drive" };
    case "gone":
      return { ok: false, reason: "deleted in Drive, or the crawler lost access" };
    case "trashed":
      return { ok: false, reason: "moved to trash in Drive" };
    case "error":
      return { ok: false, reason: `couldn't re-check with Drive (${live.error}); withheld to be safe` };
  }
}
