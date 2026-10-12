# Retrieval roadmap

These are proposals, not current demo claims. The connector registry, federated search, Drive embeddings, hybrid retrieval, reranking, multi-query retrieval and four working connectors already exist.

## Improve answer quality

- Add explicit current date/time context and query date filters for relative-time questions. Avoid presenting historical “next week” sample text as today's schedule.
- Add nearby messages and thread context when a short match needs surrounding discussion.
- Build a versioned evaluation set from the demo questions, with checks for citations, denied content and answer usefulness.
- Reduce contradictory fallback phrasing when the model has related evidence but cannot perform the requested action.

## Follow evidence across sources

Explore a bounded search/open loop that follows a reference from one source to another. Every retrieval step must enforce the same person-specific access rules. Limit steps, time and context; record what evidence was used. A source reference is not permission to open the target.

## Improve coverage and operations

- Gmail: follow the [proposed mailbox design](../reference/connectors/gmail.md); no implementation exists today.
- Jira: evaluate team-managed and portal access; model restricted comments separately before indexing them.
- Confluence: consider checking all page restrictions each poll or introducing events after measuring API cost.
- Drive: evaluate verified identity and group expansion beyond the demo's email-based keys.
- Audit: add Slack rename capture and stronger event-delivery recovery. Replace the local retained checkpoint with independently controlled immutable retention for production, and evaluate verified incremental append checks for larger histories.
- Identity: invalidate dependent connector caches consistently when the shared Atlassian link changes.

Prioritize reproducible permission tests and retrieval quality measurements before adding more sources. Setup instructions stay in [setup](../README.md); platform design choices stay in each connector reference.
