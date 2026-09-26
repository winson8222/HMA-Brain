# HMA Brain: permission-aware enterprise knowledge (Slack connector)

HMA Brain answers questions over company data while respecting each source's own access rules. A person only ever gets answers built from content they can see in the source system, and every search is recorded for audit.

This repo contains the first connector, **Slack**, plus the shared search, Q&A and UI layers. More connectors (Gmail, Jira, Confluence, Drive) and a fuller UI will follow. The [developer guide](#developer-guide) explains how they fit in.

**What works today**

- Syncs a real Slack workspace into Elasticsearch: backfill plus live events for new, edited and deleted messages.
- **Search** mode: keyword results filtered by what the chosen person can see.
- **Ask** mode: an LLM answers from only those permitted messages, with `[n]` citations.
- The same question compared side by side as two different people.
- Audit log per search: what was shown, and what was withheld (admin view).

---

## Contents

1. [Quick start](#quick-start)
2. [Slack setup](#1-slack-setup-skip-if-already-done) (skip if already done), including [giving teammates access](#15-giving-teammates-access-to-the-existing-workspace)
3. [Install and run](#2-install-and-run)
4. [Configure the LLM](#3-configure-the-llm-env)
5. [Demo script](#demo-script)
6. [Developer guide](#developer-guide): architecture, permission model, adding a connector
7. [Troubleshooting](#troubleshooting)

---

## Quick start

Requires **Docker**, **Node 20+**, a Slack workspace with the app installed, and an LLM API key (for Ask mode).

```bash
cp .env.example .env         # then fill it in (sections 1 and 3)
docker compose up -d         # Elasticsearch on :9200
npm install
npm run seed:slack           # first time only: demo channels, members and messages in Slack
npm run backfill             # Slack history → Elasticsearch
npm run dev                  # http://localhost:3000
```

---

## 1. Slack setup (skip if already done)

Skip this section if your workspace already has the **Internal Brain** app installed and `.env` has `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

### 1.1 Create a workspace

1. Go to https://slack.com/get-started#/createnew and sign up. You become the owner.
2. Stay on the **Free** plan.

### 1.2 Create the demo people

The demo uses four personas. Each needs its own email address (separate Gmail accounts work best). Invite them from **workspace name → Invite people**, accept each invite in its own browser profile, and set each **display name**: profile picture → Profile → Edit.

| Persona | Role in the story |
|---|---|
| **Carol** (you, the owner) | Security team, sees everything |
| **Alice** | Backend engineer on the payments incident |
| **Bob** | Junior engineer, public channels only |
| **Dave** | "Contractor", only in `#vendor-support` and no private channels |

On the Free plan Dave is a full member, so like everyone he can read all *public* channels. His restriction shows on the private channels. Real guest accounts (paid plans) are limited to their own channels, and the code already handles them.

### 1.3 Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App → From a manifest** → choose your workspace.
2. Paste this manifest and click **Create**:

```yaml
display_information:
  name: Internal Brain
features:
  bot_user:
    display_name: brain
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:read
      - groups:read
      - channels:history
      - groups:history
      - channels:join
      - users:read
      - users:read.email
      - channels:manage
      - groups:write
      - chat:write
      - chat:write.customize
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - member_joined_channel
      - member_left_channel
      - channel_created
      - channel_rename
      - channel_archive
      - channel_unarchive
      - group_archive
      - group_unarchive
      - group_rename
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

3. **Basic Information → App-Level Tokens → Generate Token and Scopes**: name it `socket`, add scope `connections:write`. Copy the `xapp-…` token into `.env` as `SLACK_APP_TOKEN`.
4. **Install App → Install to Workspace → Allow**. Copy the **Bot User OAuth Token** (`xoxb-…`) into `.env` as `SLACK_BOT_TOKEN`.
5. Put the four persona emails in `.env` (`CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL`).

Socket Mode means Slack sends events over a websocket that the server opens, so **no public URL is needed**.

### 1.4 Seed the workspace

```bash
npm run seed:slack
```

This writes **only to Slack**, never to Elasticsearch, and is safe to re-run. It:

1. Finds each persona by email.
2. Creates any missing channels. The bot creates them, so it's automatically inside the private ones.
3. Adds members.
4. Posts the storyline messages (shown in Slack as e.g. "Alice APP", because the bot posts them).

| Channel | Visibility | Members |
|---|---|---|
| `#general` (may be called `#all-<workspace>`) | public | everyone |
| `#payments` | public | Carol, Alice, Bob |
| `#db-migration` | public | Carol, Alice, Bob |
| `#vendor-support` | public | Carol, Dave |
| `#payments-incident` | **private** | Carol, Alice |
| `#security` | **private** | Carol |

To read a private channel created by hand, the bot must be a member: type `/invite @brain` in it.

### 1.5 Giving teammates access to the existing workspace

Use this when the workspace is already set up and someone new (a teammate, a judge) needs access.

**Step 1: the workspace owner invites them.** Pick one:

- **Invite link:** click the workspace name (top left) → **Invite people to …** → **Copy invite link**. Send the link privately, e.g. by DM. On the Free plan it expires after 30 days, and you can turn it off from the same menu.
- **By email:** same menu → enter their email → **Send**.

They accept, sign in, and set a display name (profile picture → **Profile** → **Edit**).

**Step 2: give them channel access.**

| Channel type | How they get in |
|---|---|
| Public (`#payments`, `#db-migration`, `#vendor-support`) | They can already read them. To join: **Channels → Browse channels → Join**. |
| Private (`#payments-incident`, `#security`) | An existing member opens the channel → channel name → **Members** → **Add people**. |

Choose access according to the role you want them to play. For example, add someone only to `#payments-incident` to make them "another Alice". They appear in the app's person dropdown on the next page load, with access matching their real Slack memberships. **No code or `.env` change is needed.**

**Step 3 (developers only): access to the Slack app and its tokens.** Don't paste tokens into chat or commit them. Instead, the app owner adds them as a collaborator at https://api.slack.com/apps → **Internal Brain** → **Collaborators** → add their Slack account. They can then copy `SLACK_BOT_TOKEN` (OAuth & Permissions) and `SLACK_APP_TOKEN` (Basic Information → App-Level Tokens) into their own `.env`.

**Only run one server per Slack app at a time.** With Socket Mode, Slack sends each event to **one** of the open connections, not all of them. If two teammates run `npm run dev` with the same app token, each copy misses some messages. Take turns, run `npm run backfill` after switching, or have each developer create their own Slack app from the manifest in 1.3.

---

## 2. Install and run

### Filling in `.env`

Run `cp .env.example .env`, then fill in each variable. Never commit `.env`: it holds your tokens and keys.

**Slack**

| Variable | What it is | How to fill it in |
|---|---|---|
| `SLACK_BOT_TOKEN` | The `brain` bot's token (`xoxb-…`). Used to read channels, messages and members (backfill, permission checks, seeding). | **Owner:** api.slack.com/apps → Internal Brain → **OAuth & Permissions** → Bot User OAuth Token. **Teammates:** use the **same token as the owner**, sent to you privately. That bot is already in the private channels, so your backfill gets them too. |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`). Opens the Socket Mode connection that receives live events. | **Owner:** Basic Information → **App-Level Tokens** (scope `connections:write`). **Teammates:** leave the placeholder; it's only used when `SLACK_SYNC=on`. |
| `SLACK_SYNC` | Whether this server listens for live Slack events. | **Owner:** `on`. **Teammates:** `off` (the default). Slack delivers each live event to only one connected server, so only one person may have it on. With `off`, run `npm run backfill` to get the latest messages. |

**Demo personas** (only used by `npm run seed:slack`)

| Variable | What it is | How to fill it in |
|---|---|---|
| `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL` | The email each persona used to join the Slack workspace. The seed script uses them to find each person and add them to channels. | **Owner:** the four emails from section 1.2. **Teammates:** leave the placeholders; you don't run the seed script. |

**Elasticsearch and server**

| Variable | What it is | How to fill it in |
|---|---|---|
| `ES_URL` | Where Elasticsearch runs. | Keep `http://localhost:9200` (started by `docker compose up -d`). |
| `ES_INDEX` | Name of the index holding the messages. | Keep `brain`. |
| `PORT` | Port for the web UI and API. | Keep `3000`, or change it if 3000 is taken. |
| `CAPTURE_EVENTS` | `1` saves every raw Slack event to `fixtures/captured/`, for writing tests. | Keep `0` unless you're writing tests. |

**LLM** (for Ask mode; see [section 3](#3-configure-the-llm-env) for each provider's values)

| Variable | What it is | How to fill it in |
|---|---|---|
| `LLM_BASE_URL` | The provider's OpenAI-compatible API address, ending in `/v1`. | e.g. `https://tokenhub-intl.tencentcloudmaas.com/v1` for Tencent TokenHub. |
| `LLM_MODEL` | Model ID at that provider. | e.g. `hy4-preview`. The model must be activated in the provider's console. |
| `LLM_API_KEY` | Your API key for that provider. | Create it in the provider's console (TokenHub: console.tencentcloud.com/tokenhub → API Key). Each person can use their own key. Leave empty for a local model. |
| `LLM_EXTRA_BODY` | Optional JSON added to every LLM request, for provider-specific options. | For TokenHub `hy4-preview`, use `{"thinking":{"type":"disabled"}}` for about 5s answers instead of about 60s. Otherwise leave empty. |

After changing `.env`, restart the server. It only reads `.env` at start-up.

```bash
docker compose up -d     # Elasticsearch 8 on http://localhost:9200 (security off, local only)
npm install
npm run backfill         # rebuild the index from Slack history
npm run verify           # optional: check the index matches Slack
npm run dev              # API + UI + live Slack sync on http://localhost:3000
```

After this, **new, edited and deleted Slack messages are indexed automatically** within about a second while the server runs. Events that happen while the server is **off** are not replayed by Slack; run `npm run backfill` to catch up.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Server with auto-reload (API, UI, live Slack sync) |
| `npm start` | Same, without auto-reload |
| `npm run seed:slack` | Create demo channels, members and messages **in Slack** |
| `npm run backfill` | Wipe the index and reload all Slack history |
| `npm run verify` | Per channel: messages in Slack vs Elasticsearch, plus label correctness. Exits 1 on mismatch |
| `npm test` | Unit tests (permission labels, message handling) |
| `npm run typecheck` | TypeScript check |

### Sharing the demo (optional)

To let others reach your local demo, put it behind a password with ngrok (password: 8+ characters):

```bash
ngrok http 3000 --basic-auth "user:long-password"
```

There's no login in the app itself. Anyone with the link can pick any persona, including Carol, so always use a password.

---

## 3. Configure the LLM (`.env`)

Ask mode calls any **OpenAI-compatible** `/chat/completions` API. Set these in `.env`:

| Variable | Meaning |
|---|---|
| `LLM_BASE_URL` | API base, ending in `/v1` |
| `LLM_MODEL` | Model ID at that provider |
| `LLM_API_KEY` | API key (leave empty for local models) |
| `LLM_EXTRA_BODY` | Optional JSON merged into every request, for provider-specific options |

Restart the server after changing `.env` (`npm run dev` does **not** reload `.env`).

### Provider examples

**Tencent Cloud international: TokenHub (recommended for the hackathon)**
```
LLM_BASE_URL=https://tokenhub-intl.tencentcloudmaas.com/v1
LLM_MODEL=hy4-preview
LLM_API_KEY=sk-...
LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}
```
- Create the key at https://console.tencentcloud.com/tokenhub. It starts with `sk-`. Your account's SecretId/SecretKey will **not** work.
- **Activate the model first** (Model Gallery → free trial / activate). Until then every call fails with `401006 … service ID does not exist`.
- `hy4-preview` "thinks" before answering. Turning it off with `LLM_EXTRA_BODY` makes answers take about 5 seconds instead of about 60, and stops empty answers.

**Tencent Cloud China site: Hunyuan**
```
LLM_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1
LLM_MODEL=hunyuan-turbos-latest
LLM_API_KEY=sk-...        # from console.cloud.tencent.com/hunyuan
```

**OpenRouter** (one key, many providers)
```
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=openai/gpt-4o-mini     # any ID from openrouter.ai/models
LLM_API_KEY=sk-or-...
```

**OpenAI**
```
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...
```

**Local model (Ollama)**, no key and data stays on your machine
```
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1
LLM_API_KEY=
```

The key must match the provider in `LLM_BASE_URL`. A 401 error naming a different provider's console means the key is from another provider.

The UI's status line shows the connected model, or a reminder if none is set.

---

## Demo script

| # | Do | Expect |
|---|---|---|
| 1 | **Ask**, Alice vs Bob: `What caused the payment outage?` | Alice gets the root cause citing 🔒 `#payments-incident`. Bob gets "I don't have information on that" plus only public hints. |
| 2 | **Ask**, Bob vs Carol: `Tell me about the breach report` | Bob: no information, and nothing reveals the report exists. Carol: the `#security` report. |
| 3 | **Search** as Dave: `root cause`, then `breach` | "No results found" for both (private channels) |
| 4 | Post `DB migration resumed` in `#db-migration` from Bob's Slack, then search `resumed` | Appears within seconds (the status bar shows the event) |
| 5 | Remove Alice from `#payments-incident` in Slack, then Alice asks again | Root cause is gone. Add her back and it returns. |
| 6 | Delete a message in Slack | It disappears from results |
| 7 | Scroll to the audit log | Each search or question: keywords, answer, messages shown and withheld |

---

## Developer guide

### Architecture

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

### Files

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

### Document shape

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

### Permission model

A principal is a string for one way of getting access. A user may see a document if **any** principal in the document's label is in the user's principal list.

| Slack | Label on a message | User's principals |
|---|---|---|
| Public channel | `slack:ws:<team>:member`, `slack:channel:<id>` | `slack:ws:<team>:member` (full members only) |
| Private channel | `slack:channel:<id>` | `slack:channel:<id>` for each channel they're in |
| Guest | | Only their own channels' principals |

Namespace every principal by source (`slack:`, `gmail:`, `jira:`…), so labels from different sources can never collide.

### Adding a connector (e.g. Gmail, Jira)

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

**Wiring a new connector in:**

1. Put source-specific code in its own files (today's Slack files, or a future `src/connectors/<source>/`).
2. Write documents through `indexer.ts` into the same index. Don't create a second index or bypass the labels.
3. Combine principals from all sources for the user (union), keyed by the login email.
4. Extend the live re-check in `retrieve()` for the new `source`.
5. Add its events or webhooks to the server start-up.
6. Don't add anything that sends unfiltered content to the LLM or the UI. `retrieve()` is the only way in.

### Towards the full product

- **Real login.** Replace the persona dropdown with SSO (e.g. Google). The backend must take identity from the login session, never from the request body.
- **Identity map.** Store login email → `{ slack, atlassian, google }` IDs once and reuse it.
- **Semantic search.** Add a `dense_vector` field and a `knn` clause with the **same** permission `filter` inside it. Never use `post_filter` for security.
- **Tamper-evident audit.** Persist the log in a hash chain (each entry stores the previous entry's hash) with a verify endpoint. The current log is in memory only.
- **Agentic Ask.** Let the LLM call a `search(query)` tool several times. The server always runs it as the logged-in user.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing script: "seed:slack"` | You're not in the project folder. `cd` into it first. |
| `npm install` fails with `EACCES … root-owned files` | `sudo chown -R $(id -u):$(id -g) ~/.npm`, then `npm install` without `sudo`. |
| `No Slack user with email …` | That persona hasn't accepted the invite, or the email in `.env` differs. |
| Private-channel messages missing | The bot isn't in the channel. `/invite @brain`, then `npm run backfill`. |
| Messages posted while the server was off are missing | `npm run backfill`, then `npm run verify`. |
| LLM `401 Incorrect API key` naming another provider | The key doesn't match `LLM_BASE_URL`. |
| TokenHub `401006 service ID does not exist` | Activate the model in the TokenHub console. |
| Ask is very slow or returns empty answers | Set `LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` (TokenHub hy4). |
| Changed `.env` but nothing changed | Restart the server. `.env` is only read at start-up. |

### Demo-only shortcuts (not production)

- "Who am I" is picked in the UI, with no authentication.
- The audit log is in memory and not tamper-evident.
- Elasticsearch runs without security on localhost.
