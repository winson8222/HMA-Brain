# Jira demo data

The seed module [seedData.ts](../../../src/connectors/jira/cli/seedData.ts) defines 15 issues across PAY, SEC and VEND. This is the baseline specification, not a report of the live site's current state. Setup is in [Jira setup](../../setup/jira.md).

## People and permission groups

| Group | Members |
| --- | --- |
| payments-eng | Alice, Bob |
| security | Carol |
| vendors | Dave |
| brain-crawler | Crawler |

The PAY Engineers role includes payments-eng and Carol. Carol administers each demo project. Browse grants include the crawler; security levels include it too.

| Project | Browse access |
| --- | --- |
| PAY | Engineers role, crawler, and the group in an issue's Owning team field |
| SEC | Security group, issue reporter and crawler |
| VEND | Security group, reporter, assignee, Approvers field and crawler |

A security level further narrows access. Incident team includes Alice, Carol and crawler; Leadership only includes Carol and crawler; Security team only includes security and crawler. See [connector rules](../../reference/connectors/jira.md).

## Seeded issues

| Key | Purpose | Security level |
| --- | --- | --- |
| PAY-231 | Migration step 3 blocked by a schema lock | None |
| PAY-240 | Raise database connection limit from 200 to 400 | Incident team |
| PAY-241 | Alert when the connection pool is over 80 percent full | Incident team |
| PAY-242 | Improve the checkout error page | None |
| PAY-243 | Estimate bringing second-line support in-house | Leadership only |
| PAY-244 | Send P1 notifications to Acme | None; Owning team is vendors |
| PAY-245 | Name the backup database in the runbook | Incident team |
| SEC-1 | Leaked payment gateway API key | Security team only |
| SEC-2 | Patch CVE-2026-1234 | Security team only |
| SEC-3 | Bob's phishing report | None |
| VEND-1 | Share the outage timeline with Acme | None |
| VEND-2 | Monthly Acme service report | None |
| VEND-3 | Internal Acme renewal discussion | None |
| VEND-4 | Alice checks Acme's outage timeline | None |
| VEND-5 | Bob approves dashboard access | None |

Status names can differ by workflow, and existing issues are not rewritten by a normal seed rerun. Test visibility and source content rather than requiring a particular live status such as To Do or Backlog.

## Baseline visibility

| Person | Expected access |
| --- | --- |
| Alice | PAY except PAY-243; VEND-4 through assignee; no SEC issues |
| Bob | PAY-231, PAY-242, PAY-244; SEC-3 through reporter; VEND-5 through Approvers |
| Carol | All seeded issues |
| Dave | VEND-1 and VEND-2 through reporter; PAY-244 through Owning team = vendors |

VEND-5 is reported by and assigned to Carol, with Bob in Approvers. Removing Bob from that field removes his intended Browse grant. He does not gain comment permission just by being an Approver.

Carol's restricted comment on PAY-240 is omitted from indexing even though Carol can read it in Jira. The connector does not yet model comment-level permissions.

## Seed and restore

Run `npm run seed:jira` for initial setup and `npm run jira:backfill` to import it. A seed rerun can repair schemes and memberships, but normally skips existing issue content. `npm run seed:jira -- --update` rewrites fields/statuses and can replace comments across the seeded issues.

For tests, restore only edited Approvers, description and status fields, then run `npm run jira:poll`. Do not delete seeded issues: Jira does not reuse their keys. [Audit tests](../audit-test-plan.md#jira) give the exact sequence.
