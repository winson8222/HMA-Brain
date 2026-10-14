# Jira connector

**Status: implemented for the demo's company-managed projects.** [Setup](../../setup/jira.md) · [Tests](../../demo/test-plan.md#jira)

## Permission structure

| Layer | Meaning |
| --- | --- |
| Browse Projects | Required to read an issue; grants can name groups, users, project roles, reporter, assignee or picker fields |
| Issue security level | Additional restriction: the person must satisfy this level and Browse Projects |
| Restricted comments | Separate role/group visibility; this connector omits those comments |

Project roles expand into their users and groups. Picker grants are resolved per issue: Bob's name in VEND-5's Approvers field grants access because VEND's scheme explicitly uses that field. Approvers is not a universal Jira access rule.

## How access is enforced

The crawler indexes `acl_container` for Browse grants and `restricted` plus `acl_item` for security-level grants. Labels are scoped by site and use account/group IDs. Search requires both layers when an issue is restricted.

Each person connects their Atlassian identity through OAuth. The app stores their account ID in `brain-jira-state`; it does not retain their OAuth token. User/group access keys are cached for 5 minutes. No link means no Jira results.

The crawler then calls Jira's bulk `permissions/check` for the asker's account ID and candidate issue IDs. Jira evaluates current access, including security levels and picker grants. Errors withhold the affected results. The crawler needs Administer Jira for these checks.

## Updates and design decisions

| Change | Mechanism | Why |
| --- | --- | --- |
| Issue text, status, assignee, Approvers or security field | Updated-issue poll, default 60 seconds | These edits update the issue's modification time |
| Browse scheme, project role or security-level membership | Reread permission configuration each poll; resync changed projects | These changes may not update individual issues |
| User's group membership | Refresh identity keys after their cache expires | Group membership belongs to the person, not each issue |
| Deleted issues | Reconcile, default 60 minutes; full backfill also checks IDs | Updated-issue searches cannot return deleted issues |

`npm run jira:poll` handles the VEND-5 Approvers test without a separate sweep. Polling avoids a webhook app while still reading permission configuration. The JQL cursor includes overlap and uses the crawler's time zone. Server jobs require `JIRA_SYNC=on`.

## Audit records and timing

- Changed indexed access writes a permission record per affected issue, with old/new labels. Source permission-change time is unknown; detection time is recorded.
- Issue edits write content records using the source `updated` timestamp. Detected deletions have unknown source deletion time.
- Initial/reset imports use a backfill summary.
- Linking/unlinking writes one account record with source `atlassian`; that identity is shared with Confluence.
- Live checks write dropped decisions in search records, but do not themselves relabel issues or write permission-change records. Those wait for sync.

A user leaving a group may change access without changing any item's group label. There is no dedicated audit of every group-membership change. See the [shared chain](../architecture.md#audit-trail) for integrity and query limits.

## Limitations

- Restricted comments, team-managed project rules and Service Management portal-only access are not fully supported.
- Unsupported grants can cause missing results; live checks prevent broad indexed approximations from granting extra access.
- Crawler access must include each indexed issue and security level. Admin permission alone does not provide content access.
- Newly granted access can wait for a poll or identity refresh. Jira's own permission/search propagation can add delay.
- Change records identify `system`, not the source administrator who edited permissions.

Implementation: `src/connectors/jira/{acl,schemes,people,query,sync,auth,routes}.ts`.
