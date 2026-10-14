# Permission aware retrieval

Permissions decide which evidence can reach the answer model. The model is not responsible for deciding access.

## From identity to evidence

1. **Resolve the person.** Me mode uses the signed session. Demo mode accepts a selected test persona only when impersonation is enabled.
2. **Resolve access keys.** The selected connector maps the person to source identity and supported permissions. A missing required link prevents that source from returning results.
3. **Filter inside search.** Indexed items carry access labels. Keyword and vector queries include permission filters before selecting candidate evidence. Sources with multiple access layers require each supported layer to pass.
4. **Recheck candidates.** The connector checks current access using its source-specific rules. Failed or uncertain checks withhold the affected evidence. See the connector documents for exactly what is checked.
5. **Rank permitted evidence.** The shared layer combines connector rankings and can rerank surviving evidence. Ask sends only this evidence to the model and requests citations.
6. **Write the access record.** The audit records the query and per-document decisions before the response is returned. An admin-only metadata query also supplies withheld-item entries; those do not enter the answer prompt or the asker's response.

## Understanding the result

| Decision | Meaning |
| --- | --- |
| Shown | Evidence passed the implemented checks and was selected for the response or answer context |
| Withheld | An item matched the audit metadata query but failed the indexed permission filter |
| Dropped by live recheck | A candidate passed the index filter but failed the current-access check |
| Cited | The generated answer referenced that allowed excerpt |

Shown does not always mean cited. A source card is stronger evidence that retrieval succeeded than the model's opening sentence. If a source is unavailable, the app can still answer from other selected sources; that differs from finding no matching evidence.

## What stale permissions mean

The index narrows candidates; current-access checks protect against access removed since indexing. When new access is granted, an overly narrow index or cached identity can still hide a valid result until refreshed. Source changes can also take time to propagate within the source system itself.

A permission-change audit row and a search access row answer different questions. The former says when the connector detected a change; the latter says which evidence that particular query was allowed to use. Neither is a complete source-admin history.

## Platform rules

Identity mappings, permission structures, update schedules, events, timestamps and design choices live in the connector references:

- [Slack](connectors/slack.md)
- [Google Drive](connectors/drive.md)
- [Jira](connectors/jira.md)
- [Confluence](connectors/confluence.md)

See [architecture](architecture.md) for storage and the shared audit chain, and [audit tests](../demo/audit-test-plan.md) for demonstrations.

## User-facing metadata

User pages do not enumerate channels, files, projects or spaces before a query. The main page and Connections page have no access previews. `/api/access` returns only source connection flags; `/api/me` and `/api/users` return identity/connection details without content inventories. Search/Ask independently check permissions before returning results, citations and answers.

The admin audit panel retains its protected document metadata and access decisions, including withheld items. Removing previews does not change search permissions or make demo impersonation safe for unrestricted public use.
