# HMA Brain

HMA Brain answers questions across Slack, Google Drive, Jira and Confluence using information the person asking is allowed to read. Answers cite their sources. An admin can inspect a tamper-evident audit trail of searches and detected changes.

The four connectors are implemented and available when configured. Gmail is a proposed extension, not part of the working demo.

## Start here

- **Judges:** read the [demo story](docs/demo/story-and-personas.md), then follow the [demo script](docs/demo/script.md).
- **Run the app:** use the quick start below and the relevant platform setup guide.
- **Test access and logging:** follow the [audit test plan](docs/demo/audit-test-plan.md), including restoration steps.
- **Understand the design:** read [architecture](docs/reference/architecture.md) and [permission-aware retrieval](docs/reference/permissions-and-sync.md).
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

## Development checks

```bash
npm run typecheck
npm test
```

This is a demo, not a production deployment. It supports impersonation, stores test credentials locally and uses a shared admin password. Keep credentials out of Git. See [architecture and limits](docs/reference/architecture.md).
