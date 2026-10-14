# Demo script

## Story

Company A runs a payments platform; Acme is its payments vendor. The payment database ran out of connections during a migration and checkout was down for 95 minutes. The investigation happened in the private Slack channel **payments-incident**, the follow-ups are in Jira, and the postmortem and runbooks are in Drive and Confluence.

| Person | Who they are | What they can see |
| --- | --- | --- |
| Alice | On-call engineer who handled the outage | The incident channel, the postmortem, the incident-team issues |
| Bob | Engineer outside the incident team | Ordinary engineering material, plus issues granted to him such as VEND-5 |
| Carol | Security lead and admin | Everything, including the audit log |
| Dave | Acme contractor | Vendor material, plus the one postmortem shared with him |

## Before presenting

- Bob is **not** in payments-incident. Dave still has his share on the postmortem. Run `npm run seed:drive -- --reset` and `npm run drive:poll` if unsure.
- Slack sync is on and the bot is in payments-incident.
- All four personas have connected their own accounts on `/connect.html`.
- Have an admin browser open on the Audit tab, unlocked with `ADMIN_TOKEN`.

## Running order

| Step | Who | Sources | Ask or do | Expected |
| --- | --- | --- | --- | --- |
| 1 | Alice | Slack, Drive, Jira | What was the root cause of the payment outage, and what follow-up work was created? | Connection exhaustion after `tx_schema_v2`. Follow-ups PAY-240, PAY-241, PAY-245. Citations from payments-incident, the postmortem and Jira |
| 2 | Bob | Slack, Drive, Jira | Same question, with **Compare two people** on | "I don't have information on that." No hint that the channel or postmortem exist |
| 2b | Bob | Slack, Drive, Jira | In Slack, add Bob to payments-incident. Wait a few seconds. Ask again | Root cause with citations from the incident channel, no polling |
| 3 | Bob | Jira | What is VEND-5 about, and who needs to approve it? | Acme wants read-only access to the payments status dashboard; Bob is the approver |
| 4 | Dave | Drive | Which merchants were affected by the outage and how much was refunded? | M-1043: SGD 18,400; M-2210: SGD 11,900; M-0877: SGD 6,300 |
| 4b | Dave | Drive | `npm run seed:drive -- --close-vendor-access`, then ask again without polling | Nothing. Audit records **Dropped by live re-check** |
| 5 | Carol | Audit tab | Filter **Document = postmortem**, then **Verify chain** | Dave's earlier "shown", the later "dropped", the permission change, and a passing chain |

Afterwards: remove Bob from payments-incident, then `npm run seed:drive -- --reset` and `npm run drive:poll`.

## If something looks wrong

- Open the source cards. If VEND-5 is cited but the answer starts "I don't have information", that is answer wording, not a denied permission.
- A source that is unlinked or down does not prove access filtering. Fix the link first.
- Audit change rows have actor `system`; clear the Person filter to see them.

## Spare demos

Not in the video. Commands and restore steps are in the [test plan](test-plan.md).

| Proves | Who, source | Ask | Change | Result |
| --- | --- | --- | --- | --- |
| Freshness | Bob, Drive | How do I fail over the payment database? | `seed:drive -- --edit-runbook`, then `drive:poll` | pay-db-2 / pool 200 becomes pay-db-3 / pool 400 |
| Freshness | Bob, Confluence | How often are signing keys rotated? | `seed:confluence -- --edit-rollout`, then `confluence:poll` | Undecided becomes every 24 hours with a 1-hour overlap |
| Live revocation | Bob, Confluence | How long did the last failover drill take? | `seed:confluence -- --restrict-drill`, no sweep | 6 minutes 40 seconds, then nothing |
| Live revocation | Bob, Jira | Search `payments status dashboard` | As Carol, remove Bob from VEND-5's Approvers | VEND-5 disappears without polling |
| Negative case | Alice then Bob, Confluence | What did the outage follow-up review decide? | none | Alice gets the review; Bob gets nothing |
| Negative case | Carol then Dave, Jira | What is PAY-243 about? | none | Carol gets the issue; Dave gets nothing |
