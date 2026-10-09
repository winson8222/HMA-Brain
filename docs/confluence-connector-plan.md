# Confluence connector: plan

**Status:** planned 2026-10-06. **Connector built 2026-10-07** on branch `confluence-connector` in `HMA-Brain` (`src/connectors/confluence/`, uncommitted at the time of writing): connection, ingestion (backfill, poll, reconcile), permission-aware retrieval with the live re-check, audit records, `confluence:doctor|backfill|poll`, unit tests (`src/__tests__/confluence.test.ts`). Typecheck and all 170 tests pass. **Phase 0 and phase 4 done 7 Oct** (live run verified, `seed:confluence` built and run; content in [confluence-demo-content.md](confluence-demo-content.md)). **Still open:** Bob/Alice/Dave linking their accounts for the negative-case checks, CodeBuddy screenshots.
Decision taken: Confluence goes on Carol's existing Atlassian site and uses the **Premium trial** (see [feasibility](confluence-connector-feasibility.md) for the research behind every choice here).
Target codebase: `HMA-Brain/`, as `src/connectors/confluence/`, copying the Jira layout file for file.

> **Built as planned, with these differences:**
> - **Enabling:** the connector loads only when `CONFLUENCE_SYNC` is set (`on` or `off`), so a Jira-only setup doesn't get Confluence by accident. Everything else defaults to the `JIRA_*` values.
> - **Poll window:** CQL uses a relative date, `lastmodified >= now("-<minutes>m")`, computed from the stored cursor plus a 2-minute overlap. No time-zone handling needed (verified 7 Oct).
> - **Fan-out:** descendants of a page whose restriction changed come from the stored tree in `brain-confluence-state` (`parent_id`), not from the descendants API.
> - **Reconcile:** `confluence:poll -- --sweep` runs it by hand; the server runs it every `CONFLUENCE_RECONCILE_MINUTES` (default 10).
> - **Identity:** reads the link from `brain-jira-state` (open item 4 decided: no shared link store yet). `confluence:doctor` needs Jira configured.
> - **Doctor:** proves Confluence Administrator by running the permission check on a sample page; no routes or UI changes.
> - Label prefix is `confluence:` (open item 3 decided).
> **Verified on the real site, 7 Oct 2026** (`hma-brain-demo.atlassian.net`, Premium trial, role-based space permissions UI):
> - v2 `GET /spaces/{id}/permissions` returns `user` and `group` principals with `operation.key = read, targetType = space`; the two site apps show up as users. The connector's labels matched the UI exactly.
> - `POST /content/{id}/permission/check` works for the crawler with Confluence Administrator; `confluence:doctor` proves it on a sample page.
> - CQL `lastmodified >= now("-Nm")` is accepted by Cloud, and an edit was indexed on the very next poll (seconds, no search-index lag seen).
> - **A view-restriction change does not change `lastmodified`.** The poll never sees it; the reconcile sweep does (`confluence:poll -- --sweep`, or every `CONFLUENCE_RECONCILE_MINUTES`). Between the two, the live re-check withholds the page at query time, so S4 still works immediately.
> - Search, Ask (correct cited answer) and the audit records work as Carol. Bob, unlinked, gets nothing.
> - Seeding (`seed:confluence`, built 7 Oct): v2 `POST /spaces` with `roleAssignments` works; `POST /spaces/{id}/role-assignments` takes an **array**; a space created by API gives its creator **no role** (page creation then fails with 404), so the seed assigns the admin the Admin role.


> **Build it with CodeBuddy or WorkBuddy** and capture the chats. Three screenshots minimum are needed for the submission, and this connector is the last big build step before 16 Oct.

