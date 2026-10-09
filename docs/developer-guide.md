# Developer guide

[← Back to README](../README.md)

## Architecture

```
                         ┌──────────────── SLACK CONNECTOR (one Workspace object per workspace) ────────────┐
Slack workspace A ─events─▶│ events.ts     live changes (one Socket Mode connection per workspace)          │
Slack workspace B ─events─▶│ sync.ts       backfill + 5-min reconcile, per workspace                        │
                 ─history─▶│ dms.ts        DMs / group DMs, read with connected people's user tokens         │──write──▶ Elasticsearch
                           │ slackDocs.ts  Slack item → BrainDoc + permission label                           │           index "brain"
                           │ people.ts     person (by email) → principals across all workspaces              │               ▲
                           └────────────────────────────────────────────────────────────────────────────────────┘               │
                                                                                                                              filtered query
Browser ─▶ server.ts ─┬─▶ search.ts  retrieve(): filter → live re-check (channels) → audit (withheld DMs redacted) ────────────┘
  index.html          ├─▶ ask.ts ──▶ llm.ts (OpenAI-compatible): keywords → retrieve() → answer with [n] citations
  connect.html        └─▶ oauth.ts + session.ts: Connect (Slack OAuth) → user token + signed login cookie
                                     tokens.ts: slack-tokens.json (workspace tokens, people's tokens)
```

**Core principle: permissions are enforced before the LLM, never by it.**

1. Every indexed document carries a **permission label** (`acl_container`): the principals allowed to see it.
2. At query time the asker's **principals** are looked up from Slack, across every workspace they're in.
3. Elasticsearch filters by them **inside the query** (`bool.filter`). Restricted documents are never scored, returned, or put in a prompt.
4. Each channel hit is **re-checked live** against Slack, which catches permission changes that haven't reached the index yet. DM hits need no re-check, because who is in a DM never changes.
5. Users get only content fields. There are no hit counts, and "nothing found" and "all restricted" look the same, so restricted content's existence isn't revealed.
6. The LLM is told to answer only from the given messages and cite them. Even if it ignored that, it only ever received permitted content.

## Who is asking

| Mode | How the asker is decided | When |
|---|---|---|
| **Me** | Only from the signed login cookie (`session.ts`), set when the person completes Connect. The request body is ignored. | Always available. The only mode when `ALLOW_IMPERSONATION=off`. |
| **Demo** | The UI sends a `personId` (an email) chosen from the dropdown. | Only when `ALLOW_IMPERSONATION=on`, for the side-by-side compare. |

Every audit entry records which mode was used.

## Files

