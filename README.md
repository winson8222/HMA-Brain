# HMA Brain: permission-aware enterprise knowledge (Slack connector)

HMA Brain answers questions over company data while respecting each source's own access rules. A person only ever gets answers built from content they can see in the source system, and every search is recorded for audit.

This repo contains the first connector, **Slack**, plus the shared search, Q&A and UI layers. A **Google Drive** connector (backfill + change polling into the `brain-drive` index) has its own Search/Ask page at `/drive.html`, with a live permission re-check and a tamper-evident audit log; see [docs/drive-setup.md](docs/drive-setup.md). The Slack page doesn't search Drive yet. More connectors (Gmail, Jira, Confluence, Drive) and a fuller UI will follow. The [developer guide](docs/developer-guide.md) explains how they fit in.

**What works today**

- Syncs a real Slack workspace into Elasticsearch: backfill plus live events for new, edited and deleted messages.
- **Search** mode: keyword results filtered by what the chosen person can see.
- **Ask** mode: an LLM answers from only those permitted messages, with `[n]` citations.
- The same question compared side by side as two different people.
- Audit log per search: what was shown, and what was withheld (admin view).

---

## Contents

1. [Quick start](#quick-start)
2. [Slack setup](docs/slack-setup.md) (skip if already done), including [giving teammates access](docs/slack-setup.md#5-giving-teammates-access-to-the-existing-workspace)
3. [Install and run](#2-install-and-run)
4. [Configure the LLM](#3-configure-the-llm-env)
5. [Demo script](#demo-script)
6. [Developer guide](docs/developer-guide.md): architecture, permission model, adding a connector
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

The full walkthrough is in **[docs/slack-setup.md](docs/slack-setup.md)**: create the workspace, the demo people, the Slack app and its tokens, then seed the demo channels.

- **Connector owner, first time:** follow all of it.
- **Teammates joining the existing workspace:** you only need [step 5, giving teammates access](docs/slack-setup.md#5-giving-teammates-access-to-the-existing-workspace).

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
| `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL` | The email each persona used to join the Slack workspace. The seed script uses them to find each person and add them to channels. | **Owner:** the four emails from [Slack setup step 2](docs/slack-setup.md#2-create-the-demo-people). **Teammates:** leave as is; you don't run the seed script. |

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
| `npm run drive:connect` | One time: sign in as the Drive admin and save the token ([Drive setup](docs/drive-setup.md)) |
| `npm run seed:drive` | Create the demo "Company A" folder **in Drive**: 19 files, 8 formats (`-- --edit-runbook`, `--close-vendor-access`, `--reset`: see docs/drive-setup.md) |
| `npm run drive:backfill` | Index everything under the Drive folder; unchanged files are skipped (`-- --reset` rebuilds the Drive indexes only) |
| `npm run drive:poll` | Apply Drive changes since the last run (`-- --watch` to keep polling) |
| `npm run drive:verify` | Drive vs Elasticsearch: files, labels, content. Exits 1 on mismatch |
| `npm run drive:ask` | Ask or search Drive as a persona from the terminal (`-- --as bob "question"`, add `--search`) |
| `npm run drive:doctor` | Check the whole Drive setup and list what's left to do |
| `npm run audit:log` | Query the audit log (`-- --user bob`, `--doc <file id>`, `--denied`, `--since <date>`) |
| `npm run audit:verify` | Recompute the audit hash chain. Exits 1 if any record was changed |
| `npm test` | Unit tests (permission labels, message handling, Drive mapping and queries, audit chain) |
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

Architecture, the permission model, the file map, and **what a new connector (Gmail, Jira, …) must provide** are in **[docs/developer-guide.md](docs/developer-guide.md)**.

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
- The Slack page's audit log is in memory and not tamper-evident. (Drive's is, in `brain-audit`.)
- Elasticsearch runs without security on localhost.
