// Jira ingestion: backfill every in-scope project, then poll for issues updated since the last run.
//
// Two things never show up as "updated" in JQL, so they're handled separately:
//   - Permission changes (scheme grants, role members, security level members): every poll re-reads each
//     project's permission picture, and a project whose picture changed is relabelled in full.
//   - Deleted issues: the reconcile (backfill) diffs Jira's issue IDs against the index. Until then, the
//     live re-check at query time withholds a deleted issue, because Jira no longer lets anyone browse it.
import type { SyncVia } from "../../audit/chain.js";
import { access, type Snapshot } from "../../audit/events.js";
import { recordBackfill, recordItemChange, recordItemDeleted } from "../../audit/record.js";
import { explain, isAuthError, issueIds, listProjects, myself, searchIssues, type Project } from "./client.js";
import { jiraConfig } from "./config.js";
import { issueToDocs, jqlTime, pickerFields, type ProjectAcl } from "./docs.js";
import { projectAcl } from "./schemes.js";
import {
  allProjectStates,
  countDocs,
  deleteIssueDocs,
  deleteProjectState,
  ensureJiraIndices,
  getConnector,
  getProjectState,
  indexedIssues,
  issueSnapshots,
  putConnector,
  putProjectState,
  resetJiraIndices,
  writeIssueDocs,
  type IssueSnapshot,
} from "./store.js";
import type { JiraDoc } from "./docs.js";

export type Counts = { indexed: number; unchanged: number; deleted: number; projects: number; error: number };
const newCounts = (): Counts => ({ indexed: 0, unchanged: 0, deleted: 0, projects: 0, error: 0 });

export const summary = (c: Counts) =>
  Object.entries(c)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ") || "nothing to do";

// Shown in /api/status.
export const jiraStatus = {
  site: jiraConfig.site,
  polling: false,
  pollSeconds: jiraConfig.pollSeconds,
  projects: [] as string[],
  chunks: 0,
  lastBackfillAt: null as string | null,
  lastPollAt: null as string | null,
  lastRun: null as null | { kind: "backfill" | "poll"; at: string; counts: Counts },
  lastError: null as string | null,
  authError: false,
};

// For the audit log: what to call this run, and whether it's a first backfill (one summary record).
type Ctx = { via: SyncVia; initial: boolean };

const issueItemId = (issueId: string) => `jira:${jiraConfig.site}:${issueId}`;
const snapshot = (d: IssueSnapshot | JiraDoc): Snapshot => ({
  title: `${d.issue_key}: ${d.summary}`,
  path: d.project_name,
  access: access(d.acl_container, d.restricted ? d.acl_item : null),
  modified_at: d.updated_at,
});

async function deleteIssues(ids: string[], ctx: Ctx) {
  if (!ids.length) return;
  const before = await issueSnapshots(ids);
  await deleteIssueDocs(ids);
  for (const id of ids) {
    const s = before.get(id);
    // Jira doesn't say when an issue was deleted: only the detection time is known.
    await recordItemDeleted("jira", ctx.via, { id: issueItemId(id), source: "jira", title: s ? snapshot(s).title : id, ...(s ? { path: s.project_name } : {}) });
  }
}

async function dropProject(projectId: string, ctx: Ctx) {
  await deleteIssues([...(await indexedIssues(projectId)).keys()], ctx);
  await deleteProjectState(projectId);
}

// Re-read when an issue's content or labels may have changed. Skips issues whose docs are already current.
async function indexIssues(jql: string, acl: ProjectAcl, known: Map<string, string>, counts: Counts, ctx: Ctx, seen?: Set<string>) {
  for await (const page of searchIssues(jql, pickerFields(acl))) {
    for (const issue of page) {
      seen?.add(issue.id);
      try {
        const docs = issueToDocs(jiraConfig.site, jiraConfig.baseUrl, issue, acl);
        if (known.get(issue.id) === docs[0].content_hash) {
          counts.unchanged++;
          continue;
        }
        const prev = known.has(issue.id) ? ((await issueSnapshots([issue.id])).get(issue.id) ?? null) : null;
        await writeIssueDocs(issue.id, docs);
        counts.indexed++;
        await recordItemChange("jira", ctx.via, issueItemId(issue.id), prev && snapshot(prev), snapshot(docs[0]), { quietAdd: ctx.initial });
      } catch (e) {
        console.error(`  jira ${issue.key}: ${explain(e)}`);
        counts.error++;
      }
    }
  }
}