| File | Layer | Role |
|---|---|---|
| `src/acl.ts` | shared | Principal strings, `aclForChannel()`, `aclFilter()`, `canSee()` |
| `src/es.ts` | shared | Elasticsearch client and index mapping |
| `src/indexer.ts` | shared | Upsert, bulk upsert, delete (with thread replies), delete conversation, relabel |
| `src/search.ts` | Slack | `retrieve()`: filtered search (lexical or BM25+kNN fused client-side — the ES `rrf` retriever needs an Enterprise license), live re-check, optional Cohere rerank |
| `src/connectors/types.ts`, `index.ts` | shared | The `Connector` contract (`retrieve` as the asker → `Evidence`) and the registry: the only list of platforms |
| `src/connectors/slack/index.ts`, `src/connectors/drive/index.ts` | Slack / Drive | Each platform's `Connector`, wrapping its own permission-aware retrieval |
| `src/federated.ts` | shared | Search/Ask over the chosen connectors (`sources`): per-source retrieval in parallel, RRF merge, one rerank, cited answer, one audit record |
| `src/llm.ts` | shared | OpenAI-compatible chat client (timeout + retries; Langfuse generations) |
| `src/hybrid.ts` | shared | Hybrid retrieval: mode/rerank resolution, `knnQuery()` (ACL filter inside the knn clause), `rrfFuse()` |
| `src/embeddings.ts` | shared | OpenAI-compatible `/embeddings` client; ingest enrichment (`withVectors`) and query embedding |
| `src/rerank.ts` | shared | Cohere Rerank client + pure reorder helper |
| `src/multiQuery.ts` | shared | Multi-query retrieval: LLM rephrasing of the question into N semantic variants (`MULTI_QUERY` knob) |
| `src/tracing.ts` | shared | Langfuse (v4/OTel) tracing: per-query waterfall spans; no-op when unset |
| `src/prompts.ts` | shared | Langfuse prompt management: fetches versioned prompts, falls back to built-in defaults |
| `src/askRules.ts` | shared | The source-neutral Ask rules (the fallback for the Langfuse `ask-answer-rules` prompt); connectors add an `answerHint` |
| `src/judge.ts` | shared | `npm run judge`: LLM-as-judge — scores Ask traces for faithfulness and posts scores to Langfuse |
| `src/session.ts` | shared | Signed cookie ("who am I") and signed OAuth `state` |
| `src/server.ts` | shared | Express API, static UI, Connect routes, starts one Socket Mode app per workspace |
| `public/index.html` | shared | UI: Ask/Search, Demo/Me, two-person compare, audit log |
| `public/connect.html` | shared | Connect / Disconnect per workspace |
| `src/tokens.ts` | Slack | Reads and writes `slack-tokens.json` (the only place tokens are stored) |
| `src/slack.ts` | Slack | `Workspace` class (bot client, channel and user caches) and the workspace registry |
| `src/people.ts` | Slack | People linked across workspaces by email; `getAccess()` → principals |
| `src/dms.ts` | Slack | DM lookup, DM backfill, cleanup after Disconnect |
| `src/oauth.ts` | Slack | Connect flow: authorize URL, code → user token |
| `src/slackDocs.ts` | Slack | Pure mapping of Slack messages/events → `BrainDoc` |
| `src/events.ts` | Slack | Live event handlers (channels and DMs) |
| `src/sync.ts` | Slack | Backfill (channels + DMs), channel reconcile |
| `src/seedSlack.ts` | Slack | Demo data in both workspaces, DMs posted as personas (writes to Slack only) |
| `src/verify.ts` | Slack | Slack vs index consistency check, channels and DMs |
| `src/connectors/drive/acl.ts`, `extract.ts`, `chunk.ts`, `docs.ts` | Drive | Pure: sharing → labels, text extraction rules, chunking, file → docs, change decisions |
| `src/connectors/drive/client.ts`, `auth.ts` | Drive | Drive API client (admin's token, retries), OAuth helpers |
| `src/connectors/drive/store.ts`, `tree.ts` | Drive | `brain-drive` / `brain-drive-state` indexes, folder map and paths |
| `src/connectors/drive/sync.ts` | Drive | Backfill, poll the changes feed, per-file update |
| `src/connectors/drive/query.ts`, `prompt.ts` | Drive | Search/Ask: filtered query, live re-check with Drive, prompt and citations |
| `src/connectors/drive/routes.ts`, `people.ts` | Drive | `/api/drive/*` and Connect Google Drive; the demo people |
| `src/connectors/drive/pdf.ts` | Drive | PDF text extraction |
| `src/connectors/drive/cli/*` | Drive | `drive:connect`, `seed:drive`, `drive:backfill`, `drive:poll`, `drive:verify`, `drive:ask`, `drive:doctor` |
| `public/drive.html` | Drive | Drive page: Ask/Search with two-person compare, and an admin-only Audit log tab (filters, verify, connect) |
| `src/connectors/jira/*` | Jira | Jira Cloud connector: two-layer labels (project browse + security level), live re-check with Jira's bulk permission check, polling sync; Connect Jira links each person to their Atlassian account; `jira:backfill`, `jira:poll`, `jira:doctor`. See [jira-connector-plan.md](jira-connector-plan.md) |
| `src/audit/chain.ts`, `store.ts` | shared | Tamper-evident audit log: record kinds, HMAC hash chain in `brain-audit`, query and verify |
| `src/audit/events.ts`, `record.ts` | shared | Permission and content change records from the syncs (pure builders + the writers sync code calls) |
| `src/audit/routes.ts`, `cli.ts`, `format.ts`, `src/admin.ts` | shared | Admin-only audit API (`ADMIN_TOKEN`), `audit:log`, `audit:verify` |

## Document shape

Every source produces the same document type (currently `BrainDoc` in `src/slackDocs.ts`):

| Field | Example | Notes |
|---|---|---|
| `doc_id` | `slack:T09MAIN:C09ABC:1790000000.000100` | `<source>:<workspace>:<conversation>:<item>`, stable and unique |
| `source` | `slack` | |
| `team_id` / `team_name` | `T09MAIN` / `Company A Demo` | Workspace; shown as a badge on every result |
| `channel_id` / `channel_name` | `C09ABC` / `payments-incident`, or `D09…` / `DM: Alice ↔ Carol` | Conversation |
| `kind` | `channel`, `dm`, `group_dm` | |
| `is_private` | `true` | For display |
| `user_id` / `user_name` | `U09ALICE` / `Alice` | Author |
| `text` | … | Searchable content |
| `ts` | ISO date | Used for "as of" and ranking |
| `permalink` | `https://…/archives/…` | Citation link back to Slack |
| `acl_container` | `["slack:T09MAIN:channel:C09ABC"]` | **Permission label. Required.** |
| `text_vector` | `[0.013, -0.082, …]` | Dense vector of `text` (embedding model from `.env`). Optional; only for hybrid search. Set once per doc at ingest by `withVectors()`; a doc without it is invisible to the kNN leg but still searchable lexically. |

## Permission model

A principal is a string for one way of getting access. A person may see a document if **any** principal in the document's label is in their principal list. Every Slack label names its workspace, so labels from different workspaces can never collide.

| Slack | Label on a message | Person's principals |
|---|---|---|
| Public channel | `slack:<team>:member`, `slack:<team>:channel:<id>` | `slack:<team>:member` for each workspace where they're a full member |
| Private channel | `slack:<team>:channel:<id>` | `slack:<team>:channel:<id>` for each channel they're in |
| Guest | | Only their own channels' principals |
| DM / group DM | `person:<email>` for each participant | `person:<own email>` |

A person is identified by **email** across workspaces, so their principals are the **union** of every workspace they're in (`people.ts`). Someone who isn't in a workspace has none of its principals, so they see nothing from it. People without an email in Slack get a workspace-scoped ID instead.

DMs are read with a **participant's own user token** (the bot can't read DMs). A DM stays indexed while at least one participant is connected. Disconnect removes a DM once no participant is still connected.

