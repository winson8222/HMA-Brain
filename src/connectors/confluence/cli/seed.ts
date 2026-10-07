// npm run seed:confluence [-- --dry-run | --edit-rollout | --restore-rollout | --restrict-drill | --unrestrict-drill]
//
// Builds the Confluence demo content from seedData.ts on the Jira site: spaces with their viewer groups, pages
// (created, renamed or rewritten to match), view restrictions, and trashes the template pages. Idempotent: a page
// whose version message carries the current content hash is left alone.
// Runs as a site admin (JIRA_ADMIN_EMAIL with JIRA_ADMIN_API_TOKEN or CAROL_JIRA_API_TOKEN), never as the crawler.
import { createHash } from "node:crypto";
import { call, ConfluenceError, explain, type Creds } from "../client.js";
import { confluenceConfig } from "../config.js";
import { DRILL_RESTRICTION, DRILL_TITLE, PAGES, ROLLOUT_DECIDED, ROLLOUT_OPEN_QUESTION, ROLLOUT_TITLE, SPACES, TRASH_TITLE_PREFIX, type PageSpec, type PersonaKey, type Restriction } from "./seedData.js";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const flag = (f: string) => args.has(f);

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k} in .env`);
  return v;
};
const admin: Creds = { email: need("JIRA_ADMIN_EMAIL"), apiToken: process.env.JIRA_ADMIN_API_TOKEN || need("CAROL_JIRA_API_TOKEN") };
const get = <T>(path: string) => call<T>("GET", path, undefined, admin);
const send = <T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => (dry ? (console.log(`  (dry) ${method} ${path}`), undefined as T) : call<T>(method, path, body, admin));

const log = (m: string) => console.log(`  ${m}`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---- plain text → storage format (XHTML) ----

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function block(lines: string[]): string {
  if (lines.every((l) => /^\d+\.\s/.test(l))) return `<ol>${lines.map((l) => `<li><p>${esc(l.replace(/^\d+\.\s/, ""))}</p></li>`).join("")}</ol>`;
  if (lines.every((l) => /^-\s/.test(l))) return `<ul>${lines.map((l) => `<li><p>${esc(l.replace(/^-\s/, ""))}</p></li>`).join("")}</ul>`;
  if (lines.length >= 2 && lines[0].length <= 48 && !/[.:;]$/.test(lines[0])) return `<h2>${esc(lines[0])}</h2>${block(lines.slice(1))}`;
  return `<p>${lines.map(esc).join("<br />")}</p>`;
}
export const toStorage = (text: string) => text.trim().split(/\n{2,}/).map((b) => block(b.split("\n"))).join("");

// ---- lookups ----

type Group = { id: string; name: string };
async function groupsByName(): Promise<Map<string, Group>> {
  const r = await get<{ results?: Group[] }>("/wiki/rest/api/group?limit=200");
  return new Map((r.results ?? []).map((g) => [g.name, g]));
}

const EMAIL_VAR: Record<PersonaKey, string> = { carol: "CAROL_EMAIL", alice: "ALICE_EMAIL", bob: "BOB_EMAIL", dave: "DAVE_EMAIL" };
async function accountId(p: PersonaKey): Promise<string> {
  const override = process.env[`${p.toUpperCase()}_JIRA_ACCOUNT_ID`];
  if (override) return override;
  const email = need(EMAIL_VAR[p]);
  // Confluence can't search users by email; Jira on the same site can.
  const r = await fetch(`${confluenceConfig.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=10`, {
    headers: { Authorization: "Basic " + Buffer.from(`${admin.email}:${admin.apiToken}`).toString("base64"), Accept: "application/json" },
  });
  const users = ((await r.json()) as { accountId: string; accountType?: string }[]).filter((u) => u.accountType === "atlassian");
  if (users.length !== 1) throw new Error(`Can't find ${p} (${email}) on the site: ${users.length} match(es). Set ${p.toUpperCase()}_JIRA_ACCOUNT_ID.`);
  return users[0].accountId;
}

type Space = { id: string; key: string; name: string; homepageId?: string };
type Role = { id: string; name: string };
type Assignment = { roleId: string; principal: { principalType: string; principalId: string } };

// ---- spaces ----

