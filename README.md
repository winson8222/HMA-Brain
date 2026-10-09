# HMA Brain: permission-aware enterprise knowledge (Slack connector)

HMA Brain answers questions over company data while respecting each source's own access rules. A person only ever gets answers built from content they can see in the source system, and every search is recorded for audit.

This repo contains the first connector, **Slack**, plus the shared search, Q&A and UI layers. A **Google Drive** connector (backfill + change polling into the `brain-drive` index) has its own Search/Ask page at `/drive.html`, with a live permission re-check and a tamper-evident audit log; see [docs/drive-setup.md](docs/drive-setup.md). A **Jira** connector indexes Jira Cloud issues into `brain-jira` and enforces Jira's own permissions (project access, issue security levels, picker-field grants), with each person linking their own Atlassian account through **Connect Jira**; see [Jira connector](#4-jira-connector-optional). More connectors (Gmail, Confluence) and a fuller UI will follow. The [developer guide](docs/developer-guide.md) explains how they fit in.

**What works today**

- Syncs **several Slack workspaces** into Elasticsearch: channels, and people's **DMs and group DMs** (read with their permission via **Connect**). Backfill plus live events for new, edited and deleted messages.
- One person across workspaces, linked by email: they see the **union** of what they can access, and people outside a workspace see **nothing** from it.
- **Search** mode: keyword results filtered by what the person can see.
- **Ask** mode: an LLM answers from only those permitted messages, with `[n]` citations.
- **Demo** mode (act as anyone, side by side) and **Me** mode (you are whoever signed in via Connect).
- Audit log per search: what was shown, and what was withheld (admin view; withheld DMs are redacted).
- **Jira** (optional): issues and comments from chosen projects, searchable next to Slack and Drive. Who can see what follows Jira exactly: permission schemes, project roles, groups, reporter, assignee, picker fields and issue security levels, re-checked live with Jira on every search.

---

## Contents

