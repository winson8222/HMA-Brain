// Confluence Cloud REST client for the crawler: the same service account and API token as Jira.
// The account needs View on every space to ingest, must be named in every page view restriction (admins don't
// bypass restrictions), and needs the "Confluence Administrator" global permission to ask Confluence whether
// another person can read a page (the live re-check).
import { confluenceConfig } from "./config.js";

export class ConfluenceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const isAuthError = (e: any) => e instanceof ConfluenceError && (e.status === 401 || e.status === 403);

export function explain(e: any): string {
  if (e instanceof ConfluenceError && e.status === 401) return "Confluence rejected the API token. Check CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN (or the JIRA_* values) in .env.";
  if (e instanceof ConfluenceError && e.status === 403) return `Confluence said the service account isn't allowed to do that (${e.message}).`;
  return String(e?.message ?? e);
}

export type Creds = { email: string; apiToken: string };
const basic = (c: Creds) => "Basic " + Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
type Method = "GET" | "POST" | "PUT" | "DELETE";

// path starts at the site root, e.g. /wiki/api/v2/spaces. creds: the crawler's by default; only the seed passes the admin's.
export async function call<T>(method: Method, path: string, body?: unknown, creds: Creds = confluenceConfig): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${confluenceConfig.baseUrl}${path}`, {
      method,
      headers: { Authorization: basic(creds), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const after = Number(res.headers.get("retry-after")) * 1000 || Math.min(32_000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, after + Math.random() * 250));
      continue;
    }
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.message || (j.errors ?? []).map((x: any) => x.title ?? x.detail).join("; ") || msg;
    } catch {}
    throw new ConfluenceError(res.status, `${method} ${path.split("?")[0]}: ${res.status} ${msg}`);
  }
}

const get = <T>(path: string) => call<T>("GET", path);
const post = <T>(path: string, body: unknown) => call<T>("POST", path, body);
const notFound = (e: unknown) => e instanceof ConfluenceError && e.status === 404;

// v2 pages with a cursor: follow _links.next until it's gone.
const nextPath = (n?: string) => (!n ? undefined : n.startsWith("http") ? n.replace(confluenceConfig.baseUrl, "") : n.startsWith("/wiki") ? n : `/wiki${n}`);
async function* pagedV2<T>(path: string): AsyncGenerator<T[]> {
  let next: string | undefined = path;
  while (next) {
    const r: { results?: T[]; _links?: { next?: string } } = await get(next);
    yield r.results ?? [];
    next = nextPath(r._links?.next);
  }
}
async function allV2<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pagedV2<T>(path)) out.push(...page);
  return out;
}

// ---- types ----

export type Space = { id: string; key: string; name: string; status?: string; type?: string };
export type Principal = { type?: string; id?: string };
export type RawPage = {
  id: string;
  status?: string;
  title?: string;
  spaceId?: string;
  parentId?: string | null;
  parentType?: string | null;
  authorId?: string | null;
  createdAt?: string;
  version?: { number?: number; createdAt?: string; authorId?: string | null };
  body?: { atlas_doc_format?: { value?: string } };
  _links?: { webui?: string };
};
export type RawRestriction = { users: string[]; groups: string[] };

// ---- calls ----

export const currentUser = () => get<{ accountId: string; displayName?: string; email?: string }>("/wiki/rest/api/user/current");

export async function listSpaces(keys: string[]): Promise<Space[]> {
  const spaces = await allV2<Space>(`/wiki/api/v2/spaces?status=current&limit=250${keys.length ? `&keys=${encodeURIComponent(keys.join(","))}` : ""}`);
  return keys.length ? spaces.filter((s) => keys.includes(s.key.toUpperCase())) : spaces;
}

// Who may view the space: principals of the space-level "read" permission.
export async function spaceReadPrincipals(spaceId: string): Promise<Principal[]> {
  const perms = await allV2<{ principal?: Principal; operation?: { key?: string; targetType?: string } }>(`/wiki/api/v2/spaces/${spaceId}/permissions?limit=250`);
  return perms.filter((p) => p.operation?.key === "read" && p.operation?.targetType === "space").flatMap((p) => (p.principal ? [p.principal] : []));
}

// Every current page of a space, with its body when asked (50 per request then; 250 without).
export function listPages(spaceId: string, withBody: boolean): AsyncGenerator<RawPage[]> {
  return pagedV2<RawPage>(`/wiki/api/v2/pages?space-id=${spaceId}&status=current&limit=${withBody ? 50 : 250}${withBody ? "&body-format=atlas_doc_format" : ""}`);
}

// One page with its body, or null when it's gone (deleted, trashed, archived, or no longer readable by the crawler).
export async function getPage(id: string): Promise<RawPage | null> {
  try {
    const p = await get<RawPage>(`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    return p.status && p.status !== "current" ? null : p;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

// The page's OWN view restriction (inherited ones aren't returned; sync.ts walks parents). null: page gone.
export async function readRestriction(pageId: string): Promise<RawRestriction | null> {
  try {
    const r = await get<{ restrictions?: { user?: { results?: { accountId?: string }[] }; group?: { results?: { id?: string }[] } } }>(
      `/wiki/rest/api/content/${pageId}/restriction/byOperation/read?expand=restrictions.user,restrictions.group&limit=200`,
    );
    return {
      users: (r.restrictions?.user?.results ?? []).flatMap((u) => (u.accountId ? [u.accountId] : [])).sort(),
      groups: (r.restrictions?.group?.results ?? []).flatMap((g) => (g.id ? [g.id] : [])).sort(),
    };
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

// Page IDs matching a CQL query (v1 search; v2 has none). Confluence's search index lags edits by minutes.
export async function searchPageIds(cql: string): Promise<string[]> {
  const out: string[] = [];
  for (let start = 0; ; ) {
    const r = await get<{ results?: { id?: string }[]; _links?: { next?: string } }>(`/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=100&start=${start}`);
    const ids = (r.results ?? []).flatMap((x) => (x.id ? [x.id] : []));
    out.push(...ids);
    if (!r._links?.next || !ids.length) return out;
    start += ids.length;
  }
}

// ---- people ----

export const userGroups = async (accountId: string) =>
  (await get<{ results?: { id: string; name?: string }[] }>(`/wiki/rest/api/user/memberof?accountId=${encodeURIComponent(accountId)}&limit=200`)).results ?? [];

const names = new Map<string, string | null>();
export async function userName(accountId: string): Promise<string | null> {
  if (names.has(accountId)) return names.get(accountId)!;
  let name: string | null = null;
  try {
    name = (await get<{ displayName?: string }>(`/wiki/rest/api/user?accountId=${encodeURIComponent(accountId)}`)).displayName ?? null;
  } catch (e) {
    if (!notFound(e)) throw e;
  }
  names.set(accountId, name);
  return name;
}

// The live re-check: Confluence's own answer to "can this account read this page right now?" It evaluates site
// access, space permissions and content restrictions (inherited ones included). Needs Confluence Administrator.
export async function canRead(accountId: string, pageId: string): Promise<boolean> {
  try {
    const r = await post<{ hasPermission?: boolean }>(`/wiki/rest/api/content/${pageId}/permission/check`, {
      subject: { type: "user", identifier: accountId },
      operation: "read",
    });
    return r.hasPermission === true;
  } catch (e) {
    if (notFound(e)) return false; // page gone
    throw e;
  }
}
