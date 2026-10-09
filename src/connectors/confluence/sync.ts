// Confluence ingestion: backfill every in-scope space, then poll for pages modified since the last run.
//
// Three things don't show up as "modified" in CQL, so they're handled separately:
//   - Space permission changes: every poll re-reads each space's View grants; a space whose picture changed
//     is re-synced in full (every page's labels change).
//   - Page view restrictions: read for every page that comes back from the poll, and for every page in the
//     reconcile sweep (a restriction change alone may not bump lastmodified). A changed restriction fans out to
//     the page's descendants through the stored tree.
//   - Deleted pages: the sweep diffs Confluence's page IDs against the state. Until then the live re-check
//     withholds a deleted page, because Confluence no longer lets anyone read it.
import { effectiveLabels, restrictionLabels } from "./acl.js";
import { currentUser, explain, getPage, isAuthError, listPages, listSpaces, readRestriction, searchPageIds, userName, type RawPage, type Space } from "./client.js";
import { confluenceConfig } from "./config.js";
import { pageToDocs, type SpaceAcl } from "./docs.js";
import { spaceAcl } from "./spaces.js";
import {
  allSpaceStates,
  countDocs,
  deletePageDocs,
  deletePageStates,
  deleteSpaceDocs,
  deleteSpaceState,
  ensureConfluenceIndices,
  getConnector,
  getSpaceState,
  pageStates,
  putConnector,
  putPageState,
  putSpaceState,
  resetConfluenceIndices,
  writePageDocs,
  type PageState,
} from "./store.js";

export type Counts = { indexed: number; unchanged: number; deleted: number; spaces: number; error: number };
const newCounts = (): Counts => ({ indexed: 0, unchanged: 0, deleted: 0, spaces: 0, error: 0 });

export const summary = (c: Counts) =>
  Object.entries(c)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ") || "nothing to do";

