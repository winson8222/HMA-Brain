# Confluence demo data

The seed module [seedData.ts](../../../src/connectors/confluence/cli/seedData.ts) defines nine pages on the same Atlassian site as Jira. Setup is in [Confluence setup](../../setup/confluence.md).

## Spaces and pages

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

## Demo facts

| Page | Baseline | Test change |
| --- | --- | --- |
| Checkout failover drill results | Failover took 6 minutes 40 seconds; available to Bob | Restrict the page; Bob loses the result without waiting for a sweep |
| Auth service tokens: rollout plan | Signing-key rotation interval is undecided | Set every 24 hours with a 1-hour overlap, then poll |
| Acme integration guide | P1 first response within 15 minutes, updates every 30 minutes | Read-only vendor example |
| Acme vendor security review | Security-only review | Carol can retrieve it; Dave cannot |

## Source snapshots and limits

The pages are historical sample content. Payments platform overview already names pay-db-3, while the Drive runbook reset deliberately starts at pay-db-2 for a freshness demonstration. Run the freshness question with Drive alone selected.

The follow-up review references PAY-252, which is absent from the Jira seed's issue list, and describes some follow-up statuses differently from Jira's seeded statuses. Do not use those references to claim a live issue exists or a cross-source status is consistent. Use the drill/rollout questions for this demo; aligning those source bodies is separate seed-data work.

The security access-review page describes a past postmortem access removal. The test reset restores Dave's current share. Source narrative history and current sharing are different facts; use actual sharing and audit records for the live access test.

## Seed and restore

`npm run seed:confluence -- --dry-run` previews changes. A full seed run creates/restores spaces, pages and restrictions, and removes matching template pages. The narrow flags are better for rehearsals:

| Action | Command | Follow with |
| --- | --- | --- |
| Restrict drill | `npm run seed:confluence -- --restrict-drill` | Query first, then `npm run confluence:poll -- --sweep` |
| Restore drill | `npm run seed:confluence -- --unrestrict-drill` | Sweep |
| Edit rollout | `npm run seed:confluence -- --edit-rollout` | `npm run confluence:poll` |
| Restore rollout | `npm run seed:confluence -- --restore-rollout` | Normal poll |

For audit records and timing, use the [audit test plan](../audit-test-plan.md#confluence) and [connector design](../../reference/connectors/confluence.md).
