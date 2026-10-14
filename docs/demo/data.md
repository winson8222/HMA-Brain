# Demo data

What the seed scripts create, per platform. This is the baseline, not a report of a live site's current state. Read the [story and personas](script.md#story-and-personas) first.

## Slack and Drive

The current demonstration uses `src/story/timeline.ts` and `src/connectors/drive/cli/seedContent.ts`. The older `seed:slack` dataset is not the current story baseline.

### Slack access

| Workspace | People | Channels |
| --- | --- | --- |
| Company A (`main`) | Carol, Alice, Bob | Public general, payments, engineering and social; private payments-incident and security |
| Vendors (`vendors`) | Carol, Dave | Public general and acme-support |

The seed displays each general channel as all-company-a or all-company-a-vendors in its narrative; the workspace's actual general-channel name can differ. Payments-incident includes Alice and Carol. Security includes Carol. DMs remain limited to their participants.

### Drive access

| Folder | Seeded access |
| --- | --- |
| Company | Alice, Bob, Carol |
| Engineering/Architecture | Alice, Bob, Carol |
| Engineering/Runbooks | Alice as writer; Bob and Carol as readers |
| Engineering/Postmortems | Alice and Carol; Dave additionally receives a direct share on the postmortem |
| Security | Carol |
| Vendors | Carol |
| Vendors/Shared with Acme | Dave, plus Carol through the parent |

The Engineering parent is not shared broadly; doing so would also expose the Postmortems folder. The root belongs to the connected Drive account.

### Facts used in tests

| Item | Test fact |
| --- | --- |
| Payment service runbook | Reset: pay-db-2 and pool 200. Edited: pay-db-3 and pool 400 |
| Payment outage postmortem | Connection exhaustion after tx_schema_v2; 95-minute incident |
| Merchant refund list | M-1043: SGD 18,400; M-2210: SGD 11,900; M-0877: SGD 6,300 |
| Acme response | 47 minutes against a 15-minute commitment |

The postmortem distinguishes overall failed payments from the three listed merchants' subtotal. Do not present a subtotal as the overall incident count. Use the source excerpt when explaining a number.

### Seed and restore

With Slack/Drive configured and personas connected:

```bash
npm run seed:story -- --dry-run
npm run seed:story
npm run backfill
npm run drive:backfill
```

The seed skips already-matching story messages; it does not restore every later manual Slack membership change. Restore memberships manually. `-- --rewrite` also rewrites seeded Drive content and should be used only for a deliberate full content refresh.

Restore the Drive rehearsal state with `npm run seed:drive -- --reset` followed by `npm run drive:poll`. That restores seeded shares and the runbook; it does not erase the audit log. See the [test plan](test-plan.md) for per-scenario steps.

## Jira

The seed module [seedData.ts](../../src/connectors/jira/cli/seedData.ts) defines 15 issues across PAY, SEC and VEND. This is the baseline specification, not a report of the live site's current state. Setup is in [Jira setup](../setup/jira.md).

### People and permission groups

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

A security level further narrows access. Incident team includes Alice, Carol and crawler; Leadership only includes Carol and crawler; Security team only includes security and crawler. See [connector rules](../reference/connectors/jira.md).

### Seeded issues

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

### Baseline visibility

| Person | Expected access |
| --- | --- |
| Alice | PAY except PAY-243; VEND-4 through assignee; no SEC issues |
| Bob | PAY-231, PAY-242, PAY-244; SEC-3 through reporter; VEND-5 through Approvers |
| Carol | All seeded issues |
| Dave | VEND-1 and VEND-2 through reporter; PAY-244 through Owning team = vendors |

VEND-5 is reported by and assigned to Carol, with Bob in Approvers. Removing Bob from that field removes his intended Browse grant. He does not gain comment permission just by being an Approver.

Carol's restricted comment on PAY-240 is omitted from indexing even though Carol can read it in Jira. The connector does not yet model comment-level permissions.

### Seed and restore

Run `npm run seed:jira` for initial setup and `npm run jira:backfill` to import it. A seed rerun can repair schemes and memberships, but normally skips existing issue content. `npm run seed:jira -- --update` rewrites fields/statuses and can replace comments across the seeded issues.

For tests, restore only edited Approvers, description and status fields, then run `npm run jira:poll`. Do not delete seeded issues: Jira does not reuse their keys. [Test plan](test-plan.md#jira) give the exact sequence.

## Confluence

The seed module [seedData.ts](../../src/connectors/confluence/cli/seedData.ts) defines nine pages on the same Atlassian site as Jira. Setup is in [Confluence setup](../setup/confluence.md).

### Spaces and pages

| Space | Viewers |
| --- | --- |
| ENG | payments-eng, security and crawler: Alice, Bob, Carol and crawler |
| SEC | security and crawler: Carol and crawler |
| VEND | vendors, security and crawler: Dave, Carol and crawler |

| Space | Page | Additional viewing rule |
| --- | --- | --- |
| ENG | Auth service tokens: rollout plan | Space viewers |
| ENG | Payments platform overview | Space viewers |
| ENG | Checkout failover drill results | Space viewers until the test restriction is applied |
| ENG | Postmortems | Alice, Carol and crawler |
| ENG | Outage follow-up review | Inherited from Postmortems |
| SEC | Acme vendor security review | Space viewers |
| SEC | Access review: Q3 2026 | Space viewers |
| VEND | Acme integration guide | Space viewers |
| VEND | Escalation contacts | Space viewers |

Outage follow-up review has no direct restriction; it inherits the Postmortems parent's restriction. Bob cannot read it. The drill restriction flag temporarily narrows Checkout failover drill results to Alice, Carol and crawler.

### Demo facts

| Page | Baseline | Test change |
| --- | --- | --- |
| Checkout failover drill results | Failover took 6 minutes 40 seconds; available to Bob | Restrict the page; Bob loses the result without waiting for a sweep |
| Auth service tokens: rollout plan | Signing-key rotation interval is undecided | Set every 24 hours with a 1-hour overlap, then poll |
| Acme integration guide | P1 first response within 15 minutes, updates every 30 minutes | Read-only vendor example |
| Acme vendor security review | Security-only review | Carol can retrieve it; Dave cannot |

### Source snapshots and limits

The pages are historical sample content: Payments platform overview already names pay-db-3 while the Drive runbook reset starts at pay-db-2, and the follow-up review mentions PAY-252, which the Jira seed does not create. Run freshness questions with one source selected and do not use cross-source references to claim a live issue exists.

### Seed and restore

`npm run seed:confluence -- --dry-run` previews changes. A full seed run creates/restores spaces, pages and restrictions, and removes matching template pages. The narrow flags are better for rehearsals:

| Action | Command | Follow with |
| --- | --- | --- |
| Restrict drill | `npm run seed:confluence -- --restrict-drill` | Query first, then `npm run confluence:poll -- --sweep` |
| Restore drill | `npm run seed:confluence -- --unrestrict-drill` | Sweep |
| Edit rollout | `npm run seed:confluence -- --edit-rollout` | `npm run confluence:poll` |
| Restore rollout | `npm run seed:confluence -- --restore-rollout` | Normal poll |

For audit records and timing, use the [test plan](test-plan.md#confluence) and [connector design](../reference/connectors/confluence.md).
