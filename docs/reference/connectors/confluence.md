# Confluence connector

**Status: implemented.** [Setup](../../setup/confluence.md) · [Tests](../../demo/audit-test-plan.md#confluence)

## Permission structure

A person needs access to the space and must satisfy the page's viewing restrictions, including inherited restrictions. Edit restrictions do not determine reading access. The crawler also needs permission to read each indexed page.

Space grants can name users, groups or anonymous access. A page restriction narrows space access; it cannot grant access to someone who cannot view the space.

## How access is enforced

The index stores space View labels in `acl_container`. Restricted pages also have `restricted` and `acl_item`. Labels use the `confluence:<site>:` prefix and account/group IDs.

For the index filter, the connector uses the nearest restricted page or ancestor. This is an approximation when multiple ancestor restrictions apply. Before returning a candidate, it calls Confluence's page permission-check API with the linked person's account ID. Confluence evaluates the complete restriction chain; denied or uncertain results are dropped.

The demo reuses the Atlassian identity link in `brain-jira-state` and the Jira crawler credentials. Confluence group keys are cached for 5 minutes. This reduces repeated lookups but can delay newly granted results. The crawler needs Confluence Administrator for checks on another person's behalf.

## Updates and design decisions

| Change | Mechanism | Why |
| --- | --- | --- |
| Content edited or page created | CQL last-modified poll, default 60 seconds | Efficiently fetch recently changed content |
| Space View permissions | Reread every poll; resync changed spaces | Space grants may change without page edits |
| Page restriction only | Full restriction sweep, default 10 minutes | Restriction changes may not change the page's last-modified timestamp |
| Parent restriction | Recompute indexed descendants using the stored page tree | Children inherit restrictions |
| Page deleted or moved | Sweep compares current pages and parent IDs | A last-modified query alone is insufficient |

Normal poll: `npm run confluence:poll`. Restriction sweep: `npm run confluence:poll -- --sweep`. The sweep is an alternative operation, not an extra content poll. Server jobs require `CONFLUENCE_SYNC=on`.

The split keeps frequent content polls cheaper than checking every page's restrictions. Running both on each poll is possible, but increases API requests and is not implemented. No Forge/Connect webhook app is required by this design. The live permission check covers revoked access before the index catches up.

## Audit records and timing

- Sync writes before/after permission records when space/page labels change. Page restriction-only records normally wait for the sweep.
- Permission changes and deletions have unknown source change time. They record detection time instead.
- Content added/updated records use the page version time; content records also carry indexed time.
- Initial/reset imports use summaries. Parent restriction changes can produce records for affected descendants.
- Live rechecks log a search's dropped decision but do not write a standalone permission-change record or relabel the page.
- Account linking/unlinking is recorded once as `atlassian`, shared with Jira.

The [shared chain](../architecture.md#shared-audit-chain) covers search, account and admin events. A sweep interval is a scheduling target, not a bound on how long changes were hidden during outages.

## Limitations

- A crawler excluded from a page cannot index it, even if a user could read it.
- Multiple inherited restrictions are approximated in the index and resolved by the live check.
- Changes to a user's groups may not change stored page labels, so they do not necessarily create page permission-change records.
- Confluence caches account access independently. A newly linked or unlinked identity can take up to its 5-minute cache lifetime to refresh; restart the demo server when testing connection changes if needed.
- The current shared identity store assumes the same Atlassian identity context as Jira. A different site needs separate validation.
- Change records do not identify the person who changed permissions in Confluence.

Implementation: `src/connectors/confluence/{acl,spaces,people,query,sync,client}.ts`.
