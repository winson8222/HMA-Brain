# Developer guide

[← Back to README](../README.md)

## Architecture

```
                 ┌──────────────── CONNECTOR (per source) ─────────────────┐
Slack ──events──▶│ events.ts   live changes (Socket Mode)                   │
      ──history─▶│ sync.ts     backfill + 5-min reconcile                   │
                 │ slackDocs.ts  source item → BrainDoc + permission label  │──write──▶ Elasticsearch
                 │ principals.ts user → principals (live from Slack)        │           index "brain"
                 └──────────────────────────────────────────────────────────┘                ▲
                                                                                              │ filtered query
Browser (public/index.html) ──▶ server.ts ──▶ search.ts  retrieve(): filter → live re-check ──┘
                                     │           └─▶ audit log (shown / withheld)
                                     └──▶ ask.ts ──▶ llm.ts (OpenAI-compatible)
                                            keywords → retrieve() → answer with [n] citations
```

**Core principle: permissions are enforced before the LLM, never by it.**

1. Every indexed document carries a **permission label** (`acl_container`): the principals allowed to see it.
2. At query time the asker's **principals** are looked up from the source system.
3. Elasticsearch filters by them **inside the query** (`bool.filter`). Restricted documents are never scored, returned, or put in a prompt.
4. Each hit is **re-checked live** against the source, which catches permission changes that haven't reached the index yet.
5. Users get only content fields. There are no hit counts, and "nothing found" and "all restricted" look the same, so restricted content's existence isn't revealed.
6. The LLM is told to answer only from the given messages and cite them. Even if it ignored that, it only ever received permitted content.

## Files