1. [Quick start](#quick-start)
2. [Slack setup](docs/slack-setup.md) (skip if already done), including [teammates joining](docs/slack-setup.md#8-teammates-joining-an-existing-setup)
3. [Install and run](#2-install-and-run)
4. [Configure the LLM](#3-configure-the-llm-env)
5. [Jira connector](#4-jira-connector-optional) (optional), with the full [Jira demo setup guide](docs/jira-mock-data-plan.md)
6. [Confluence connector](#5-confluence-connector-optional) (optional): same site and crawler as Jira
7. [Demo script](#demo-script)
8. [Developer guide](docs/developer-guide.md): architecture, permission model, adding a connector
9. [Troubleshooting](#troubleshooting)

---

## Quick start

Requires **Docker**, **Node 20+**, the Slack workspaces and apps from [Slack setup](docs/slack-setup.md), and an LLM API key (for Ask mode).

```bash
cp .env.example .env                              # then fill it in (section 2)
cp slack-tokens.example.json slack-tokens.json    # Slack tokens per workspace (Slack setup, step 5)
docker compose up -d                              # Elasticsearch on :9200
npm install
npm run seed:slack      # first time only: demo channels and messages in Slack
npm run dev             # http://localhost:3000; personas then connect at /connect
npm run seed:slack      # again, after personas connect: posts the demo DMs
npm run backfill        # Slack history (channels + connected people's DMs) → Elasticsearch
```

---

## 1. Slack setup (skip if already done)

The full walkthrough is in **[docs/slack-setup.md](docs/slack-setup.md)**: both workspaces, the demo people, one Slack app per workspace, `slack-tokens.json`, seeding, and connecting the personas for their DMs.

- **Connector owner, first time:** follow all of it.
- **Upgrading from the single-workspace setup:** update your existing app's manifest (step 4), then continue from step 3 for workspace B.
- **Teammates joining an existing setup:** you only need [step 8](docs/slack-setup.md#8-teammates-joining-an-existing-setup).

---

## 2. Install and run

### Filling in `.env`

Run `cp .env.example .env`, then fill in each variable. Never commit `.env`: it holds your tokens and keys.

**Slack tokens are not in `.env`.** They're in `slack-tokens.json` (one entry per workspace, plus the tokens people grant through Connect). See [Slack setup step 5](docs/slack-setup.md#5-fill-in-slack-tokensjson). Teammates get this file from the connector owner, privately.

**Slack sync**

| Variable | What it is | How to fill it in |
|---|---|---|
| `SLACK_SYNC` | Whether this server listens for live Slack events (all workspaces). | **Owner:** `on`. **Teammates:** `off` (the default). Slack delivers each live event to only one connected server, so only one person may have it on. With `off`, run `npm run backfill` to get the latest messages. |

**Web app and sign-in**

| Variable | What it is | How to fill it in |
|---|---|---|
| `PUBLIC_URL` | The address people use to reach the app. Slack sends people back here after they approve Connect. | `http://localhost:3000` on your laptop, your ngrok address when sharing, or your hosted domain. That address + `/slack/oauth/callback` must be in each Slack app's `redirect_urls` ([details](docs/slack-setup.md#where-connect-returns-to)). |
| `ALLOW_IMPERSONATION` | `on`: the UI can act as anyone (**Demo** mode and the side-by-side compare). `off`: only **Me**, the signed-in person. | `on` for demos with your team. `off` for anything shared more widely. |
| `SESSION_SECRET` | Secret that signs the login cookie, so nobody can fake being someone else. | Any long random string: `openssl rand -hex 32`. Keep it private. If empty, a random one is used and everyone is signed out whenever the server restarts. |

**Demo personas** (only used by `npm run seed:slack`)

| Variable | What it is | How to fill it in |
|---|---|---|
| `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL` | The email each persona uses in the Slack workspaces (the same one in both). The seed script uses them to find each person, add them to channels and post their DMs. | **Owner:** the four emails from [Slack setup step 2](docs/slack-setup.md#2-create-the-demo-people). **Teammates:** leave as is; you don't run the seed script. |

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

After this, with `SLACK_SYNC=on`, **new, edited and deleted Slack messages and DMs are indexed automatically** within about a second while the server runs. Events that happen while the server is **off** are not replayed by Slack; run `npm run backfill` to catch up.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Server with auto-reload (API, UI, live Slack sync) |
| `npm start` | Same, without auto-reload |
| `npm run seed:slack` | Create demo channels, members and messages **in Slack**, in every workspace, plus DMs as connected personas |
| `npm run backfill` | Wipe the index and reload all Slack history: every workspace's channels, and connected people's DMs |
| `npm run verify` | Per channel and DM: messages in Slack vs Elasticsearch, plus label correctness. Exits 1 on mismatch |
| `npm run drive:connect` | One time: sign in as the Drive admin and save the token ([Drive setup](docs/drive-setup.md)) |
| `npm run seed:drive` | Create the demo "Company A" folder **in Drive**: 19 files, 8 formats (`-- --edit-runbook`, `--close-vendor-access`, `--reset`: see docs/drive-setup.md) |
| `npm run seed:story` | Build the whole demo story: the Drive folder plus every Slack message and DM (`-- --dry-run` to preview): see docs/demo-data.md |
| `npm run drive:backfill` | Index everything under the Drive folder; unchanged files are skipped (`-- --reset` rebuilds the Drive indexes only) |
| `npm run drive:poll` | Apply Drive changes since the last run (`-- --watch` to keep polling) |
| `npm run drive:verify` | Drive vs Elasticsearch: files, labels, content. Exits 1 on mismatch |
| `npm run drive:ask` | Ask or search Drive as a persona from the terminal (`-- --as bob "question"`, add `--search`) |
| `npm run drive:doctor` | Check the whole Drive setup and list what's left to do |
| `npm run seed:jira` | Create the Jira demo **in Jira** (people, groups, PAY/SEC/VEND projects, permission and security schemes, 14 issues). Safe to re-run ([Jira demo setup](docs/jira-mock-data-plan.md)) |
| `npm run jira:backfill` | Index every issue in the Jira projects; unchanged issues are skipped (`-- --reset` rebuilds the Jira indexes only) |
| `npm run jira:poll` | Apply Jira changes (issues and permissions) since the last run (`-- --watch` to keep polling) |
| `npm run jira:doctor` | Check the Jira setup: crawler token, Administer Jira, each project's permissions, Connect Jira, who has linked |
| `npm run audit:log` | Query the audit log (`-- --user bob`, `--doc <file id>`, `--denied`, `--since <date>`) |
| `npm run audit:verify` | Recompute the audit hash chain. Exits 1 if any record was changed |
| `npm test` | Unit tests (permission labels, workspaces, DMs, message handling, signed cookies, Drive mapping and queries, audit chain) |
| `npm run typecheck` | TypeScript check |

### Sharing the demo (optional)

To let others reach your local demo, put it behind a password with ngrok (password: 8+ characters):

```bash
ngrok http 3000 --basic-auth "user:long-password"
```

With `ALLOW_IMPERSONATION=on`, anyone with the link can act as any persona, including Carol, so always use a password, or set it to `off` so visitors can only ask as themselves after connecting. For Connect to work through ngrok, set `PUBLIC_URL` to the ngrok address and add its callback to both Slack apps ([details](docs/slack-setup.md#where-connect-returns-to)). For Connect Jira, also add `<ngrok address>/connect/jira/callback` to the Atlassian OAuth app. Use an ngrok **static domain**, so the callbacks never have to change again.

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

### Optional: hybrid search, rerank and tracing

All three are off until their variables are set in `.env` (see `.env.example` for the full list), and each degrades gracefully on its own:

| Feature | Variables | What you get |
|---|---|---|
| **Hybrid search** | `EMBEDDING_MODEL`, `EMBEDDING_DIMS` (+ optional `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY`; default to the LLM's) | BM25 + vector search fused with reciprocal rank fusion. Semantic paraphrases now match. Setting `EMBEDDING_DIMS` (first time or changed) requires `npm run backfill`. |
| **Rerank** | `COHERE_API_KEY` ([free Trial key](https://dashboard.cohere.com/api-keys)), optional `COHERE_MODEL` | The fused candidates are reranked by Cohere; on error the pre-rerank order is kept. |
| **Tracing** | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Per-query waterfall in [Langfuse](https://cloud.langfuse.com): embed → search legs → fuse → re-check → rerank → LLM, with latencies and token usage. |

`RETRIEVAL_MODE=lexical|hybrid` and `RERANK=on|off` force either behavior; by default hybrid turns on when the embedding variables are set, and rerank when the Cohere key is set. `MULTI_QUERY=1-5` (or `on`) additionally rephrases the question N ways and runs a semantic search per phrasing before fusing — one extra LLM call per query. The status endpoint shows what's active.

---

## 4. Jira connector (optional)

Jira loads only when `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are set. Without them, everything else works as before.

**The full walkthrough, verified on a real site, is [docs/jira-mock-data-plan.md](docs/jira-mock-data-plan.md).** It covers the scenario, every screen, the data, the who-sees-what matrix and troubleshooting. This section is the short version.

### How it connects

| Connection | What it does | Configured by |
|---|---|---|
| **Crawler** (HMA Brain's server ↔ your Jira site) | Copies issues into `brain-jira`, reads each project's permissions, and re-checks every search result live with Jira as the asker | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`: a dedicated, normal Atlassian account with Jira admin |
| **Connect Jira** (each person ↔ their own Atlassian account) | The person signs in to Atlassian once; HMA Brain stores only *person → Atlassian account ID*, so their Jira results follow their Jira permissions | `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`: one OAuth app, created once |

Someone who hasn't clicked Connect Jira gets nothing from Jira (their Slack and Drive results are unaffected).

### `.env`

| Variable | What it is | How to fill it in |
|---|---|---|
| `JIRA_BASE_URL` | Your Jira Cloud site | e.g. `https://hma-brain-demo.atlassian.net` |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | The **crawler** account and its classic API token | A dedicated address (not a persona). Token: id.atlassian.com → Security → **Create API token** (not "with scopes") |
| `JIRA_PROJECTS` | Project keys to index | `PAY,SEC,VEND` for the demo. Keeps onboarding projects (KAN, SAM1) out |
| `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET` | The Connect Jira OAuth app | From the developer console (below) |
| `JIRA_SYNC` | Poll Jira every `JIRA_POLL_SECONDS` (60) for edited issues and permission changes | `on` while demoing. Several servers can have it on |
| `JIRA_ADMIN_EMAIL`, `JIRA_ADMIN_API_TOKEN` | A site admin's (Carol's) classic token | **Only for `npm run seed:jira`**; the app never uses it |
| `ALICE_JIRA_API_TOKEN`, `BOB_JIRA_API_TOKEN`, `DAVE_JIRA_API_TOKEN` | Optional persona tokens | Only so seeded comments are posted as their real authors. Set them before the seed run that creates the issues |

The demo personas reuse `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL` and `DAVE_EMAIL`; there are no separate Jira emails.

### Setup in order

1. **Site and trial, as Carol only.** In a private window, sign up for Jira with `CAROL_EMAIL`, name the site (e.g. `hma-brain-demo`) and start the **Standard or Premium trial**. The Free plan has no permission schemes or security levels. Nobody else signs up: whoever signs up first owns the site, and "Get it free" from another account creates a separate empty site.
2. **Tokens and `.env`.** Carol's classic token goes in `JIRA_ADMIN_*`. Set `JIRA_BASE_URL`, `JIRA_EMAIL` (the crawler's address) and `JIRA_PROJECTS`.
3. **`npm run seed:jira`.** The first run invites Alice, Bob, Dave and the crawler, then stops. Each accepts the invite email with that exact address.
4. **Crawler token.** Signed in as the crawler, create its classic token and set `JIRA_API_TOKEN`. Optionally add the persona tokens too.
5. **`npm run seed:jira` again.** It builds everything: groups, PAY/SEC/VEND, Task/Bug work types, the Approvers and Owning team fields, permission and security schemes, and the 15 issues with comments. After `seedData.ts` changes, run **`npm run seed:jira -- --update`** instead: a plain run leaves existing issues alone, and `--update` rewrites their fields, security level, status and comments. Never delete an issue to redo it: Jira doesn't reuse issue numbers, so its key is gone for good.
6. **Make the crawler a Jira admin.** admin.atlassian.com → Directory → Users → the crawler → **Apps** → Jira → Roles: tick **User** and **User access admin**. The Global permissions page in Jira doesn't offer "Administer Jira" any more.
7. **Connect Jira OAuth app, created once.** developer.atlassian.com/console/myapps, preferably as the crawler → **Create** → **OAuth 2.0 integration**. Then:
   - **Permissions:** User identity API (`read:me`), at account level.
   - **Authorization:** callback `http://localhost:3000/connect/jira/callback`, which must match `PUBLIC_URL` + `/connect/jira/callback`.
   - **Distribution:** **Enable sharing**, so everyone can connect, not just the owner.
   - **Settings:** copy the client ID and secret into `.env`.
8. **Check and index:**
   ```bash
   npm run jira:doctor      # every line ok, then "nobody has connected Jira yet"
   npm run jira:backfill    # 15 issues; right after seeding, Jira's search can lag, so re-run after a minute if it finds fewer
   ```
9. **Start the app and link each persona.** Start with `npm run dev`, or `SLACK_SYNC=off npm run dev` if Slack's live connection hangs. Then, for each of Alice, Bob, Carol and Dave:
   - In their own browser profile, open `http://localhost:3000/connect.html` (localhost, not 127.0.0.1).
   - Connect Slack, then **Connect Jira**.
   - On Atlassian's screen, choose the demo site under "Install app on", check the account is that persona's, and click **Accept**.
   - Confirm the page shows **"Linked to <name>"**.

### Checking it (signed in as Alice, Jira only)

Tick only **Jira** in the sources so Slack and Drive don't blur the test.

| Ask | Alice should get |
|---|---|
| `What's the status of the connection pool fix?` | PAY-240 (her team's project) |
| `What do I need to prepare for the vendor timeline?` | VEND-4 (she's the assignee) |
| `How much is the contract penalty from the outage?` | Nothing. PAY-243 is security level "Leadership only". Carol gets it. |
| `Was an API key leaked?` | Nothing. SEC is the security team's. |
| `Is anything waiting on my approval?` | Nothing. Only Bob, named in VEND-5's Approvers field. |

The audit log lists each withheld issue as **denied** (title only) or **dropped** by the live check.

---


## 5. Confluence connector (optional)

Confluence sits on the **same Atlassian site as Jira** and uses the same crawler account and API token, so after the Jira setup it needs only this in `.env`:

```
CONFLUENCE_SYNC=on          # or off: either value enables the connector
CONFLUENCE_SPACES=ENG,SEC   # optional; empty = every space the crawler can view
```

Site setup (Carol): add Confluence to the site and start the **Premium trial** from Settings → Billing (the Free plan has no space or page permissions). Give the crawler Confluence access, **View on every space**, a place in **every page view restriction** (admins don't bypass restrictions), and the **Confluence Administrator** global permission (the live re-check asks Confluence whether the asker can read each page). People link their Atlassian account once with **Connect Jira**; the same link serves Confluence.

```bash
npm run confluence:doctor     # token, spaces and their View grants, admin permission, who's linked
npm run confluence:backfill   # index every in-scope space (--reset rebuilds brain-confluence only)
npm run confluence:poll       # pages and permissions changed since the last run (--watch, or --sweep for the reconcile)
npm run seed:confluence       # demo spaces and pages as Carol (docs/confluence-demo-content.md); --dry-run first
```

How it works, labels, sync and the demo data: [docs/confluence-connector-plan.md](docs/confluence-connector-plan.md).

## Demo script

Use **Demo** mode with the compare view for 1–6, and **Me** mode for 7.

| # | Do | Expect |
|---|---|---|
| 1 | **Ask**, Carol vs Alice: `What do we know about the payment outage?` | **Union:** Carol's answer draws on both workspaces (Acme's follow-up in `#acme-support`) and her DMs. **Isolation:** Alice gets workspace A and her own DMs, nothing from the Vendors workspace. |
| 2 | **Ask**, Alice vs Bob: `What caused the payment outage?` | Alice gets the root cause from 🔒 `#payments-incident` and her DM with Carol. Bob gets "I don't have information on that" plus only public hints and the group DM he's in. |
| 3 | **Search**, Bob vs Carol: `migration flag` | Carol sees the Alice ↔ Carol DM; Bob, who isn't in it, gets nothing from it. |
| 4 | **Search** as Dave: `outage`, then `vulnerability` | Dave sees `#acme-support`, the postmortem and his DM with Carol, but never 🔒 `#payments-incident` or the Security folder. |
| 5 | Remove Alice from `#payments-incident` in Slack, then Alice asks again | Root cause from the channel is gone. Add her back and it returns. |
| 6 | Post a new DM or channel message in Slack (with `SLACK_SYNC=on`) | Appears within seconds (the status bar shows the event) |
| 7 | Switch to **Me** in a persona's signed-in browser and ask | Answers as that person only. On `/connect`, **Disconnect** removes their DMs unless another participant is still connected. |
| 8 | Scroll to the audit log | Each search: keywords, answer, messages shown and withheld. Withheld DMs appear as `DM: … (withheld)` with no text. |

---

## Developer guide

Architecture, the permission model, the file map, and **what a new connector (Gmail, Jira, …) must provide** are in **[docs/developer-guide.md](docs/developer-guide.md)**.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing script: "seed:slack"` | You're not in the project folder. `cd` into it first. |
| `npm install` fails with `EACCES … root-owned files` | `sudo chown -R $(id -u):$(id -g) ~/.npm`, then `npm install` without `sudo`. |
| `No Slack user with email …` | That persona hasn't accepted the invite to that workspace, or the email in `.env` differs. |
| Connect page says "Not set up for Connect" | Add `clientId` and `clientSecret` for that workspace in `slack-tokens.json`, then restart. |
| Slack says `redirect_uri did not match` | `PUBLIC_URL` + `/slack/oauth/callback` isn't in that app's `redirect_urls`. Add it in the App Manifest. |
| DMs missing from answers | Nobody in that DM has connected. Connect one participant at `/connect`, then `npm run backfill`. |
| `seed:slack` says some DMs weren't seeded | The sender hasn't connected that workspace yet. Connect them, then run it again. |
| Private-channel messages missing | The bot isn't in the channel. `/invite @brain`, then `npm run backfill`. |
| Messages posted while the server was off are missing | `npm run backfill`, then `npm run verify`. |
| LLM `401 Incorrect API key` naming another provider | The key doesn't match `LLM_BASE_URL`. |
| TokenHub `401006 service ID does not exist` | Activate the model in the TokenHub console. |
| Ask is very slow or returns empty answers | Set `LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` (TokenHub hy4). |
| Changed `.env` but nothing changed | Restart the server. `.env` is only read at start-up. |
| No Jira results for someone | They haven't clicked **Connect Jira**, or their account has no access to those projects. `npm run jira:doctor` lists who's linked. More in the [Jira guide's troubleshooting](docs/jira-mock-data-plan.md#8-verification-checklist-and-troubleshooting). |
| `npm run dev` hangs on `A pong wasn't received from the server` | Slack's live connection can't connect, and the server waits for it. Run `SLACK_SYNC=off npm run dev`. |

### Demo-only shortcuts (not production)

- With `ALLOW_IMPERSONATION=on`, the UI can act as anyone (Me mode is the real sign-in, via Slack).
- Tokens are stored in a JSON file instead of an encrypted database.
- The Slack page's audit log is in memory and not tamper-evident. (Drive's is, in `brain-audit`.)
- Elasticsearch runs without security on localhost.