## 0. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where Confluence lives | **Carol's existing Atlassian site**, Confluence added as a second product. Premium trial started from Settings → Billing → Change plan. **Never** from the public "Start now" page: that creates a separate empty site. | Same users, account IDs, groups and API token as Jira. |
| Plan | **Premium trial (30 days)**, started on or after 5 Oct so it still covers Demo Day (3 Nov). **Carol reads the end date on the Billing page and posts it in the team chat.** | Free has no permissions at all. Standard's 14 days end before Demo Day. |
| Crawler | **The same crawler account and API token as Jira** (`JIRA_EMAIL` / `JIRA_API_TOKEN`). It needs Confluence product access and the **Confluence Administrator** global permission. | An API token belongs to the Atlassian account, not to a product. One setup step less. |
| Crawler can see everything | Group `brain-crawler` gets **View** on every space and is **named in every view restriction**. | Same rule as Jira security levels: an admin does not bypass view restrictions. A page the crawler can't read is never indexed, so nobody can find it. |
| Identity | **Reuse the "Connect Jira" link.** The Atlassian `account_id` stored in `brain-jira-state` is the same person on Confluence. No email matching. | Confluence can't look up users by email anyway. One click for the persona instead of two. Rename the button "Connect Atlassian" when touching the UI. |
| Index | Own indexes `brain-confluence` and `brain-confluence-state`. | Same reasons as Drive and Jira: backfills and resets never touch another source. |
| Labels | `confluence:<site>:user:<accountId>`, `confluence:<site>:group:<groupId>`, `confluence:<site>:anyone`. Two layers: `acl_container` (space View) and `restricted` + `acl_item` (effective page view restriction). | Developer guide line 158 and 161 sketch exactly this. The Jira filter and `canSee` functions are reused as-is with a different prefix. |
| Effective restriction | `acl_item` = the labels of the **nearest** restricted node on the path (the page itself, else its closest restricted ancestor). | Confluence inherits view restrictions down the tree. Computing a true intersection of user and group sets isn't possible with labels alone. "Nearest" can only over-include, never under-include, and the live check closes that gap. |
| Live check | `POST /wiki/rest/api/content/{id}/permission/check` with `{subject:{type:"user",identifier:<accountId>}, operation:"read"}`, one call per candidate page, in parallel, fail closed. | Confluence evaluates site, space and content restrictions server-side, inherited ones included. It is the Confluence analogue of Jira's `permissions/check`. |
| Change detection | Polling, 60 s, on CQL `lastmodified`, plus a space-permission hash check every poll, plus a reconcile sweep. **No Forge app.** | Confluence Cloud webhooks need a Forge or Connect app. Polling matches the other connectors and the freshness budget. |
| Body format | `atlas_doc_format` → text through the existing `adf.ts`. | Already written and tested for Jira. `storage` would need an XHTML stripper. |
| Content rule | **A document exists in Drive or in Confluence, never both.** | Duplicate documents make citations ambiguous and make the S2 edit look wrong. Section 6 says what goes where. |
| Dave | Dave **gets** Confluence access, limited to the vendor space. | The brief's S3 example is a contractor asking for a security report. Dave asking and getting nothing, with the space existing, is the stronger demo. "Dave not invited" is the fallback if the trial fails. |

## 1. How Confluence decides who can read a page

| Layer | Rule | Where the connector reads it |
|---|---|---|
| **Product access** | The account must have Confluence access on the site. | Membership of `confluence-users-<site>` via `GET /wiki/rest/api/user/memberof?accountId=`; no separate label needed because space grants to that group become group labels. |
| **Space permission: View** | Granted to users, groups or anonymous. Required for anything in the space. | `GET /wiki/api/v2/spaces/{id}/permissions` (items with `operation.key = "read"` and `operation.targetType = "space"`). Fallback if v2 omits anonymous grants: `GET /wiki/rest/api/space/{key}?expand=permissions`. |
| **Page restriction: View** | Optional, users or groups. **Inherited by every descendant.** Can only narrow the space permission. | `GET /wiki/rest/api/content/{id}/restriction/byOperation/read` for the page's own; `GET /wiki/api/v2/pages/{id}/ancestors` to find inherited ones. The API does not return inherited restrictions itself. |
| Edit restrictions | Don't affect reading. Not inherited. | Ignored. |

Compared with Jira there are no roles, no reporter/assignee grants, no picker fields and no restricted comments. The one new thing is the tree.

## 2. Code layout

