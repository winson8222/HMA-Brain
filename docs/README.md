# Documentation

| I want to | Read |
| --- | --- |
| Run the demo for a judge | [Demo script](demo/script.md) |
| Rehearse the permission, freshness and audit tests, and restore the data afterwards | [Test plan](demo/test-plan.md) |
| Know what the seed scripts created | [Demo data](demo/data.md) |
| Set up a platform | [Slack](setup/slack.md), [Google Drive](setup/drive.md), [Jira](setup/jira.md), [Confluence](setup/confluence.md) |
| Understand the design, trust boundaries and trade-offs | [Architecture](reference/architecture.md) |
| Understand how each platform's permissions and updates are handled | [Slack](reference/connectors/slack.md), [Drive](reference/connectors/drive.md), [Jira](reference/connectors/jira.md), [Confluence](reference/connectors/confluence.md) |
| Understand search, ranking and the LLM answer | [Retrieval](reference/retrieval.md) |
| Find a command or a reset's effect | [Commands](reference/commands.md) |

## Future work

- Gmail connector with per-person read-only mailbox access (designed, not built).
- Automatic verified audit backups and independently controlled checkpoint storage.
- Following references across sources with a bounded search/open loop, under the same per-person access rules.
- Query date filters, thread-context expansion and an evaluation set built from the demo questions.
- Drive shared drives and group expansion; Jira team-managed projects and restricted comments.