// Every issue in one project, then drop indexed issues Jira no longer has.
async function syncProject(p: Project, acl: ProjectAcl, counts: Counts, ctx: Ctx) {
  const known = await indexedIssues(p.id);
  const seen = new Set<string>();
  // A changed permission picture changes every issue's labels, hence its hash: all are rewritten.
  await indexIssues(`project = ${p.id} ORDER BY updated ASC`, acl, known, counts, ctx, seen);
  // Jira's search is eventually consistent: right after permission changes it can briefly return nothing.
  // An empty result for a project we hold issues for is far more likely that than every issue being deleted.
  if (!seen.size && known.size) {
    console.warn(`Jira ${p.key}: search returned no issues but ${known.size} are indexed; not removing them (re-run once Jira's search catches up)`);
    await putProjectState(acl);
    counts.projects++;
    return;
  }
  const gone = [...known.keys()].filter((id) => !seen.has(id));
  await deleteIssues(gone, ctx);
  counts.deleted += gone.length;
  await putProjectState(acl);
  counts.projects++;
}

// A project whose permissions can't be read can't be labelled. Its issues stay out of the index:
// better missing than shown to the wrong people.
async function aclOrDrop(p: Project, counts: Counts, ctx: Ctx): Promise<ProjectAcl | null> {
  try {
    return await projectAcl(p);
  } catch (e) {
    if (isAuthError(e) && (e as any).status === 401) throw e; // bad token: stop the whole run
    console.error(`Jira ${p.key}: couldn't read its permissions (${explain(e)}); removing it from the index until it can be`);
    await dropProject(p.id, ctx);
    counts.error++;
    return null;
  }
}

async function refreshStatus(kind: "backfill" | "poll", counts: Counts) {
  const conn = await getConnector();
  Object.assign(jiraStatus, {
    projects: (await allProjectStates()).map((p) => p.key).sort(),
    chunks: await countDocs(),
    lastBackfillAt: conn?.last_backfill_at ?? null,
    lastPollAt: conn?.last_poll_at ?? null,
    lastRun: { kind, at: new Date().toISOString(), counts },
    lastError: null,
    authError: false,
  });
}

function noteError(e: unknown) {
  jiraStatus.lastError = explain(e);
  jiraStatus.authError = isAuthError(e);
}

let busy = false; // one backfill or poll at a time in this process

async function exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
  if (busy) return null;
  busy = true;
  try {
    return await fn();
  } catch (e) {
    noteError(e);
    throw e;
  } finally {
    busy = false;
  }
}

// ---- backfill (also the reconcile) ----

async function backfillInner(opts: { reset?: boolean }): Promise<Counts> {
  if (opts.reset) await resetJiraIndices();
  else await ensureJiraIndices();
  const initial = !!opts.reset || !(await getConnector())?.cursor;
  const ctx: Ctx = { via: initial ? "backfill" : "reconcile", initial };
  const me = await myself();
  const started = new Date(); // anything updated during the backfill is picked up by the next poll
  const counts = newCounts();

  const projects = await listProjects(jiraConfig.projects);
  const missing = jiraConfig.projects.filter((k) => !projects.some((p) => p.key === k));
  if (missing.length) console.warn(`Jira: the service account can't see project(s) ${missing.join(", ")}`);
  for (const p of projects) {
    const acl = await aclOrDrop(p, counts, ctx);
    if (acl) await syncProject(p, acl, counts, ctx);
  }

  // Projects that left the scope (or were deleted, or the service account lost access).
  const inScope = new Set(projects.map((p) => p.id));
  for (const s of await allProjectStates()) {
    if (inScope.has(s.project_id)) continue;
    await dropProject(s.project_id, ctx);
  }

  await putConnector({ account_id: me.accountId, last_backfill_at: new Date().toISOString(), cursor: started.toISOString() });
  if (initial) await recordBackfill("jira", "backfill", counts.indexed, `Jira ${projects.map((p) => p.key).join(", ") || "(no projects)"}: ${summary(counts)}`);
  await refreshStatus("backfill", counts);
  return counts;
}