```
src/connectors/confluence/
  config.ts     CONFLUENCE_* env, defaults to JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN when unset
  client.ts     Basic-auth client (copy of jira/client.ts with /wiki paths), 429 retry, cursor paging
  acl.ts        pure: space permissions → labels, restrictions → labels, keysFor, filter, canSee, recheck
  spaces.ts     spaceAcl(space): View labels + hash           (≈ jira/schemes.ts)
  docs.ts       ConfluenceDoc, pageToDocs(), chunking, cqlTime (≈ jira/docs.ts)
  store.ts      mappings and CRUD for brain-confluence / brain-confluence-state
  sync.ts       backfill, pollOnce, sweep, startPolling, loadStatus, confluenceStatus
  query.ts      retrieve(): hybrid search → live check → audit (≈ jira/query.ts)
  people.ts     confluenceAccess(personId): link (from Jira) → groups → keys, 5-min cache
  index.ts      the Connector object
  cli/backfill.ts  cli/poll.ts  cli/doctor.ts  cli/seed.ts  cli/seedData.ts
src/connectors/jira/adf.ts   reused by import (or moved to src/connectors/atlassian/adf.ts if the team prefers no cross-connector imports)
```

Registry: `confluenceConfigured` in `src/connectors/index.ts`, one more spread line. Server: three lines in `server.ts` mirroring Jira's (routes are not needed; the link flow stays in Jira). Status: `confluence: confluenceStatus` in `/api/status`.

Scripts: `confluence:backfill [-- --reset]`, `confluence:poll [-- --watch]`, `confluence:doctor`, `seed:confluence [-- --update | --restrict-drill | --unrestrict-drill | --edit-decision]`.

Env (`.env.example`):

```
# ---- Confluence connector (same site and crawler as Jira; see docs/confluence-connector-plan.md) ----
# CONFLUENCE_BASE_URL=        # defaults to JIRA_BASE_URL
# CONFLUENCE_EMAIL=           # defaults to JIRA_EMAIL
# CONFLUENCE_API_TOKEN=       # defaults to JIRA_API_TOKEN
CONFLUENCE_SPACES=ENG,SEC,VEND  # empty: every space the crawler can view
CONFLUENCE_SYNC=on
# CONFLUENCE_POLL_SECONDS=60
# CONFLUENCE_RECONCILE_MINUTES=10
# CONFLUENCE_INDEX=brain-confluence
# CONFLUENCE_STATE_INDEX=brain-confluence-state
```

`confluenceConfigured` is true when the resolved base URL, email and token are set. Confluence depends on Jira's link store, so `confluence:doctor` fails if Jira isn't configured.

## 3. Stored data

**`brain-confluence`**, one doc per chunk:

| Field | Contents |
|---|---|
| `doc_id` | `confluence:<site>:<pageId>:<chunk>` |
| `source` | `confluence` |
| `page_id`, `title`, `chunk_index`, `heading` | Chunks of ≈3,000 chars, split on headings first (as Drive does), at most 20 |
| `space_id`, `space_key`, `space_name` | For `location`, the audit `path` and the S5 query "everything in space X" |
| `ancestor_ids`, `parent_id` | For relabelling a subtree when a parent's restriction changes |
| `text` | Plain text from ADF, first line `Title` |
| `author_id`, `author_name` | Last modifier (`version.authorId`), display name looked up and cached |
| `created_at`, `updated_at`, `version`, `ts` | `updated_at` is `version.createdAt` |
| `permalink` | `_links.base + _links.webui` |
| `acl_container` | Space View labels |
| `restricted`, `acl_item` | Effective view restriction (nearest restricted node) |
| `content_hash` | sha256 of text + labels, so a permission change rewrites the page |
| `text_vector` | when `EMBEDDING_DIMS` is set, as the others |

**`brain-confluence-state`:**

| Doc | Contents |
|---|---|
| `space:<id>` | `SpaceAcl`: `space_id`, `key`, `name`, `view: Rule`, `hash`, `synced_at` |
| `page:<id>` | `space_id`, `parent_id`, `own_restriction: string[] \| null`, `effective: string[] \| null`, `restriction_hash`, `content_hash`, `synced_at` |
| `connector` | `account_id`, `last_backfill_at`, `last_poll_at`, `cursor` |

