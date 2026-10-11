# Local development

## Install

Use Node.js compatible with the installed dependencies and Docker Compose. Run from the repository root:

```bash
npm install
cp .env.example .env
cp slack-tokens.example.json slack-tokens.json
docker compose up -d
```

Copy example files only for a new setup; preserve existing credentials. The local Elasticsearch service listens on port 9200. Tokens, `.env` and `.secrets/` stay outside Git.

## Configure the app

| Setting | Purpose |
| --- | --- |
| `ES_URL`, `PORT` | Default local service addresses: Elasticsearch 9200, app 3000 |
| `PUBLIC_URL` | Browser address used in OAuth callbacks, normally `http://localhost:3000` |
| `SESSION_SECRET` | Stable secret for signed sessions; changing it signs people out |
| `ADMIN_TOKEN` | Password for audit access; admin features are disabled when empty |
| `ALLOW_IMPERSONATION` | `on` for controlled persona demonstrations; `off` for signed-in access only |
| `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL` | Dedicated test accounts used by the seed scripts |
| `TIME_ZONE` | Display/prompt time zone, default Asia/Singapore |

Configure an OpenAI-compatible chat endpoint through `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`. Ask needs a working model; Search can be tested without answer generation. `LLM_EXTRA_BODY` supplies optional provider-specific settings. Use the matching provider's key and a model enabled for that account.

`.env.example` lists the supported settings. Restart the server after changing `.env`.

## Connect platforms

Follow the same setup sequence for each platform: prerequisites, source accounts, credentials, linking, import, verification and troubleshooting.

- [Slack](slack.md): also provides the app's sign-in identity.
- [Drive](drive.md): one connected crawler account.
- [Jira](jira.md): crawler plus each person's Atlassian identity link.
- [Confluence](confluence.md): shares that Atlassian setup in the demo.
- [Gmail](gmail.md): proposed only.

## Start and check

```bash
npm run dev
```

Open `http://localhost:3000` and `/connect.html`. Confirm each selected source is available. Use the [demo script](../demo/script.md) after seeding; do not substitute the older `seed:slack` dataset for the story dataset.

```bash
npm run typecheck
npm test
```

## Optional retrieval and tracing

| Capability | Configuration |
| --- | --- |
| Semantic plus keyword search | `EMBEDDING_MODEL`, `EMBEDDING_DIMS`; optional embedding endpoint/key |
| Force retrieval mode | `RETRIEVAL_MODE=lexical` or `hybrid` |
| Reranking | `COHERE_API_KEY`, optional `COHERE_MODEL`; `RERANK=on` or `off` |
| Query variants | `MULTI_QUERY=1-5` or `on`; extra model work per query |
| Tracing and managed prompts | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` |

Changing vector dimensions requires rebuilding the relevant index mappings and embeddings. Source reset commands can also erase connector state and account links: read [command effects](../reference/commands.md) first. Tracing can retain queries and content; use dedicated demo data.

## Troubleshooting

- Connection refused on port 9200: check `docker compose ps` and `ES_URL`.
- OAuth callback mismatch: align `PUBLIC_URL`, the configured redirect URI and the provider's allowlist. Use one hostname consistently.
- Slack startup connection failure: temporarily use `SLACK_SYNC=off npm run dev` to test the web app without Socket Mode.
- Model authentication failure: verify the endpoint, key and enabled model belong to the same provider.
- Empty answers: inspect source cards and the source availability messages before assuming a permissions problem.
- Sharing the demo: use an authenticated tunnel or access-controlled host, update callbacks, and keep impersonation confined to test users.
