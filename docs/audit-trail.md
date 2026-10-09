# Audit trail

What HMA Brain records, how each platform's changes reach the log, where the time we *detect* a change differs from the time it *happened*, and why that gap doesn't let anyone see something they shouldn't.

Code: `src/audit/` (record kinds in `chain.ts`, change records in `events.ts` / `record.ts`, query and verify in `store.ts`). UI: **Audit log** on the main page (admin password). CLI: `npm run audit:log`, `npm run audit:verify`.

## 1. What is logged

Everything goes into one log, `brain-audit`, as a hash chain: each record carries the previous record's hash, and its own hash is an HMAC over its contents plus that link. The key lives in `.secrets/audit-key` (or `AUDIT_KEY`), never in Elasticsearch. Editing, deleting or reordering any record makes **Verify chain** / `audit:verify` fail from that record on.

| Kind | Actor | When | What the record holds |
|---|---|---|---|
| **Search / Ask** | the person | every search and every answer, before anything is returned | question, search keywords, answer, signed-in or demo mode, sources searched, and every document considered with its decision: **shown** (★ = cited in the answer), **withheld** (matched, but not shared with this person), or **dropped by live re-check** (with the reason) |
| **Permission change** | `system` | a sync, an event or a live re-check finds an item's access changed | the item (ID, title, path), access before and after, a summary ("lost: dave@…"), how it was detected, and **when it changed** / **when it was detected** (section 3) |
| **Content change** | `system` | an item is added, updated or deleted in the index | the item, `added` / `updated` / `deleted`, when it changed, when it was detected, when the index caught up. A first backfill writes one summary record with a count instead |
| **Account link** | the person | Slack Connect / Disconnect, Atlassian link / unlink, Google Drive connected | which source and which account |
| **Admin action** | `admin` | audit log viewed or filtered, chain verified (web or CLI), Drive **Sync now** | the filters used, or the result |

**Never stored:** message, page, issue or file text. Records hold IDs, titles, paths and permission labels only. Withheld DMs show no text, and DMs appear as "a DM" in change records.

**Queries it answers:** "What did Dave access last week?" (person + dates), "Who retrieved the postmortem?" (document + *shown*), "When did Dave lose access to it, and did he see it after?" (document: permission changes and searches in one list), "How fresh is the index?" (content changes: changed vs indexed), "Who looked at the audit log?" (admin actions).

## 2. How each platform is kept up to date

Two ways a change reaches us:

- **Pushed:** the platform tells us within seconds (Slack events over Socket Mode). Recorded straight away.
- **Pulled:** we ask the platform on a timer. A **poll** reads what changed since the last run. A **reconcile** re-reads everything to catch what a poll can't see (deletions, some permission changes).

Defaults below; each can be changed in `.env`.

### Slack: pushed

| Change | How we learn | Delay | Recorded as |
|---|---|---|---|
| Message posted, edited, deleted | Slack event | seconds | content change |
| Person joins or leaves a channel | Slack event | seconds | permission change on the channel ("Dave left (lost access)") |
| Bot added to a channel | Slack event, then that channel's history is indexed | seconds | content change (summary with a count) |
| Channel made private or public | channel reconcile (no dependable Slack event) | up to 5 min | permission change with old and new labels |
| Channel renamed | event applies it at once; reconcile records it | up to 5 min | content change (title) |
| Person connects their Slack (DMs) | their Connect, then their DMs are indexed | immediate | account link + content change (summary) |

### Google Drive: pulled

| Change | How we learn | Delay | Recorded as |
|---|---|---|---|
| Sharing changed (file or folder) | poll of Drive's change feed | up to 60 s (`DRIVE_POLL_SECONDS`) | permission change |
| Sharing changed, file comes up in a search | live re-check during that search | at search time | permission change (`live-recheck`), and the index is fixed immediately |
| File added, moved in or out, renamed | poll | up to 60 s | content change |
| File edited | poll, then debounced until no edits for 120 s (`DRIVE_QUIET_SECONDS`) | 2–3 min; **Sync now** skips the wait | content change. "Edited" is decided by the content hash, because Drive also bumps a file's modified time when only its sharing changes |
| File trashed or deleted | poll | up to 60 s | content change (`deleted`) |
| Anything a poll missed | reconcile | up to 60 min (`DRIVE_RECONCILE_MINUTES`) | as above |

### Jira: pulled

| Change | How we learn | Delay | Recorded as |
|---|---|---|---|
| Project permissions (Browse grants, roles, issue security levels) | each poll re-reads every project's permission picture; a changed project is re-read in full | up to 60 s (`JIRA_POLL_SECONDS`) | permission change per issue whose access changed |
| Issue created or edited | poll: issues updated since the last run | up to 60 s | content change |
| Issue deleted | reconcile: Jira's issue IDs compared with the index | up to 60 min (`JIRA_RECONCILE_MINUTES`) | content change (`deleted`) |

### Confluence: pulled

| Change | How we learn | Delay | Recorded as |
|---|---|---|---|
| Space permissions | each poll re-reads every space's View grants; a changed space is re-synced | up to 60 s (`CONFLUENCE_POLL_SECONDS`) | permission change per page |
| Page view restriction, page also edited | poll | up to 60 s | permission change (restriction changes pass down to child pages) |
| Page view restriction only (no edit) | reconcile sweep | up to 10 min (`CONFLUENCE_RECONCILE_MINUTES`) | permission change |
| Page created or edited | poll: pages modified since the last run | up to 60 s | content change |
| Page deleted | reconcile sweep | up to 10 min | content change (`deleted`) |

