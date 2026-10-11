# Jira setup

## 1 Prerequisites

Complete [local setup](local-development.md) and [Slack sign-in](slack.md). Use a Jira Cloud site with company-managed projects and a plan that allows the permission schemes and issue security used by the demo. Confirm current capabilities and trial expiry in your site's billing settings; do not rely on old trial dates.

## 2 Create accounts and source access

Carol administers the demo site. Create a dedicated crawler account and the Alice, Bob and Dave test accounts, using the persona emails already configured. The seed can invite missing accounts and pause until they accept.

The crawler needs Browse on every in-scope project, membership in every relevant issue security level, and **Administer Jira** for reading schemes and checking another person's access. The demo site's working setup used Jira User plus User access admin roles for the crawler; verify effective permissions with `jira:doctor` rather than relying on role names alone.

## 3 Configure credentials and settings

| Setting | Value |
| --- | --- |
| `JIRA_BASE_URL` | Demo site URL |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Crawler email and API token compatible with direct site REST calls |
| `JIRA_PROJECTS` | `PAY,SEC,VEND` for this demo |
| `JIRA_ADMIN_EMAIL`, `JIRA_ADMIN_API_TOKEN` | Carol's credentials, used only by seeding |
| `JIRA_SYNC` | `on` for automatic polling, `off` for manual testing |

Create a classic API token in the account's security settings for this client's direct-site authentication. Each account creates its own token. Optional persona tokens let the seed post comments as their authors; otherwise Carol posts on their behalf. Account-ID overrides are listed in `.env.example` for hidden-email lookup problems during seeding.

Create an OAuth 2.0 integration in the Atlassian developer console. Add User identity API scope `read:me`, callback `<PUBLIC_URL>/connect/jira/callback`, and enable sharing so personas can authorize it. Put its client ID and secret in `JIRA_OAUTH_CLIENT_ID` and `JIRA_OAUTH_CLIENT_SECRET`.

## 4 Link people

Start the app. Each person signs in through Slack at `/connect.html`, then chooses **Connect Atlassian** using their own Atlassian browser session. Check the account name before accepting. Use separate browser profiles to avoid linking Bob to Carol's account.

The link identifies the person; it does not grant Jira permissions. No link means no Jira results, even in Demo mode. The same link serves the demo's Confluence connector.

## 5 Import data and enable updates

```bash
npm run seed:jira
npm run jira:doctor
npm run jira:backfill
```

On a new site, run the seed once to invite missing people, have them accept, then rerun. The seed creates/fixes groups, projects, fields and permissions. Existing issue content is normally retained. `-- --update` rewrites seeded issue fields and can replace comments; use it only when you intend to restore the whole dataset.

If Jira search has not caught up with newly seeded issues, wait and repeat backfill. Enable server updates with `JIRA_SYNC=on`, or run `npm run jira:poll` manually.

## 6 Verify and test

Select only Jira. Bob should find VEND-5 when he is in its Approvers field and linked. Alice should find PAY-240; she should not find leadership-only PAY-243. Carol can read both. Use the [Jira data matrix](../demo/data/jira.md) and [audit tests](../demo/audit-test-plan.md#jira).

## 7 Troubleshoot and restore

- No results: confirm the person's link, source access and crawler permissions using `jira:doctor`.
- Approvers is not editable: add the seeded multi-user picker to VEND's edit screen. Ensure the field referenced by the Browse grant is the one being edited; a site can have duplicate names.
- Bob still reads VEND-5 after removal: check direct Jira access and alternate grants such as assignee/reporter/group membership.
- Restore only the edited fields and run `npm run jira:poll`. Never delete a seeded issue to reset it; its key cannot be reused.
- `jira:backfill -- --reset` rebuilds Jira data/state and removes stored Atlassian links. Relink personas afterward; this also affects Confluence's shared identity lookup.

See [Jira design](../reference/connectors/jira.md) for permission layers, polling decisions and audit coverage.