| File | Layer | Role |
|---|---|---|
| `src/acl.ts` | shared | Principal strings, `aclFilter()`, `canSee()` |
| `src/es.ts` | shared | Elasticsearch client and index mapping |
| `src/indexer.ts` | shared | Upsert, bulk upsert, delete (with thread replies), relabel |
| `src/search.ts` | shared | `retrieve()`: filtered search, live re-check, audit entry |
| `src/ask.ts` | shared | Question → keywords → `retrieve()` → cited answer |
| `src/llm.ts` | shared | OpenAI-compatible chat client |
| `src/server.ts` | shared | Express API, static UI, starts Slack Socket Mode |
| `public/index.html` | shared | UI: Ask/Search, two-person compare, audit log |
| `src/slack.ts` | Slack | Web API client, channel and user caches, history pagination |
| `src/slackDocs.ts` | Slack | Pure mapping of Slack messages/events → `BrainDoc` |
| `src/events.ts` | Slack | Live event handlers |
| `src/sync.ts` | Slack | Backfill, channel reconcile |
| `src/principals.ts` | Slack | Slack user → principals |
| `src/seedSlack.ts` | Slack | Demo data (writes to Slack only) |
| `src/verify.ts` | Slack | Slack vs index consistency check |
| `src/connectors/drive/acl.ts`, `extract.ts`, `chunk.ts`, `docs.ts` | Drive | Pure: sharing → labels, text extraction rules, chunking, file → docs, change decisions |
| `src/connectors/drive/client.ts`, `auth.ts` | Drive | Drive API client (admin's token, retries), OAuth helpers |
| `src/connectors/drive/store.ts`, `tree.ts` | Drive | `brain-drive` / `brain-drive-state` indexes, folder map and paths |
| `src/connectors/drive/sync.ts` | Drive | Backfill, poll the changes feed, per-file update |
| `src/connectors/drive/query.ts`, `prompt.ts` | Drive | Search/Ask: filtered query, live re-check with Drive, prompt and citations |
| `src/connectors/drive/routes.ts`, `people.ts` | Drive | `/api/drive/*` and Connect Google Drive; the demo people |
| `src/connectors/drive/pdf.ts` | Drive | PDF text extraction |
| `src/connectors/drive/cli/*` | Drive | `drive:connect`, `seed:drive`, `drive:backfill`, `drive:poll`, `drive:verify`, `drive:ask`, `drive:doctor` |
| `public/drive.html` | Drive | Drive Search/Ask page with the admin panel (audit log, verify, connect) |
| `src/audit/chain.ts`, `store.ts` | shared | Tamper-evident audit log: HMAC hash chain in `brain-audit`, query and verify |
| `src/audit/routes.ts`, `cli.ts`, `src/admin.ts` | shared | Admin-only audit API (`ADMIN_TOKEN`), `audit:log`, `audit:verify` |

## Document shape

Every source produces the same document type (currently `BrainDoc` in `src/slackDocs.ts`):

| Field | Example | Notes |
|---|---|---|
| `doc_id` | `slack:C09ABC:1790000000.000100` | `<source>:<container>:<item>`, stable and unique |
| `source` | `slack` | |
| `channel_id` / `channel_name` | `C09ABC` / `payments-incident` | Container (channel, project, space, label) |
| `is_private` | `true` | For display |
| `user_id` / `user_name` | `U09ALICE` / `Alice` | Author |
| `text` | … | Searchable content |
| `ts` | ISO date | Used for "as of" and ranking |
| `permalink` | `https://…/archives/…` | Citation link back to the source |
| `acl_container` | `["slack:channel:C09ABC"]` | **Permission label. Required.** |

## Permission model

A principal is a string for one way of getting access. A user may see a document if **any** principal in the document's label is in the user's principal list.

| Slack | Label on a message | User's principals |
|---|---|---|
| Public channel | `slack:ws:<team>:member`, `slack:channel:<id>` | `slack:ws:<team>:member` (full members only) |
| Private channel | `slack:channel:<id>` | `slack:channel:<id>` for each channel they're in |
| Guest | | Only their own channels' principals |

Namespace every principal by source (`slack:`, `gmail:`, `jira:`…), so labels from different sources can never collide.

## Adding a connector (e.g. Gmail, Jira)

A connector turns one source into labelled documents and keeps them in sync. **It must provide all of the following.** A connector that can't do one of them can't be permission-safe.

| # | Requirement | Slack implementation | What to build for a new source |
|---|---|---|---|
| 1 | **Backfill**: fetch all existing items, paginated and rate-limit aware | `sync.ts`, `slack.ts channelMessages()` | e.g. Gmail `messages.list` + `messages.get`; Jira JQL search |
| 2 | **Live changes**: created, updated **and deleted** | Socket Mode events, `events.ts` | Webhooks or push (Gmail `watch` + `history.list`; Jira webhooks), else polling on `updated since` |
| 3 | **Missed-change recovery**: events can be lost | `npm run backfill`, reconcile job | Periodic reconcile or ID diff against the source |
| 4 | **Mapping to `BrainDoc`**, as a pure, unit-tested function | `slackDocs.ts messageToDoc()` | `gmailDocs.ts`, `jiraDocs.ts` |
| 5 | **Permission label** for every item | `aclForChannel()` | Map the source's rules to principals (table below) |
| 6 | **User → principals**, looked up fresh at query time | `principals.ts getAccess()` | Same idea for the source's accounts, groups and roles |
| 7 | **Identity link**: login email → the source's user ID | `users.lookupByEmail` | Atlassian account search by email; Gmail is already the email |
| 8 | **Live check** for the re-check step | `getChannel(fresh)` + fresh `getAccess()` | "Can user X see item Y now?" against the source |
| 9 | **Permission-change handling** | member events, relabel on privacy change | Update labels (`update_by_query`) or refresh user principals |
| 10 | **Verify script** | `verify.ts` | Items in source vs index, labels correct |
| 11 | **Fixtures + tests** from real payloads | `fixtures/`, `CAPTURE_EVENTS=1` | Same |

**Suggested permission mappings:**

| Source | Label on an item | User's principals |
|---|---|---|
| Gmail | `gmail:mailbox:<owner email>` (a message is visible to its mailbox owner) | `gmail:mailbox:<own email>` |
| Jira | `jira:<project>:role:<role>`, plus the issue security level when set | Project roles, groups, allowed security levels |
| Confluence | `conf:space:<key>:viewers`, plus page restrictions (including inherited ones) | Space permissions, groups, `user:<id>` |
| Google Drive | Effective permissions: `user:<email>`, `group:<email>`, `domain:<domain>` | Own email, Google groups, domain |

If a source needs "container **and** item" rules (e.g. a Confluence space plus a page restriction), add `item_restricted` / `acl_item` fields and require both. The filter shape is in `src/acl.ts`.

**Google Drive against the checklist** (see [drive-setup.md](drive-setup.md)):

| # | Status | How |
|---|---|---|
| 1 Backfill | Done | Walk the root folder, `files.list` paginated with retries/backoff |
| 2 Live changes | Done | Poll `changes.list` every `DRIVE_POLL_SECONDS`; each entry is re-read with `files.get` |
| 3 Missed-change recovery | Done | Saved page token (replays after downtime); `drive:backfill` reconciles; `drive:verify` |
| 4 Mapping | Done | `docs.ts fileToDocs()`: Docs → Markdown, Sheets → CSV, Slides → text, text files downloaded, others title-only; chunks of ~800 tokens |
| 5 Permission label | Done | `acl.ts permsToAcl()`: `drive:user:`, `drive:group:`, `drive:domain:`, `drive:anyone`; undiscoverable links get none |
| 6 User → principals | Done | `acl.ts driveKeysFor()`: `drive:user:<email>`, `drive:anyone`, Workspace domain. Groups not expanded yet (needs the Workspace Admin SDK), so group-only files are hidden: safe, incomplete |
| 7 Identity link | Done (demo) | The persona's email is the Google identity; the Drive page picks the person (demo shortcut, like the Slack page) |
| 8 Live check | Done | `query.ts`: each matching file's sharing re-read with `files.get` before answering; fail closed; stale labels fixed on the spot |
| 9 Permission changes | Done | Sharing-only change → `update_by_query` on the labels, no re-download |
| 10 Verify | Done | `drive:verify` |
| 11 Fixtures + tests | Done | `fixtures/drive/` (real API payloads), `src/__tests__/drive.test.ts` |

Drive docs live in `brain-drive`, not `brain`, and use their own shape (`file_id`, `title`, `path`, `chunk_index`, ...) with the same `acl_container` label field. Drive has its own retrieval (`connectors/drive/query.ts`) and page (`/drive.html`). To search both sources in one place, query both indexes with the union of the person's Slack and Drive keys in the same `terms` filter, run each hit's own live re-check, and write one audit record through `src/audit/store.ts appendAudit()` (Slack's `logEntry()` can switch to it with a small change).

**Wiring a new connector in:**

1. Put source-specific code in its own files (today's Slack files, or a future `src/connectors/<source>/`).
2. Write documents through `indexer.ts` into the same index. Don't create a second index or bypass the labels.
3. Combine principals from all sources for the user (union), keyed by the login email.
4. Extend the live re-check in `retrieve()` for the new `source`.
5. Add its events or webhooks to the server start-up.
6. Don't add anything that sends unfiltered content to the LLM or the UI. `retrieve()` is the only way in.

## Towards the full product

- **Real login.** Replace the persona dropdown with SSO (e.g. Google). The backend must take identity from the login session, never from the request body.
- **Identity map.** Store login email → `{ slack, atlassian, google }` IDs once and reuse it.
- **Semantic search.** Add a `dense_vector` field and a `knn` clause with the **same** permission `filter` inside it. Never use `post_filter` for security.
- **Tamper-evident audit.** Done for Drive (`src/audit/`: HMAC hash chain in `brain-audit`, `audit:verify`). Slack's log is still in memory; point `logEntry()` at `appendAudit()`. For production, also anchor the chain head somewhere append-only.
- **Agentic Ask.** Let the LLM call a `search(query)` tool several times. The server always runs it as the logged-in user.