// Shown in /api/status.
export const confluenceStatus = {
  site: confluenceConfig.site,
  polling: false,
  pollSeconds: confluenceConfig.pollSeconds,
  spaces: [] as string[],
  chunks: 0,
  lastBackfillAt: null as string | null,
  lastPollAt: null as string | null,
  lastRun: null as null | { kind: "backfill" | "poll"; at: string; counts: Counts },
  lastError: null as string | null,
  authError: false,
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const parentOf = (p: RawPage) => (p.parentType === "page" && p.parentId ? p.parentId : null);

async function removePages(ids: string[], states: Map<string, PageState>) {
  if (!ids.length) return;
  await deletePageDocs(ids);
  await deletePageStates(ids);
  for (const id of ids) states.delete(id);
}

// Index these pages (with bodies) of one space: read each one's own view restriction, resolve the effective
// one through its parents (this batch first, then the stored state), write what changed, and re-index the
// stored descendants of any page whose effective restriction changed.
async function indexPages(acl: SpaceAcl, pages: RawPage[], states: Map<string, PageState>, counts: Counts): Promise<void> {
  const { site, baseUrl } = confluenceConfig;
  const batch = new Map(pages.map((p) => [p.id, p]));
  const own = new Map<string, string[] | null>();
  const gone: string[] = [];
  for (const p of pages) {
    const r = await readRestriction(p.id);
    if (r === null) {
      gone.push(p.id);
      batch.delete(p.id);
    } else own.set(p.id, restrictionLabels(site, r));
  }
  await removePages(gone, states);
  counts.deleted += gone.length;

  const eff = new Map<string, string[] | null>();
  const effective = (id: string, depth = 0): string[] | null => {
    if (eff.has(id)) return eff.get(id)!;
    const p = batch.get(id);
    let v: string[] | null;
    if (p) {
      const parent = parentOf(p);
      v = effectiveLabels(own.get(id)!, parent && depth < 100 ? effective(parent, depth + 1) : null);
    } else v = states.get(id)?.effective ?? null;
    eff.set(id, v);
    return v;
  };

  const fanOut: string[] = [];
  for (const p of batch.values()) {
    try {
      const e = effective(p.id);
      const prev = states.get(p.id);
      const authorId = p.version?.authorId ?? p.authorId ?? null;
      const docs = pageToDocs(site, baseUrl, p, acl, e, authorId ? await userName(authorId) : null);
      const next: Omit<PageState, "kind" | "synced_at"> = { page_id: p.id, space_id: acl.space_id, parent_id: parentOf(p), title: p.title ?? "", own: own.get(p.id)!, effective: e, content_hash: docs[0].content_hash };
      if (prev?.content_hash === next.content_hash) counts.unchanged++;
      else {
        await writePageDocs(p.id, docs);
        counts.indexed++;
      }
      if (!same(prev?.effective ?? null, e)) fanOut.push(p.id);
      if (!prev || !same({ ...prev, kind: undefined, synced_at: undefined }, { ...next, kind: undefined, synced_at: undefined })) {
        await putPageState(next);
        states.set(p.id, { kind: "page", synced_at: "", ...next });
      }
    } catch (err) {
      console.error(`  confluence ${p.id} "${p.title ?? ""}": ${explain(err)}`);
      counts.error++;
    }
  }

  // Descendants we already hold, below a page whose effective restriction changed, and not in this batch.
  const kids = new Map<string, string[]>();
  for (const s of states.values()) if (s.parent_id) (kids.get(s.parent_id) ?? kids.set(s.parent_id, []).get(s.parent_id)!).push(s.page_id);
  const todo = new Set<string>();
  for (const stack = [...fanOut]; stack.length; ) for (const c of kids.get(stack.pop()!) ?? []) if (!batch.has(c) && !todo.has(c)) (todo.add(c), stack.push(c));
  if (!todo.size) return;
  const fetched: RawPage[] = [];
  const missing: string[] = [];
  for (const id of todo) {
    const p = await getPage(id);
    if (p) fetched.push(p);
    else missing.push(id);
  }
  await removePages(missing, states);
  counts.deleted += missing.length;
  await indexPages(acl, fetched, states, counts);
}

// Every page in one space, then drop stored pages Confluence no longer has.
async function syncSpace(s: Space, acl: SpaceAcl, counts: Counts) {
  const states = await pageStates(s.id);
  const all: RawPage[] = [];
  for await (const page of listPages(s.id, true)) all.push(...page);
  await indexPages(acl, all, states, counts);
  const seen = new Set(all.map((p) => p.id));
  const gone = [...states.keys()].filter((id) => !seen.has(id));
  await removePages(gone, states);
  counts.deleted += gone.length;
  await putSpaceState(acl);
  counts.spaces++;
}

async function dropSpace(spaceId: string) {
  await deleteSpaceDocs(spaceId);
  await deletePageStates([...(await pageStates(spaceId)).keys()]);
  await deleteSpaceState(spaceId);
}

// A space whose permissions can't be read can't be labelled. Its pages stay out of the index.
async function aclOrDrop(s: Space, counts: Counts): Promise<SpaceAcl | null> {
  try {
    return await spaceAcl(s);
  } catch (e) {
    if (isAuthError(e) && (e as any).status === 401) throw e; // bad token: stop the whole run
    console.error(`Confluence ${s.key}: couldn't read its permissions (${explain(e)}); removing it from the index until it can be`);
    await dropSpace(s.id);
    counts.error++;
    return null;
  }
}

async function refreshStatus(kind: "backfill" | "poll", counts: Counts) {
  const conn = await getConnector();
  Object.assign(confluenceStatus, {
    spaces: (await allSpaceStates()).map((s) => s.key).sort(),
    chunks: await countDocs(),
    lastBackfillAt: conn?.last_backfill_at ?? null,
    lastPollAt: conn?.last_poll_at ?? null,
    lastRun: { kind, at: new Date().toISOString(), counts },
    lastError: null,
    authError: false,
  });
}

let busy = false; // one backfill, poll or sweep at a time in this process

async function exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
  if (busy) return null;
  busy = true;
  try {
    return await fn();
  } catch (e) {
    confluenceStatus.lastError = explain(e);
    confluenceStatus.authError = isAuthError(e);
    throw e;
  } finally {
    busy = false;
  }
}

// ---- backfill ----

async function backfillInner(opts: { reset?: boolean }): Promise<Counts> {
  if (opts.reset) await resetConfluenceIndices();
  else await ensureConfluenceIndices();
  const me = await currentUser();
  const started = new Date(); // anything modified during the backfill is picked up by the next poll
  const counts = newCounts();

  const spaces = await listSpaces(confluenceConfig.spaces);
  const missing = confluenceConfig.spaces.filter((k) => !spaces.some((s) => s.key.toUpperCase() === k));
  if (missing.length) console.warn(`Confluence: the service account can't see space(s) ${missing.join(", ")}`);
  for (const s of spaces) {
    const acl = await aclOrDrop(s, counts);
    if (acl) await syncSpace(s, acl, counts);
  }

  // Spaces that left the scope (or were deleted, or the service account lost access).
  const inScope = new Set(spaces.map((s) => s.id));
  for (const st of await allSpaceStates()) if (!inScope.has(st.space_id)) await dropSpace(st.space_id);

  await putConnector({ account_id: me.accountId, last_backfill_at: new Date().toISOString(), cursor: started.toISOString() });
  await refreshStatus("backfill", counts);
  return counts;
}

