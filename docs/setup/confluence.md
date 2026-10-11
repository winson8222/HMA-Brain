# Confluence setup

## 1 Prerequisites

Complete [local setup](local-development.md), [Slack sign-in](slack.md) and the [Jira account/crawler setup](jira.md). The demo uses the same Atlassian site, accounts and groups. Choose a Confluence plan that supports space and page viewing restrictions; confirm the current plan and expiry in site administration.

## 2 Create accounts and source access

Add Confluence to the existing Atlassian site and give the personas and crawler product access. The seed uses the Jira-created groups `payments-eng`, `security`, `vendors` and `brain-crawler`.

Give the crawler View access to every in-scope space, include it in page restrictions and grant Confluence Administrator for permission checks on another person's behalf. Administration alone does not supply content access.

## 3 Configure credentials and settings

```dotenv
CONFLUENCE_SYNC=on
CONFLUENCE_SPACES=ENG,SEC,VEND
```

The connector defaults to `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. Setting `CONFLUENCE_SYNC=off` still enables the connector, but disables automatic sync. Leaving it unset does not opt in. Site/token overrides exist in `.env.example`; the demo and shared identity flow are tested around one Atlassian site.

The seed needs Carol's `JIRA_ADMIN_EMAIL` and `JIRA_ADMIN_API_TOKEN` (or its documented Carol-token fallback). Keep those separate from the crawler credentials.

## 4 Link people

Each persona signs into HMA Brain and connects Atlassian at `/connect.html`. An existing Jira link is sufficient; there is no second Confluence connection. Check the linked name and the person's Confluence product/space access.

## 5 Import data and enable updates

```bash
npm run seed:confluence -- --dry-run
npm run seed:confluence
npm run confluence:doctor
npm run confluence:backfill
```

The seed creates spaces/pages, applies restrictions and removes its template pages. A full rerun restores the seeded layout and content; review the dry run before using it on an edited demo site.

With `CONFLUENCE_SYNC=on`, the server polls content and space permissions and separately sweeps page restrictions. Manual commands:

```bash
npm run confluence:poll
npm run confluence:poll -- --sweep
```

## 6 Verify and test

Select only Confluence. Bob should find **Checkout failover drill results** while it is unrestricted and answer **6 minutes 40 seconds**. Bob should not read **Outage follow-up review**, which inherits its parent's restriction. Follow the [audit tests](../demo/audit-test-plan.md#confluence).

## 7 Troubleshoot and restore

- No connector: explicitly set `CONFLUENCE_SYNC` and check credentials.
- Missing page: verify crawler access to the space and every applicable restriction.
- Restriction changed but no permission audit row: run the sweep; a content-only poll may miss it.
- Newly connected person still appears unlinked: allow the identity cache to expire or restart the server; confirm the correct Atlassian account was linked.
- Restore demo restrictions with `seed:confluence -- --unrestrict-drill` then a sweep. Restore the rollout with `seed:confluence -- --restore-rollout` then a normal poll.

See [Confluence design](../reference/connectors/confluence.md) for inheritance, poll/sweep decisions and audit timing.