The per-page state is what Jira doesn't have and Drive does. It is needed because a restriction change on a parent has to fan out to descendants without re-reading their bodies.

## 4. Sync

**Backfill** (`confluence:backfill`):

1. `ensureIndices` (or reset). `GET /wiki/rest/api/user/current` to confirm the token.
2. Record `started` as the next cursor.
3. List spaces (`GET /wiki/api/v2/spaces?keys=…`). For each: `spaceAcl` or drop (fail closed, as `aclOrDrop`).
4. For each space: page through `GET /wiki/api/v2/pages?space-id=…&status=current&body-format=atlas_doc_format&limit=50`. For each page read its own read restriction, compute the effective one from already-processed ancestors (process in tree order: `GET /wiki/api/v2/spaces/{id}/pages` returns flat, so sort by ancestor depth from `ancestors` first, or recurse from root pages with `direct-children`). Skip pages whose `content_hash` is unchanged. Delete indexed pages that no longer appear.
5. Save the connector cursor last.

**Poll** (every `CONFLUENCE_POLL_SECONDS`), in order, like Jira:

1. Re-read every in-scope space's permissions. Hash changed → relabel the whole space (`update_by_query` on `acl_container`, then rewrite `content_hash`). New space → backfill it.
2. `GET /wiki/rest/api/content/search?cql=type=page and space in (…) and lastmodified >= "<cursor − 2 min>" order by lastmodified&limit=50` (v1; v2 has no search). For each page: re-read body and own restriction; if the own restriction changed, recompute `effective` for it and for all descendants (`GET /wiki/api/v2/pages/{id}/descendants`) and relabel them.
3. Save the cursor.

**Reconcile** (every `CONFLUENCE_RECONCILE_MINUTES`, default 10 on the demo site): list every page id per space (ids only, no bodies), delete indexed pages that are gone, trashed or archived, and re-read every page's own restriction. This is the safety net for the one thing `lastmodified` may not reflect: a restriction change with no content edit (**unverified**, spike item 4). At Aspire scale the interval goes to 60 and a webhook app replaces it.

**Freshness budget for S2:** poll interval (≤60 s) + Confluence's search-index lag (reported as a few minutes). Measure it on the real site and quote the number in the demo. If the lag is bad, the fallback poll is `GET /wiki/api/v2/pages?sort=-modified-date` and stop at the cursor (sort value **unverified**).

## 5. Query

`retrieve(personId, q, opts)`, step for step as Jira's `query.ts`:

1. `confluenceAccess(personId)`: Jira's `getLink` → account ID → `user/memberof` → keys. Not linked or account gone → nothing.
2. Candidates: BM25 on `title^3, text` plus kNN, both with the two-layer filter, fused with RRF. `onePerPage` for Search mode.
3. Live check: `permission/check` for each distinct `page_id`, up to 8 in parallel. Any error → every hit withheld with the reason.
4. Allowed vs dropped. Shadow query (no filter) → `denied` for the audit with the reason "not in this page's view restriction" or "no View permission on this space".
5. `Evidence`: `title`, `location` = `<space_name> › <parent title>`, `author`, `time = updated_at`, `permalink`, `private = restricted`.

`describe`: `"<title> · <space> · updated <date>"`. `answerHint`: "Cite the page title and space; a page may be newer than the Slack messages that mention it."

Audit `path` = `<space_key>/<title>` so S5's "everything jdoe accessed in the payment-gateway space" is a prefix filter on `path` with `source = confluence`.

## 6. Demo data

