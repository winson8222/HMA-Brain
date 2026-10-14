# Aspire Atlas

Ask one question across Slack, Google Drive, Jira and Confluence and get a cited answer built only from what you are allowed to see.

Company knowledge is scattered across tools, and each tool has its own idea of who may read what. Aspire Atlas searches all of them at once, keeps every platform's own access rules, checks them again at the moment you ask, and records each answer in a tamper-evident audit trail.

## What it does

- **One question, four sources.** Slack messages, Drive files, Jira issues and Confluence pages are searched together and merged into one answer with citations.
- **Your permissions, not the bot's.** Channel membership, file sharing, issue security and page restrictions are enforced in code before anything reaches the model. Access revoked a minute ago is caught at question time.
- **Nothing leaks.** If you cannot see something, the answer does not hint that it exists.
- **Fresh.** Live events and short polling keep the index within minutes of the source.
- **Audited.** Who asked, what was shown or withheld, and the answer are written to a signed, hash-linked log that an admin can query and verify.

## Screenshots

<!-- Drop images into screenshots/ and update the paths below. -->

| Ask | Audit trail |
| --- | --- |
| ![Ask: a cited answer](screenshots/ask.png) | ![Audit: per-document decisions and chain verification](screenshots/audit.png) |

## Architecture

![Aspire Atlas architecture](docs/reference/architecture.svg)

Details, trust boundaries and design decisions: [docs/reference/architecture.md](docs/reference/architecture.md).

## Run it

```bash
docker compose up -d        # Elasticsearch 8
npm install
npm run audit:log -- checkpoint --trust-current-head   # once, before the first run
npm run dev
```

Open `http://localhost:3000`. Each source needs credentials in `.env` (see `.env.example`) and a one-time setup: [Slack](docs/setup/slack.md), [Google Drive](docs/setup/drive.md), [Jira](docs/setup/jira.md), [Confluence](docs/setup/confluence.md). The full documentation index is at [docs/README.md](docs/README.md).

Built with Node.js, TypeScript, Express, Elasticsearch 8 and Tencent Cloud TokenHub. This is a demo build, not a production deployment.

## License

[MIT](LICENSE)
