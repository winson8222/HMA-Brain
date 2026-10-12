# Demo script

**Opening:** “HMA Brain finds information across four tools, checks what the person asking can read, and shows the sources behind its answer. We can also inspect what was returned and when access changes were detected.”

## Before presenting

- Confirm the four connectors are configured and the test people have connected their own accounts. Demo mode does not create links.
- Restore the selected scenarios using the [audit test plan](audit-test-plan.md#final-restoration-checklist).
- Run `npm run audit:verify` and check source availability.
- Select only the named source for permission/freshness tests. Use multiple sources for the first example.
- Keep an admin browser available for source changes and the Audit tab. Unlock Audit with `ADMIN_TOKEN`.

## Suggested running order

| Step | Person and sources | Ask or action | What to show |
| --- | --- | --- | --- |
| 1 | Alice; Slack, Drive and Jira | What was the root cause of the payment outage, and what follow-up work was created? | Cited incident evidence and follow-up issues from the permitted sources retrieved |
| 2 | Alice, then Bob; Slack only | Search `outage` | Alice gets payments-incident evidence; Bob's baseline results exclude that private channel |
| 3 | Bob; Jira only | What is VEND-5 about, and who needs to approve it? | Acme's dashboard request; Bob needs to approve it |
| 4 | Dave; Drive only | Which merchants were affected by the outage and how much was refunded? | The shared postmortem supplies merchant details; remove the share, ask again without polling, and show the item is gone |
| 5 | Bob; Confluence only | How long did the last failover drill take? | 6 minutes 40 seconds; restrict the page, ask again without a sweep, and show the page is gone |
| 6 | Admin | Open Audit log, filter by the tested document, then Verify chain | Earlier shown decisions, later withheld/dropped decisions and detected permission changes |

Use [the audit test plan](audit-test-plan.md) for the exact mutation and restore commands. For a short presentation, choose either step 4 or 5; use the other during questions.

Do not promise that every selected source will be cited: retrieval ranking and the evidence needed by the question determine citations. Open the source cards to show what was actually used.

## Optional demonstrations

| Person and source | Question or action | Expected evidence |
| --- | --- | --- |
| Bob; Drive | How do I fail over the payment database? | Before reset edit: pay-db-2/pool 200; after the runbook edit and poll: pay-db-3/pool 400 |
| Bob; Confluence | How often are signing keys rotated? | Before edit: undecided in the rollout plan; after edit and poll: every 24 hours with 1-hour overlap |
| Alice, then Bob; Confluence | What did the outage follow-up review decide? | Alice gets the restricted review; Bob does not |
| Carol, then Dave; Jira | What is PAY-243 about? | Carol gets the leadership-only issue; Dave does not |
| Carol, then Bob; Jira | What is SEC-2 about? | Carol gets the vulnerability issue; Bob does not |
| Bob; Jira | Remove Bob from VEND-5 Approvers, then Search `payments status dashboard` | VEND-5 disappears before polling; restore Approvers and poll to bring it back |
| Bob; Slack | Add/remove Bob from payments-incident and repeat Search `outage` | Membership controls access to that private channel |
| Test person; Slack | Post, edit and delete a temporary message | Three content-change audit records and corresponding search changes |

## Explain the audit clearly

“This search record shows what this person could retrieve. A separate permission-change record shows when the connector noticed changed access. Live access checks protect the query while the index catches up.”

- A poll or sweep may be needed for the standalone change row; it is not needed to run the live permission check.
- Clear Person when looking for change rows: those records usually identify `system` as actor.
- Unknown source time means unknown. Detection time is not proof of the exact moment an administrator changed access.
- Show **Verify chain** and explain: “Each record is sealed and linked to the previous one. A separate checkpoint remembers the latest record, so verification can also detect deletion from the end of the log.” No record modification is needed for the judge demonstration.
- A failed integrity check blocks further audit appends. The checkpoint protects against Elasticsearch tampering while its separate storage remains protected; it does not protect against compromise of the entire app host.
- Chain verification proves the stored chain agrees with its retained checkpoint, not that every source event was captured.

## If an answer is confusing

Use Search and inspect source cards. “I don't have information” followed by cited VEND-5 content is an answer-quality issue, not proof that Jira denied access. Ask a factual question such as “What is VEND-5 about?” rather than issuing the title's command “Approve Acme…”.

If a source is unlinked or unavailable, fix that before demonstrating a negative permission case. An unavailable source does not prove correct access filtering.