### Accounts and admin actions

Recorded in the same request as the action, so always immediate. One Atlassian link serves both Jira and Confluence. Drive is one admin connection for the whole company, not a per-person link.

## 3. Time detected vs time changed

Every permission and content change record carries two times:

- **`changed_at`**: when it happened in the platform, *if the platform tells us*. Empty when it doesn't.
- **`detected_at`**: when HMA Brain saw it.

The UI shows both, plus the gap ("Detected 6:22:28 PM, 4s after the change"). Content changes also show **indexed**: when the index caught up. The record's own time (`at`) is when it was written, a moment after detection.

| Change | `changed_at` comes from | Exact? |
|---|---|---|
| Slack message added / edited / deleted | the message's time, its edit time, or the delete event's time | ✅ exact |
| Slack channel join / leave | the event's time | ✅ exact |
| Slack channel privacy change or rename | not available | ❌ detection time only (≤ 5 min after) |
| Drive sharing change, found by poll | Drive's change feed (time of the change) | ✅ exact |
| Drive sharing change, found by live re-check or reconcile | not available | ❌ detection time only |
| Drive edit / new file | the file's modified time | ✅ exact |
| Drive deletion, found by poll | Drive's change feed | ✅ exact |
| Drive deletion, found by reconcile | not available | ❌ detection time only |
| Jira issue created / edited | the issue's `updated` time | ✅ exact |
| **Jira permission change** | not available: Jira keeps it only in its admin audit log | ❌ detection time only (≤ 60 s after) |
| **Jira issue deleted** | not available | ❌ detection time only (≤ 60 min after) |
| Confluence page created / edited | the page version's time | ✅ exact |
| **Confluence space permission / page restriction change** | not available: only in Confluence's admin audit log | ❌ detection time only (≤ 60 s, or ≤ 10 min for a restriction alone) |
| **Confluence page deleted** | not available | ❌ detection time only (≤ 10 min after) |
| Account links, admin actions | they *are* the action | ✅ exact |

When `changed_at` is empty, the real change happened **at most one poll or reconcile interval before `detected_at`**. The interval is fixed, so that window is known (the "≤" figures above).

## 4. How the detection gap is covered

A gap between "access removed in the platform" and "we noticed" would matter if someone could see the item during that gap. They can't, because detection is not what enforces access:

1. **Live re-check on every search.** Before a Drive, Jira, Confluence or Slack result is shown, it is checked with the platform *at that moment*, as the person asking. If the index is behind (Dave was removed 20 seconds ago and the poll hasn't run), the re-check catches it and the result is withheld. Anything that can't be confirmed is withheld too (fail closed). Access follows the platform within the same request, not within one poll interval.
2. **The denial is logged at search time.** That search's record lists the item as **dropped by live re-check**, with the reason ("access removed in Drive"). The search record's own time is exact. So for any search in the gap, the log shows the person did **not** get the item, even before the permission-change record exists.
3. **Drive closes the gap on the spot.** When the live re-check finds Drive's sharing differs from the index, it fixes the index and writes the permission change (`detected by: live-recheck`) right then. Jira and Confluence withhold the item but leave the permission change to their next poll.
4. **The worst case is bounded.** Where `changed_at` is empty, the change happened within one known interval before `detected_at` (60 s for polls; 5, 10 or 60 min for reconciles). Together with point 2, "did Dave see the postmortem after he lost access?" has a definite answer: filter by the document. The permission change, and every search on either side of it with its shown / withheld / dropped decision, appear in one list.
5. **Search records can't be skipped.** No result or answer is returned unless its search record was written first. If the audit log can't be written, the search fails.

In short, detection time decides when the *permission-change record* appears, not when access stops. Access stops at the platform's own speed, through the live re-check, and the search records prove it.

## 5. Gaps and limits

| Gap | Effect | Possible fix |
|---|---|---|
| Jira and Confluence permission changes and deletions have no `changed_at` | record shows when we detected it, within a known window | read Jira's and Confluence's admin audit logs (needs admin API access) |
| Who made a change in the platform isn't recorded | "Dave lost access at 10:22", not "Carol removed Dave" | same: the platforms' own audit logs |
| Jira and Confluence live re-checks withhold but don't record a permission change | that record waits for the next poll (≤ 60 s) or sweep (≤ 10 min) | relabel and record on re-check, as Drive does |
| Slack disconnect: removed DMs aren't listed | only the disconnect is recorded | add "removed N DM conversations" to the disconnect record |
| Slack channel rename is recorded at the next reconcile | title change appears up to 5 min late | record it from the rename event |
| First backfills are one summary record | no per-item "added" record for the initial load | deliberate: one record per real change after that |
| A sync whose audit write fails keeps going (logged as `AUDIT WRITE FAILED`) | that change can be missing from the log | deliberate: the sync is what keeps permissions correct. Searches are the opposite and fail without their record |
| Admin is one shared password | admin records say `admin`, not a person | per-admin logins |
| **Sync now** on the Drive page has no admin check | its record names whoever is signed in, or `anonymous` | put it behind the admin password |
| Records cut from the *end* of the chain | can't be seen from the chain alone | compare the head `audit:verify` prints with one noted earlier; in production, publish the head somewhere append-only |
| Records written before these kinds existed | no `changed_at` / `detected_at`; their record time is the detection time | none needed: they still verify |