Namespace every principal by source (`slack:`, `gmail:`, `jira:`…), so labels from different sources can never collide.

## Tokens: this demo vs a real product

| Token | This demo | Real product |
|---|---|---|
| **Bot token per workspace** | One Slack app per workspace; tokens pasted into `slack-tokens.json` | **One** app, published for distribution. Each company's Slack admin clicks "Add to Slack" once, and Slack returns that workspace's bot token to the server, which stores it. Enterprise Grid companies can install once for the whole org. |
| **User token per person** | "Connect" button; token written to `slack-tokens.json` | The same Connect button, shown after the person logs in (e.g. Google SSO). The token goes into an **encrypted database or secrets vault** tied to their login, and is deleted on Disconnect. Turn on Slack's token rotation, so tokens expire and are refreshed. |
| **User permissions** | Read DMs, plus `im:write`, `mpim:write`, `chat:write` so the seed script can post demo DMs | Read DMs only. **Remove the three write permissions.** |

Only `tokens.ts` reads or writes tokens, so moving to a database is a change to that one file.

## Adding a connector (e.g. Gmail, Jira)

A connector turns one source into labelled documents and keeps them in sync. **It must provide all of the following.** A connector that can't do one of them can't be permission-safe.

| # | Requirement | Slack implementation | What to build for a new source |
|---|---|---|---|
| 1 | **Backfill**: fetch all existing items, paginated and rate-limit aware | `sync.ts`, `slack.ts conversationMessages()` | e.g. Gmail `messages.list` + `messages.get`; Jira JQL search |
| 2 | **Live changes**: created, updated **and deleted** | Socket Mode events, `events.ts` | Webhooks or push (Gmail `watch` + `history.list`; Jira webhooks), else polling on `updated since` |
| 3 | **Missed-change recovery**: events can be lost | `npm run backfill`, reconcile job | Periodic reconcile or ID diff against the source |
| 4 | **Mapping to `BrainDoc`**, as a pure, unit-tested function | `slackDocs.ts messageToDoc()` | `gmailDocs.ts`, `jiraDocs.ts` |
| 5 | **Permission label** for every item | `aclForChannel()` | Map the source's rules to principals (table below) |
| 6 | **Person → principals**, looked up fresh at query time | `people.ts getAccess()` | Same idea for the source's accounts, groups and roles |
| 7 | **Identity link**: email → the source's user ID | Slack user's profile email (`users:read.email`) | Atlassian account search by email; Gmail is already the email |
| 8 | **Live check** for the re-check step | `Workspace.getChannel(fresh)` + fresh `getAccess()` | "Can person X see item Y now?" against the source |
| 9 | **Permission-change handling** | member events, relabel on privacy change, Disconnect cleanup | Update labels (`update_by_query`) or refresh principals |
| 10 | **Per-person access where the source requires it** | Connect → user token for DMs (`oauth.ts`, `dms.ts`) | e.g. Gmail: each person connects their mailbox |
| 11 | **Verify script** | `verify.ts` | Items in source vs index, labels correct |
| 12 | **Fixtures + tests** from real payloads | `fixtures/`, `CAPTURE_EVENTS=1` | Same |

