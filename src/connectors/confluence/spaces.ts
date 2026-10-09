// Read one space's permission picture from Confluence: who may view it.
import { sha256, viewLabels } from "./acl.js";
import { spaceReadPrincipals, type Space } from "./client.js";
import { confluenceConfig } from "./config.js";
import type { SpaceAcl } from "./docs.js";

export async function spaceAcl(s: Space): Promise<SpaceAcl> {
  const { labels, unsupported } = viewLabels(confluenceConfig.site, await spaceReadPrincipals(s.id));
  if (unsupported.length) console.warn(`Confluence ${s.key}: skipped View grants we can't label yet (${unsupported.join(", ")}); those people see less here than in Confluence`);
  return { space_id: s.id, key: s.key, name: s.name, view: labels, hash: sha256(JSON.stringify(labels)) };
}