export async function backfill(opts: { reset?: boolean } = {}): Promise<Counts> {
  const r = await exclusive(() => backfillInner(opts));
  if (!r) throw new Error("A Confluence sync is already running.");
  return r;
}

// ---- poll ----

const OVERLAP_MIN = 2; // CQL dates have minute precision; re-reading a little is cheap (unchanged is skipped)

// Returns null if another sync is still running.
export function pollOnce(): Promise<Counts | null> {
  return exclusive(async () => {
    await ensureConfluenceIndices();
    const conn = await getConnector();
    if (!conn?.cursor) {
      console.log("Confluence: no sync position yet, running a backfill first");
      return backfillInner({});
    }
    const started = new Date();
    const counts = newCounts();

    // 1. Permissions first: a space whose picture changed is re-synced in full; a new space is backfilled.
    const current: { s: Space; acl: SpaceAcl }[] = [];
    for (const s of await listSpaces(confluenceConfig.spaces)) {
      const acl = await aclOrDrop(s, counts);
      if (!acl) continue;
      const prev = await getSpaceState(s.id);
      if (!prev || prev.hash !== acl.hash) {
        console.log(`Confluence ${s.key}: ${prev ? "permissions changed, relabelling" : "new space, indexing"}`);
        await syncSpace(s, acl, counts);
      } else current.push({ s, acl });
    }

    // 2. Pages modified since the last run. A relative CQL date avoids the crawler's time zone altogether.
    const minutes = Math.ceil((started.getTime() - Date.parse(conn.cursor)) / 60_000) + OVERLAP_MIN;
    for (const { s, acl } of current) {
      const ids = await searchPageIds(`type=page and space="${s.key}" and lastmodified >= now("-${minutes}m")`);
      if (!ids.length) continue;
      const states = await pageStates(s.id);
      const pages: RawPage[] = [];
      const gone: string[] = [];
      for (const id of ids) {
        const p = await getPage(id);
        if (p) pages.push(p);
        else if (states.has(id)) gone.push(id);
      }
      await removePages(gone, states);
      counts.deleted += gone.length;
      await indexPages(acl, pages, states, counts);
    }

    // 3. Save the new position only after everything is applied. A crash before this just redoes the batch.
    await putConnector({ last_poll_at: new Date().toISOString(), cursor: started.toISOString() });
    await refreshStatus("poll", counts);
    return counts;
  });
}

// Reconcile: deleted or moved pages, and view restrictions that changed without a content edit.
export async function sweep(): Promise<Counts> {
  const counts = newCounts();
  for (const st of await allSpaceStates()) {
    const states = await pageStates(st.space_id);
    const live: RawPage[] = [];
    for await (const page of listPages(st.space_id, false)) live.push(...page);
    const liveIds = new Set(live.map((p) => p.id));
    const gone = [...states.keys()].filter((id) => !liveIds.has(id));
    await removePages(gone, states);
    counts.deleted += gone.length;

    const changed: string[] = [];
    for (const p of live) {
      const prev = states.get(p.id);
      const r = await readRestriction(p.id);
      if (r === null) continue; // vanished between the two calls; next sweep removes it
      if (!prev || !same(prev.own, restrictionLabels(confluenceConfig.site, r)) || prev.parent_id !== parentOf(p)) changed.push(p.id);
    }
    const pages: RawPage[] = [];
    for (const id of changed) {
      const p = await getPage(id);
      if (p) pages.push(p);
    }
    if (pages.length) await indexPages(st, pages, states, counts);
  }
  return counts;
}

const changed = (c: Counts | null) => !!c && !!(c.indexed || c.deleted || c.error);

export function startPolling() {
  confluenceStatus.polling = true;
  const tick = () =>
    pollOnce()
      .then((c) => changed(c) && console.log(`Confluence: ${summary(c!)}`))
      .catch((e) => console.error(`Confluence poll failed: ${explain(e)}`));
  void tick();
  setInterval(tick, confluenceConfig.pollSeconds * 1000);

  if (confluenceConfig.reconcileMinutes > 0) {
    setInterval(() => {
      if (busy) return;
      exclusive(sweep)
        .then((c) => changed(c) && console.log(`Confluence reconcile: ${summary(c!)}`))
        .catch((e) => console.error(`Confluence reconcile failed: ${explain(e)}`));
    }, confluenceConfig.reconcileMinutes * 60_000);
  }
}

export async function loadStatus() {
  await ensureConfluenceIndices();
  const conn = await getConnector();
  Object.assign(confluenceStatus, {
    spaces: (await allSpaceStates()).map((s) => s.key).sort(),
    chunks: await countDocs(),
    lastBackfillAt: conn?.last_backfill_at ?? null,
    lastPollAt: conn?.last_poll_at ?? null,
  });
  return confluenceStatus;
}
