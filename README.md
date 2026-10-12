# HMA Brain

HMA Brain answers questions across Slack, Google Drive, Jira and Confluence using information the person asking is allowed to read. Answers cite their sources. An admin can inspect a tamper-evident audit trail of searches and detected changes.

The current demo implements federated Search and Ask across all four connectors, permission filtering with source-specific access rechecks, optional hybrid retrieval and reranking, and a shared audit trail with tamper detection and manual backup/recovery. Connectors and model features are available when configured. Gmail and automatic audit backups remain proposed work.

## Start here

- **Judges:** read the [demo story](docs/demo/story-and-personas.md), then follow the [demo script](docs/demo/script.md).
- **Run the app:** use the quick start below and the relevant platform setup guide.
- **Test access and logging:** follow the [audit test plan](docs/demo/audit-test-plan.md), including restoration steps.
- **Understand the design:** read [architecture](docs/reference/architecture.md), [permission awareness](docs/reference/permissions-and-sync.md) and [retrieval implementation](docs/reference/retrieval.md).
- **Find a command or document:** use the [command reference](docs/reference/commands.md) or [documentation index](docs/README.md).

## Run an already configured demo

```bash
docker compose up -d
npm install
npm run dev
```

Before the first run with audit checkpoints enabled, initialize the trusted audit baseline using the [audit command reference](docs/reference/commands.md#run-and-check). Search and Ask refuse new audit writes until it is initialized. Preserve the checkpoint together with the audit history and signing key when restarting or moving the demo.

Open `http://localhost:3000`. Use **Search** for a result list or **Ask** for a cited answer. **Me** uses your signed-in identity; **Demo** lets the presenter compare test personas when `ALLOW_IMPERSONATION=on`.

Each persona must connect their own accounts on `/connect.html`. Choosing a persona in Demo mode does not create an Atlassian account link. The main page supports all configured sources; `/drive.html` is an additional Drive-only interface.

## Platform guides

| Platform | Setup | Permissions, updates and audit design |
| --- | --- | --- |
| Slack | [Setup](docs/setup/slack.md) | [Connector](docs/reference/connectors/slack.md) |
| Google Drive | [Setup](docs/setup/drive.md) | [Connector](docs/reference/connectors/drive.md) |
| Jira | [Setup](docs/setup/jira.md) | [Connector](docs/reference/connectors/jira.md) |
| Confluence | [Setup](docs/setup/confluence.md) | [Connector](docs/reference/connectors/confluence.md) |
| Gmail | [Implementation status](docs/setup/gmail.md) | [Proposed design](docs/reference/connectors/gmail.md) |

## Audit trail

The admin audit trail records who searched or asked, the question, selected sources, document access decisions, and generated answers with citations. It also records supported content and permission changes, account connections and admin actions. Signed, linked records and a checkpoint kept outside Elasticsearch detect edits and missing history; Search and Ask require a successful audit write before returning. Manual verified backups and repair are implemented; automatic backups are not yet available, and some background event logging is best effort.

See the [audit trail implementation and recovery guide](docs/reference/audit-trail.md), [commands to query, verify, back up and repair the log](docs/reference/commands.md#run-and-check), and [audit test plan](docs/demo/audit-test-plan.md).

## Permission awareness

Search and Ask enforce access for the person asking: Slack workspace/channel membership and DM participants, supported Drive sharing, Jira project and issue-security permissions, and Confluence space and page restrictions. Permission filters run inside keyword and vector searches, followed by source-specific current-access checks. Only evidence that passes these checks reaches the reranker or answer model; withheld-item metadata stays in the protected admin audit. Newly granted access can take a sync or identity refresh to appear.

See the [full permission implementation guide](docs/reference/permissions-and-sync.md) for the identity-to-evidence flow, access decisions, and links to each platform's supported rules and limitations.

## Retrieval and LLM answers

Ask uses the LLM to rewrite a question into search keywords, then searches the selected connectors in parallel. All four connectors support keyword search plus optional embedding-based semantic search. The app merges rankings, optionally reranks permitted excerpts with Cohere, and asks the answer model to respond using only those excerpts with numbered citations. Optional LLM query expansion adds alternative semantic searches for Slack. Search returns ranked results without generating an answer; permission decisions are enforced in code.

See the [retrieval implementation guide](docs/reference/retrieval.md) for the complete flow, model configuration, source coverage and fallback behavior, and the [retrieval roadmap](docs/roadmap/retrieval.md) for future work.

## Development checks

```bash
npm run typecheck
npm test
```

This is a demo, not a production deployment. It supports impersonation, stores test credentials locally and uses a shared admin password. Keep credentials out of Git. See [architecture and limits](docs/reference/architecture.md).