**Suggested permission mappings:**

| Source | Label on an item | Person's principals |
|---|---|---|
| Gmail | `person:<owner email>` (a message is visible to its mailbox owner), plus other recipients if you choose | `person:<own email>` |
| Jira | `jira:<site>:<project>:role:<role>`, plus the issue security level when set | Project roles, groups, allowed security levels |
| Confluence | `conf:<site>:space:<key>:viewers`, plus page restrictions (including inherited ones) | Space permissions, groups, `person:<email>` |
| Google Drive | Effective permissions: `person:<email>`, `group:<email>`, `domain:<domain>` | Own email, Google groups, domain |

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

Drive docs live in `brain-drive`, not `brain`, and use their own shape (`file_id`, `title`, `path`, `chunk_index`, ...) with the same `acl_container` label field. Drive has its own retrieval (`connectors/drive/query.ts`) and page (`/drive.html`). To search both sources in one place, query both indexes with the union of the person's Slack and Drive keys in the same `terms` filter, run each hit's own live re-check, and write one audit record through `src/audit/store.ts appendAudit()` (as `federated.ts` does for every source).

**Wiring a new connector in:**

1. Put source-specific code in its own files (today's Slack files, or a future `src/connectors/<source>/`).
2. Write documents through `indexer.ts` into the same index. Don't create a second index or bypass the labels.
3. Add the source's principals to `getAccess()` for the person (union), keyed by email.
4. Extend the live re-check in `retrieve()` for the new `source`.
5. Add its events or webhooks to the server start-up.
6. Don't add anything that sends unfiltered content to the LLM or the UI. `retrieve()` is the only way in.
7. Record its permission and content changes: call `recordItemChange()` with the item's access before and after (see [Audit log](#audit-log)).

## Audit log

Every meaningful action goes into one tamper-evident log, `brain-audit`. Each record carries the previous record's hash, and its own hash is an HMAC (key in `.secrets/audit-key` or `AUDIT_KEY`, never in Elasticsearch) over its contents plus that link, so an edited, deleted or reordered record breaks `audit:verify` from that point on. Records written before a kind existed still verify: the hash covers whatever fields a record has.

| Kind | Actor | Written by | What it holds |
|---|---|---|---|
| `search`, `ask` | the person | `federated.ts` (and the Drive page) | question, keywords, answer, `mode` (signed in or demo), and every document considered with its decision: **allowed** (★ cited), **denied** (not shared with them) or **dropped** by the live re-check. No answer is returned without its record |
| `permission_change` | `system` | Drive sync and live re-check, Jira and Confluence sync, Slack membership events and channel reconcile | the item (ID, title, path), its access before and after (labels, plus `restricted_to` for Jira security levels and Confluence restrictions), a readable summary ("lost: drive:user:dave@…"), and how it was detected (`poll`, `reconcile`, `live-recheck`, `event`) |
| `content_change` | `system` | the same syncs, and live Slack events | `added`, `updated` or `deleted`, and when the index caught up (`indexed_at`) |
| `account` | the person | Slack Connect / Disconnect, Atlassian link / unlink, Drive connected | which source and which account |
| `admin` | `admin` (or the signed-in person for Sync now) | `/api/audit`, `/api/audit/verify`, `audit:log`, `audit:verify`, Drive **Sync now** | the filters used, or the result |

Both change kinds carry `changed_at` (when it happened in the source, or `null` when the source doesn't say) and `detected_at` (when we saw it). Which sources give an exact `changed_at`, and why the gap doesn't expose anything, is in [audit-trail.md](audit-trail.md).

Rules:

- **No content.** Records hold IDs, titles, paths and permission labels, never message, page or file text. DMs show only "a DM" in change records, and the Slack connector's withheld-DM redaction still applies to search records.
- **Backfills are summarised.** A first backfill (or one after `--reset`) writes one `content_change` with `change: "backfill"` and a count, not a record per item. Later reconciles record each real change.
- **One record per real change.** Unchanged items write nothing. Drive judges "edited" by its content hash, because Drive bumps a file's modified time when only its sharing changes.
- **Sync keeps going if the log is down.** A failed write from a sync is logged as `AUDIT WRITE FAILED` and the sync carries on, because the sync is what keeps permissions correct. Searches and answers are the opposite: they fail rather than return without a record.

Querying (`queryAudit()` in `store.ts`, `GET /api/audit`, `npm run audit:log`): `actor`, `kind` (`search`, `ask`, `access` = both, `permission`, `content`, `account`, `admin`; comma-separated), `doc`, `decision`, `since`, `until`, `text`. `doc` takes a chunk doc ID, an item ID (`drive:<file>`, `jira:<site>:<issue>`, `confluence:<site>:<page>`), a bare Drive file ID, or title words. It matches searches that considered the item **and** its permission and content changes, so "when did Dave lose access to the postmortem, and did he see it after?" is one query. Viewing or verifying the log is itself recorded.

## Towards the full product

- **Real login.** Add Google SSO (or Sign in with Slack) as the main login, then turn off impersonation. Slack Connect becomes "link your Slack accounts" after login. The backend already takes Me-mode identity only from the signed cookie.
- **Token storage.** Replace `tokens.ts` with an encrypted database, and turn on token rotation.
- **Slack Connect channels** (shared between workspaces, paid plans): a new label case, since one channel belongs to several workspaces.
- **Tamper-evident audit.** Done for every source and action (see [Audit log](#audit-log)). For production, also anchor the chain head somewhere append-only, and give each admin their own login so `admin` records name a person.
- **Agentic Ask.** Let the LLM call a `search(query)` tool several times. The server always runs it as the asking person.
