# Documentation

Start with the question you need to answer. Setup instructions describe how to connect a platform; connector references explain why its permissions and updates work that way.

| Task | Read |
| --- | --- |
| Understand the demo in two minutes | [Story and personas](demo/story-and-personas.md) |
| Present to the judges | [Demo script](demo/script.md) |
| Test and restore the demo | [Audit test plan](demo/audit-test-plan.md) |
| Understand audit mechanisms and remaining gaps | [Audit trail and recovery](reference/audit-trail.md) |
| Run a configured demo | [Quick start](../README.md#run-an-already-configured-demo) |
| Set up a platform | [Slack](setup/slack.md), [Drive](setup/drive.md), [Jira](setup/jira.md), [Confluence](setup/confluence.md), [Gmail status](setup/gmail.md) |
| Understand platform permissions, updates and audit timing | [Slack](reference/connectors/slack.md), [Drive](reference/connectors/drive.md), [Jira](reference/connectors/jira.md), [Confluence](reference/connectors/confluence.md), [Gmail proposal](reference/connectors/gmail.md) |
| Understand shared search and answers | [Architecture](reference/architecture.md), [permission-aware retrieval](reference/permissions-and-sync.md) |
| Find commands and reset effects | [Command reference](reference/commands.md) |
| Inspect seeded data | [Slack and Drive](demo/data/slack-and-drive.md), [Jira](demo/data/jira.md), [Confluence](demo/data/confluence.md) |
| See proposed future work | [Retrieval roadmap](roadmap/retrieval.md) |

## Where information belongs

- **Setup:** accounts, credentials, configuration, first import and verification. Every platform follows the same section order.
- **Connector reference:** permission structure, indexing, live checks, update strategy, design decisions, platform audit records and limitations.
- **Shared reference:** architecture and permission-aware retrieval without repeating platform rules.
- **Demo:** story, judge-facing questions, data reference, tests and restoration.
- **Roadmap:** proposals only. Gmail is not an implemented capability.

The seed modules define what the scripts create. Demo data references summarize those modules; they do not prescribe the current state of a manually edited live site. Update the relevant demo guide when changing seed content.
