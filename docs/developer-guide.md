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
| `src/search.ts` | shared | `retrieve()`: filtered search, live re-check, audit entry (DM redaction) |
| `src/ask.ts` | shared | Question → keywords → `retrieve()` → cited answer |
| `src/llm.ts` | shared | OpenAI-compatible chat client |
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

**Wiring a new connector in:**

1. Put source-specific code in its own files (today's Slack files, or a future `src/connectors/<source>/`).
2. Write documents through `indexer.ts` into the same index. Don't create a second index or bypass the labels.
3. Add the source's principals to `getAccess()` for the person (union), keyed by email.
4. Extend the live re-check in `retrieve()` for the new `source`.
5. Add its events or webhooks to the server start-up.
6. Don't add anything that sends unfiltered content to the LLM or the UI. `retrieve()` is the only way in.

## Towards the full product

- **Real login.** Add Google SSO (or Sign in with Slack) as the main login, then turn off impersonation. Slack Connect becomes "link your Slack accounts" after login. The backend already takes Me-mode identity only from the signed cookie.
- **Token storage.** Replace `tokens.ts` with an encrypted database, and turn on token rotation.
- **Slack Connect channels** (shared between workspaces, paid plans): a new label case, since one channel belongs to several workspaces.
- **Semantic search.** Add a `dense_vector` field and a `knn` clause with the **same** permission `filter` inside it. Never use `post_filter` for security.
- **Tamper-evident audit.** Persist the log in a hash chain (each entry stores the previous entry's hash) with a verify endpoint. The current log is in memory only.
- **Agentic Ask.** Let the LLM call a `search(query)` tool several times. The server always runs it as the asking person.