export async function backfill(opts: { reset?: boolean } = {}): Promise<Counts> {
  const r = await exclusive(() => backfillInner(opts));
  if (!r) throw new Error("A Jira sync is already running.");
  return r;
}

// ---- poll ----

const OVERLAP_MS = 2 * 60_000; // JQL dates have minute precision; re-reading a little is cheap (unchanged is skipped)

// Returns null if another sync is still running.
export function pollOnce(): Promise<Counts | null> {
  return exclusive(async () => {
    await ensureJiraIndices();
    const conn = await getConnector();
    if (!conn?.cursor) {
      console.log("Jira: no sync position yet, running a backfill first");
      return backfillInner({});
    }
    const me = await myself();
    const started = new Date();
    const counts = newCounts();
    const ctx: Ctx = { via: "poll", initial: false };

    // 1. Permissions first: a project whose picture changed is relabelled in full; a new project is backfilled.
    const current: { p: Project; acl: ProjectAcl }[] = [];
    for (const p of await listProjects(jiraConfig.projects)) {
      const acl = await aclOrDrop(p, counts, ctx);
      if (!acl) continue;
      const prev = await getProjectState(p.id);
      if (!prev || prev.hash !== acl.hash) {
        console.log(`Jira ${p.key}: ${prev ? "permissions changed, relabelling" : "new project, indexing"}`);
        await syncProject(p, acl, counts, ctx);
      } else current.push({ p, acl });
    }

    // 2. Issues updated since the last run, in the projects whose permissions didn't change.
    const since = jqlTime(new Date(Date.parse(conn.cursor) - OVERLAP_MS), me.timeZone);
    for (const { p, acl } of current) {
      const known = await indexedIssues(p.id);
      await indexIssues(`project = ${p.id} AND updated >= "${since}" ORDER BY updated ASC`, acl, known, counts, ctx);
    }

    // 3. Save the new position only after everything is applied. A crash before this just redoes the batch.
    await putConnector({ last_poll_at: new Date().toISOString(), cursor: started.toISOString() });
    await refreshStatus("poll", counts);
    return counts;
  });
}

// Deleted issues, without a full re-read: the IDs Jira still has vs the IDs we indexed.
export async function sweepDeleted(): Promise<number> {
  let n = 0;
  for (const s of await allProjectStates()) {
    const live = new Set(await issueIds(`project = ${s.project_id}`));
    if (!live.size) continue; // see syncProject: an empty search is more likely lag than a wiped project
    const gone = [...(await indexedIssues(s.project_id)).keys()].filter((id) => !live.has(id));
    await deleteIssues(gone, { via: "reconcile", initial: false });
    n += gone.length;
  }
  return n;
}

const changed = (c: Counts | null) => !!c && !!(c.indexed || c.deleted || c.error);

export function startPolling() {
  jiraStatus.polling = true;
  const tick = () =>
    pollOnce()
      .then((c) => changed(c) && console.log(`Jira: ${summary(c!)}`))
      .catch((e) => console.error(`Jira poll failed: ${explain(e)}`));
  void tick();
  setInterval(tick, jiraConfig.pollSeconds * 1000);

  if (jiraConfig.reconcileMinutes > 0) {
    setInterval(() => {
      if (busy) return;
      exclusive(sweepDeleted)
        .then((n) => n && console.log(`Jira reconcile: ${n} deleted issue(s) removed`))
        .catch((e) => console.error(`Jira reconcile failed: ${explain(e)}`));
    }, jiraConfig.reconcileMinutes * 60_000);
  }
}

export async function loadStatus() {
  await ensureJiraIndices();
  const conn = await getConnector();
  Object.assign(jiraStatus, {
    projects: (await allProjectStates()).map((p) => p.key).sort(),
    chunks: await countDocs(),
    lastBackfillAt: conn?.last_backfill_at ?? null,
    lastPollAt: conn?.last_poll_at ?? null,
  });
  return jiraStatus;
}