> **Superseded by [confluence-demo-content.md](confluence-demo-content.md)** (7 Oct): full page texts, a VEND space, and two corrections (the auth page is the *rollout plan* for Drive's ADR-012, and the incident process page is dropped because Drive has the handbook). The table below is the original sketch.

Same company, same four people, same outage. Confluence holds **what a wiki would hold** and Drive keeps the files it already has. No document is in both.

**Groups** (already exist on the site from the Jira seed): `payments-eng` (Alice, Bob), `security` (Carol), `vendors` (Dave), `brain-crawler` (the crawler). **Product access:** Alice, Bob, Carol, Dave and the crawler all get Confluence access. Carol is Confluence admin; the crawler gets Confluence Administrator through `brain-crawler`.

**Spaces and View permission**

| Key | Name | View | Why |
|---|---|---|---|
| `ENG` | Engineering | `payments-eng`, `security`, `brain-crawler` | Team wiki. Bob's home ground. |
| `SEC` | Security | `security`, `brain-crawler` | The restricted space in the brief's S3 example. |
| `VEND` | Acme vendor portal | `vendors`, `security`, `brain-crawler` | What Company A shares with Acme. The only space Dave sees. |

**Pages** (≈9, each 1–2 chunks). Page restrictions name `brain-crawler` as well.

| Space | Page (parent › child) | View restriction | Role in the demo |
|---|---|---|---|
| ENG | **Auth service token redesign: decision** | none | **S1**: the brief's own example, "summarize the design discussion from Slack and link the Confluence decision doc". Cites `#eng-auth` + this page + the Jira ticket. **S2**: Alice adds "Decision: rotate signing keys every 24 h" live (`--edit-decision`). |
| ENG | Incident response process | none | Links to the Drive runbook by name; says action items go to the PAY Jira project. |
| ENG | Checkout failover drill results | none → **Alice, Carol** (`--restrict-drill`) | **S4**: Bob can read it, Carol restricts it, Bob asks again straight away → dropped by the live check. `--unrestrict-drill` resets. |
| ENG | Postmortems (parent, empty shell) | **Alice, Carol** | Inheritance demo. Bob never sees anything under it. |
| ENG | Postmortems › **Outage follow-up review** | inherited | Status of PAY-240 / PAY-241, the pooling decision, "25 minutes lost finding the runbook". Alice yes, Bob no, through the parent only. |
| SEC | **Acme vendor security review** | none (space is enough) | **S3**: Dave asks "what did the security review of Acme find?" → nothing, no hint. Carol gets the findings. |
| SEC | Access review: Q3 | none | Mentions Dave's temporary postmortem share being revoked. Carol only. Cross-links S4/S5. |
| VEND | **Acme integration guide** | none | Dave's legitimate content; also seen by Carol. |
| VEND | Escalation contacts | none | Dave: "who do I call at Company A?" |

**Golden questions to add** (section 10 of the demo story doc gets these rows):

| Ask as | Question | Expected | Leak canary |
|---|---|---|---|
| Bob | What was decided about auth service tokens? | The decision page + `#eng-auth` thread. | — |
| Bob, then after `--edit-decision` | How often are signing keys rotated? | Before: not decided. After: every 24 h. | — |
| Alice, then Bob | What did the outage follow-up review conclude? | Alice: the review. Bob: no information. | "follow-up review", "pooling" |
| Dave, then Carol | What did the security review of Acme find? | Dave: no information. Carol: the findings. | "vendor security review" |
| Bob, Carol restricts, Bob again | What happened in the last checkout failover drill? | Before: the results. After: no information; admin view shows "dropped by live re-check". | "drill" |
| Carol (audit tab) | Everything Dave retrieved from Confluence | Only VEND pages; the SEC denial is logged. | — |

**Seed** (`seed:confluence`, Carol's admin token, same `JIRA_ADMIN_*` variables): create spaces (v1 `POST /wiki/rest/api/space` with the permission list, or v2 then `POST /wiki/rest/api/space/{key}/permission` per grant), create pages (v2 `POST /wiki/api/v2/pages`, `storage` body from `seedData.ts`), set restrictions (v1 `PUT /wiki/rest/api/content/{id}/restriction`). `--update` rewrites existing pages (new version). Flags for the live beats as in the table. Everything idempotent, keyed by space key + title.

## 7. Doctor and acceptance

`confluence:doctor` checks, in order: token works and names the crawler; Confluence Administrator present (call `permission/check` for the crawler's own account on any page; a 403 means no admin); each configured space readable with its View labels listed; every indexed restricted page still readable by the crawler; Jira link store reachable; each linked person's key count.

**Acceptance (run as each persona through the UI):**

- Alice sees ENG including the Postmortems subtree; not SEC; not VEND.
- Bob sees ENG except the Postmortems subtree; not SEC; not VEND.
- Carol sees everything.
- Dave sees VEND only. His SEC question logs `denied`.
- `--restrict-drill` then Bob again within 10 s → `dropped`, reason "no View permission in Confluence now".
- Audit chain verifies after all of the above.

## 8. Phases and effort

| Phase | What | Effort | Who |
|---|---|---|---|
| **0. Site + spike** ✅ 7 Oct | Carol adds Confluence, starts the Premium trial, posts the end date. Grants product access to the five accounts and Confluence Administrator to `brain-crawler`. One throwaway script hits: space permissions (v2 shape, anonymous), `permission/check` as a persona, restriction read after a change (does `lastmodified` move?), search lag, `sort=-modified-date`. Capture real payloads into `fixtures/confluence/`. | ½ day | Carol (10 min) + one dev |
| **1. Ingest** ✅ | `config`, `client`, `acl`, `spaces`, `docs`, `store`, `sync.backfill`, `confluence:backfill`. Unit tests for `acl` (nearest-restricted cases) and `docs`. | 1 day | dev A |
| **2. Query** ✅ | `people`, `query`, `index`, registry, server status, `federated.test.ts` mock. Search and Ask show Confluence results. | ½ day | dev A |
| **3. Keep current** ✅ | `pollOnce`, space relabel, subtree relabel, sweep, `confluence:poll`, timers. | ½ day | dev A |
| **4. Demo data** ✅ 7 Oct (`seed:confluence`) | `seedData.ts` content, `seed:confluence` with the four flags, `docs/demo-data.md` and the golden questions updated. Can start in parallel with phase 1 once phase 0 confirms the write endpoints. | 1 day | dev B |
| **5. Finish** (doctor, README, tests done; seed flags, Connect label, architecture trade-offs, CodeBuddy screenshots open) | `confluence:doctor`, README section (copy the Jira one), `docs/confluence-connector-plan.md` in the repo, Connect button label, trade-offs in the architecture doc, CodeBuddy screenshots. | ½ day | dev A |

Critical path ≈ 3 days for one developer, 2 with two. Phase 0 before anything else, and before 8 Oct so there is a week of margin to 16 Oct.

## 9. Trade-offs to carry into the architecture doc

- **Poll vs Forge webhooks.** Chosen poll; cost is the search-index lag inside the freshness window. Webhooks are the obvious upgrade for a customer deployment.
- **Nearest-restricted-node labels vs exact intersection.** Chosen nearest; it over-includes at most, and the server-side check corrects it. Exact would require storing user and group sets separately per level.
- **One permission check per hit.** Jira batches, Confluence doesn't. At demo scale it is sub-second in parallel. At scale: short TTL cache keyed by (account, page, page version) with revocation latency equal to the TTL, and say so.
- **Crawler in every restriction.** Operational rule, same as Jira. A page restricted without the crawler simply isn't searchable, which is the safe direction.

## 10. Open items for the team

1. Confirm the content split in section 6, especially that the runbook and the postmortem **stay in Drive** and Confluence holds the decision, process and review pages.
2. Dave gets Confluence access (VEND only) or not at all.
3. ~~`confluence:` vs `conf:` as the label prefix~~ Built with `confluence:`.
4. ~~Keep reading the link from `brain-jira-state`, or move links to a shared `brain-atlassian-state` now~~ Built reading `brain-jira-state`; revisit only if Confluence ever lives on another site.
5. Reconcile every 10 minutes on the demo site; what to say about that number at Aspire scale.
6. Jira's own Premium trial ends around 3 Nov, Demo Day. Decide whether to accept that or re-seed on a fresh site later.
