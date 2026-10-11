# Slack and Drive demo data

The current demonstration uses `src/story/timeline.ts` and `src/connectors/drive/cli/seedContent.ts`. Read the [shared story](../story-and-personas.md) first. The older `seed:slack` dataset is not the current story baseline.

## Slack access

| Workspace | People | Channels |
| --- | --- | --- |
| Company A (`main`) | Carol, Alice, Bob | Public general, payments, engineering and social; private payments-incident and security |
| Vendors (`vendors`) | Carol, Dave | Public general and acme-support |

The seed displays each general channel as all-company-a or all-company-a-vendors in its narrative; the workspace's actual general-channel name can differ. Payments-incident includes Alice and Carol. Security includes Carol. DMs remain limited to their participants.

## Drive access

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

## Facts used in tests

| Item | Test fact |
| --- | --- |
| Payment service runbook | Reset: pay-db-2 and pool 200. Edited: pay-db-3 and pool 400 |
| Payment outage postmortem | Connection exhaustion after tx_schema_v2; 95-minute incident |
| Merchant refund list | M-1043: SGD 18,400; M-2210: SGD 11,900; M-0877: SGD 6,300 |
| Acme response | 47 minutes against a 15-minute commitment |

The postmortem distinguishes overall failed payments from the three listed merchants' subtotal. Do not present a subtotal as the overall incident count. Use the source excerpt when explaining a number.

## Seed and restore

With Slack/Drive configured and personas connected:

```bash
npm run seed:story -- --dry-run
npm run seed:story
npm run backfill
npm run drive:backfill
```

The seed skips already-matching story messages; it does not restore every later manual Slack membership change. Restore memberships manually. `-- --rewrite` also rewrites seeded Drive content and should be used only for a deliberate full content refresh.

Restore the Drive rehearsal state with `npm run seed:drive -- --reset` followed by `npm run drive:poll`. That restores seeded shares and the runbook; it does not erase the audit log. See [audit tests](../audit-test-plan.md) for per-scenario steps.