async function ensureSpaces(groups: Map<string, Group>, adminAccountId: string): Promise<Map<string, Space>> {
  const roles = (await get<{ results?: Role[] }>("/wiki/api/v2/space-roles?limit=50")).results ?? [];
  const viewer = roles.find((r) => r.name === "Viewer") ?? roles.find((r) => r.name === "View only");
  const adminRole = roles.find((r) => r.name === "Admin");
  if (!viewer || !adminRole) throw new Error(`No Viewer/Admin role on this site (roles: ${roles.map((r) => r.name).join(", ")})`);
  const existing = new Map(((await get<{ results?: Space[] }>("/wiki/api/v2/spaces?limit=250")).results ?? []).map((s) => [s.key.toUpperCase(), s]));
  const out = new Map<string, Space>();
  for (const spec of SPACES) {
    const wanted = spec.viewers.map((g) => {
      const grp = groups.get(g);
      if (!grp) throw new Error(`Group ${g} doesn't exist on the site (run seed:jira first)`);
      return grp;
    });
    let space = existing.get(spec.key);
    if (!space) {
      log(`create space ${spec.key} with viewers ${spec.viewers.join(", ")}`);
      space = await send<Space>("POST", "/wiki/api/v2/spaces", {
        name: spec.name,
        key: spec.key,
        // Creating a space by API gives the creator no role; without Admin, Carol can't add pages (Confluence says 404).
        roleAssignments: [
          { principal: { principalType: "USER", principalId: adminAccountId }, roleId: adminRole.id },
          ...wanted.map((g) => ({ principal: { principalType: "GROUP", principalId: g.id }, roleId: viewer.id })),
        ],
      });
      if (dry) continue;
      // The create call returns before the space is fully there; re-read it.
      for (let i = 0; i < 10 && !space?.id; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        space = ((await get<{ results?: Space[] }>(`/wiki/api/v2/spaces?keys=${spec.key}&limit=5`)).results ?? [])[0];
      }
      if (!space?.id) throw new Error(`Space ${spec.key} wasn't created`);
    }
    // Make sure every viewer group has the role (the UI-made spaces already do).
    const have = (await get<{ results?: Assignment[] }>(`/wiki/api/v2/spaces/${space.id}/role-assignments?limit=100`)).results ?? [];
    if (!have.some((a) => a.principal.principalType === "USER" && a.principal.principalId === adminAccountId)) {
      log(`${spec.key}: give ${admin.email} the Admin role`);
      await send("POST", `/wiki/api/v2/spaces/${space.id}/role-assignments`, [{ principal: { principalType: "USER", principalId: adminAccountId }, roleId: adminRole.id }]);
    }
    for (const g of wanted) {
      if (have.some((a) => a.principal.principalType === "GROUP" && a.principal.principalId === g.id)) continue;
      log(`${spec.key}: give group ${g.name} the Viewer role`);
      try {
        await send("POST", `/wiki/api/v2/spaces/${space.id}/role-assignments`, [{ principal: { principalType: "GROUP", principalId: g.id }, roleId: viewer.id }]); // the endpoint takes an array
      } catch (e) {
        console.warn(`  ${spec.key}: couldn't assign ${g.name} by API (${explain(e)}); add it by hand in Space settings → Users`);
      }
    }
    out.set(spec.key, space);
  }
  return out;
}

// ---- pages ----

type Page = { id: string; title: string; parentId?: string | null; version?: { number?: number; message?: string } };

async function spacePages(spaceId: string): Promise<Page[]> {
  const out: Page[] = [];
  let next: string | undefined = `/wiki/api/v2/pages?space-id=${spaceId}&status=current&limit=250`;
  while (next) {
    const r: { results?: Page[]; _links?: { next?: string } } = await get(next);
    out.push(...(r.results ?? []));
    next = r._links?.next ? (r._links.next.startsWith("/wiki") ? r._links.next : `/wiki${r._links.next}`) : undefined;
  }
  return out;
}

async function writePage(space: Space, pages: Page[], spec: PageSpec, body: string, byTitle: Map<string, Page>): Promise<Page> {
  const storage = toStorage(body);
  const hash = `seed:${sha(spec.title + storage)}`;
  const parentId = spec.parent ? byTitle.get(spec.parent)?.id : space.homepageId;
  if (spec.parent && !parentId) throw new Error(`${spec.space}: parent page "${spec.parent}" must come before "${spec.title}" in PAGES`);
  let page = pages.find((p) => p.title === spec.title) ?? pages.find((p) => spec.renameFrom?.includes(p.title));
  if (!page) {
    log(`${spec.space}: create "${spec.title}"`);
    page = await send<Page>("POST", "/wiki/api/v2/pages", { spaceId: space.id, status: "current", title: spec.title, ...(parentId ? { parentId } : {}), body: { representation: "storage", value: storage } });
    if (dry) return { id: "dry", title: spec.title };
    // Creating doesn't take a version message; stamp it so the next run skips the page.
    page = await send<Page>("PUT", `/wiki/api/v2/pages/${page.id}`, { id: page.id, status: "current", title: spec.title, spaceId: space.id, body: { representation: "storage", value: storage }, version: { number: 2, message: hash } });
  } else if (page.version?.message !== hash || page.title !== spec.title) {
    log(`${spec.space}: ${page.title !== spec.title ? `rename "${page.title}" → "${spec.title}" and ` : ""}rewrite "${spec.title}"`);
    page = (await send<Page>("PUT", `/wiki/api/v2/pages/${page.id}`, { id: page.id, status: "current", title: spec.title, spaceId: space.id, body: { representation: "storage", value: storage }, version: { number: (page.version?.number ?? 1) + 1, message: hash } })) ?? page;
  } else log(`${spec.space}: "${spec.title}" is current`);
  return page;
}

