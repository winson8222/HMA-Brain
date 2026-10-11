# Architecture

HMA Brain imports source content into Elasticsearch, searches it with the asker's permissions, and gives only permitted evidence to the answer model. Each platform owns its data format, access rules and sync process.

## Request flow

1. The browser sends a question and selected sources. The server resolves the signed-in person, or the selected test persona in Demo mode.
2. The registry calls each configured connector in parallel. Each returns permitted evidence and audit decisions.
3. The shared layer combines rankings, optionally reranks permitted evidence, and returns Search results or generates an Ask answer with citations.
4. The app writes the access audit record before returning the result. An audit write failure blocks the response.

The [retrieval reference](permissions-and-sync.md) explains the access checks. Platform rules and update decisions are in [Slack](connectors/slack.md), [Drive](connectors/drive.md), [Jira](connectors/jira.md) and [Confluence](connectors/confluence.md).

## Components

| Component | Responsibility |
| --- | --- |
| `src/server.ts`, `src/http.ts`, `src/session.ts` | Routes, asker identity, signed sessions and OAuth state |
| `src/connectors/index.ts` | Registry of configured sources |
| `src/connectors/types.ts` | Shared `Evidence` returned by connectors; index documents remain platform-specific |
| `src/federated.ts` | Cross-source retrieval, ranking, answers and access audit writes |
| `src/search.ts`, `src/events.ts`, `src/sync.ts`, `src/dms.ts` | Slack retrieval and ingestion |
| `src/connectors/{drive,jira,confluence}/` | Platform clients, permissions, indexing and retrieval |
| `src/hybrid.ts`, `src/embeddings.ts`, `src/rerank.ts`, `src/multiQuery.ts` | Optional semantic retrieval and ranking |
| `src/llm.ts`, `src/askRules.ts`, `src/prompts.ts` | Model calls and answer instructions |
| `src/audit/` | Shared audit types, chain, storage, query API and CLI |
| `src/tracing.ts`, `src/judge.ts` | Optional tracing and answer evaluation |

The main UI is `public/index.html`. Account linking is `public/connect.html`; `public/drive.html` retains a separate Drive view.

## Shared audit chain

All implemented connectors write to `brain-audit` by default. Each record includes the preceding record's hash and an HMAC over its own contents. The signing key is in `.secrets/audit-key`, or supplied through `AUDIT_KEY`. Keep the key when retaining the history.

| Record | Meaning |
| --- | --- |
| Search or Ask | Person, question, selected sources, document decisions, and answer/citations for Ask |
| Permission change | A connector detected a change in indexed access, or received a supported membership event |
| Content change | An indexed item was added, updated or removed; initial imports can use summaries |
| Account | A supported account connection or disconnection |
| Admin | Audit query, chain verification or Drive Sync now |

Platform-specific triggers, timestamp meanings and gaps are in each connector reference. `changed_at` is source change time when available; `detected_at` is when the app noticed; `indexed_at` records indexing time for content events. Do not infer an exact source time from detection time.

Audit access requires `ADMIN_TOKEN`. Search records retain the query and generated answer, plus document metadata. Change records hold identifiers, titles, paths and access labels, not source bodies. An answer can contain quoted source information, so the log itself is sensitive.

`npm run audit:verify` detects altered records and broken links within the stored chain. Removing records from the end requires comparison with a previously retained head to detect. Verification writes an admin record after its check, advancing the head.

Sync/account/admin writes are best effort: failures log `AUDIT WRITE FAILED` and can leave gaps. Search and Ask writes are required before returning. An intact chain proves integrity of stored records, not completeness of event capture. Audit document lists cover selected candidates and a limited metadata query, not every match in the source.

## Limits of this demo

- Demo mode can impersonate test people. Use `ALLOW_IMPERSONATION=off` outside a controlled demo.
- Local credential files and a shared admin password are not a production identity or secrets system.
- Elasticsearch in Docker is configured for local use without authentication.
- The Drive Sync now route currently has no admin check; its audit actor can be the signed-in person or anonymous.
- The current document-title plus decision filter can match different documents in one search record. Inspect each document's decision when investigating access.
- Index labels can lag behind grants. Live checks remove stale permissions; newly granted results can require a poll or identity-cache refresh to become candidates.

Run the [audit test plan](../demo/audit-test-plan.md) to check behavior. The [roadmap](../roadmap/retrieval.md) lists future work.
