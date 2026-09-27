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