// Replace the page's restrictions: view for the given people and groups (+ Carol keeps edit), or none.
async function setRestriction(page: Page, r: Restriction | null, ids: Map<PersonaKey, string>, groups: Map<string, Group>) {
  if (!r) {
    log(`unrestrict "${page.title}"`);
    await send("DELETE", `/wiki/rest/api/content/${page.id}/restriction`);
    return;
  }
  log(`restrict "${page.title}" to ${[...r.users, ...r.groups].join(", ")}`);
  const user = r.users.map((p) => ({ type: "known", accountId: ids.get(p)! }));
  const group = r.groups.map((g) => ({ type: "group", id: groups.get(g)!.id, name: g }));
  await send("PUT", `/wiki/rest/api/content/${page.id}/restriction`, [
    { operation: "read", restrictions: { user, group } },
    { operation: "update", restrictions: { user: [{ type: "known", accountId: ids.get("carol")! }], group: [] } },
  ]);
}

// ---- main ----

try {
  console.log(`seed:confluence on ${confluenceConfig.site} as ${admin.email}${dry ? " (dry run)" : ""}`);
  const groups = await groupsByName();
  const personas: PersonaKey[] = ["carol", "alice", "bob", "dave"];
  const ids = new Map<PersonaKey, string>();
  for (const p of personas) ids.set(p, await accountId(p));

  const spaces = await ensureSpaces(groups, ids.get("carol")!);

  // Live demo beats, applied to the already-seeded pages and nothing else.
  const beat = flag("--edit-rollout") || flag("--restore-rollout") || flag("--restrict-drill") || flag("--unrestrict-drill");
  if (beat) {
    const eng = spaces.get("ENG")!;
    const pages = await spacePages(eng.id);
    const byTitle = new Map(pages.map((p) => [p.title, p]));
    if (flag("--edit-rollout") || flag("--restore-rollout")) {
      const spec = PAGES.find((p) => p.title === ROLLOUT_TITLE)!;
      const body = flag("--edit-rollout") ? spec.body.replace(ROLLOUT_OPEN_QUESTION, ROLLOUT_DECIDED) : spec.body;
      await writePage(eng, pages, { ...spec, renameFrom: [] }, body, byTitle);
    }
    if (flag("--restrict-drill") || flag("--unrestrict-drill")) {
      const page = byTitle.get(DRILL_TITLE);
      if (!page) throw new Error(`"${DRILL_TITLE}" doesn't exist yet; run the seed without flags first`);
      await setRestriction(page, flag("--restrict-drill") ? DRILL_RESTRICTION : null, ids, groups);
    }
    console.log("Done.");
    process.exit(0);
  }

  for (const spec of SPACES) {
    const space = spaces.get(spec.key);
    if (!space) continue; // dry run of a space that doesn't exist yet
    const pages = await spacePages(space.id);
    const byTitle = new Map(pages.map((p) => [p.title, p]));
    for (const p of pages) {
      if (!p.title.startsWith(TRASH_TITLE_PREFIX)) continue;
      log(`${spec.key}: trash "${p.title}"`);
      await send("DELETE", `/wiki/api/v2/pages/${p.id}`);
    }
    for (const ps of PAGES.filter((p) => p.space === spec.key)) {
      const page = await writePage(space, pages, ps, ps.body, byTitle);
      byTitle.set(ps.title, page);
      if (dry) continue;
      // Restrictions: set the spec's, or clear what a hand-made page had (the drill page starts open).
      const current = await get<{ restrictions?: { user?: { results?: { accountId?: string }[] }; group?: { results?: { id?: string }[] } } }>(`/wiki/rest/api/content/${page.id}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`);
      const have = [...(current.restrictions?.user?.results ?? []).map((u) => u.accountId), ...(current.restrictions?.group?.results ?? []).map((g) => g.id)].sort().join(",");
      const want = ps.restrict ? [...ps.restrict.users.map((u) => ids.get(u)), ...ps.restrict.groups.map((g) => groups.get(g)?.id)].sort().join(",") : "";
      if (have !== want) await setRestriction(page, ps.restrict ?? null, ids, groups);
    }
  }
  console.log(dry ? "Dry run done." : "Done. Now: npm run confluence:backfill");
} catch (e) {
  console.error(e instanceof ConfluenceError ? explain(e) : e);
  process.exit(1);
}
