# Demo script

**Opening:** “Aspire Atlas finds information across four tools, checks what the person asking can read, and shows the sources behind its answer. We can also inspect what was returned and when access changes were detected.”

## Story and personas

Company A runs a payments platform; Acme is its external payments vendor. The payment database ran out of connections during a migration, causing a 95-minute checkout outage. Alice handled it. Acme took 47 minutes to respond to a page, against a 15-minute commitment. Carol shared the postmortem with Dave so Acme could review the timeline, and removes that share during the permission test.

| Person | Role | What they can see |
| --- | --- | --- |
| Alice | Payments engineer on the incident team | Incident details and her team's follow-up work |
| Bob | Engineer outside the incident team | Ordinary engineering material, plus specific issues granted to him such as VEND-5 through Approvers |
| Carol | Security lead and demo administrator | Security material and the admin audit log |
| Dave | External contractor at Acme | Vendor material, plus the Drive postmortem shared with him until that share is removed |

The crawler is a service account, not a fifth persona. Access follows source permissions, not a persona's narrative role: Dave can read whatever the shared postmortem contains even though he is external. Seeded content is historical sample text; "next week" in a page is not today's calendar. The seed modules define the baseline ([demo data](data.md)); a live site may have later edits, so check a status before promising it.

## Before presenting

- Confirm the four connectors are configured and the test people have connected their own accounts. Demo mode does not create links.
- Restore the baseline using the [test plan](test-plan.md#final-restoration-checklist).
- Run `npm run audit:verify` and check source availability.
- Select only the named source for permission/freshness tests. Use multiple sources for the first example.
- Keep an admin browser available for source changes and the Audit tab. Unlock Audit with `ADMIN_TOKEN`.

## Running order

This follows the video script. Baseline before starting: Bob is **not** in payments-incident, Dave still has his share on the postmortem, Slack sync is on and the bot is in payments-incident.

| Step | Who asks | Sources selected | Question or action | Expected |
| --- | --- | --- | --- | --- |
| 1 | Alice | Slack, Drive, Jira | What was the root cause of the payment outage, and what follow-up work was created? | Root cause: connection exhaustion after `tx_schema_v2`. Follow-up issues PAY-240, PAY-241 and PAY-245. Citations from payments-incident, the postmortem and Jira |
| 2 | Bob | Slack, Drive, Jira | Same question as step 1 (use **Compare two people** to show both at once) | "I don't have information on that." Bob is outside payments-incident, the Postmortems folder and the incident-team issues. Nothing hints that the restricted items exist |
| 2b | Bob | Slack, Drive, Jira | As Alice or Carol in Slack, add Bob to **payments-incident**. Bob asks the same question again | Root cause with citations from the incident channel, without polling. The membership event arrives within seconds; wait for it before asking |
| 3 | Bob | Jira | What is VEND-5 about, and who needs to approve it? | Acme wants read-only access to the payments status dashboard; Bob is the approver |
| 4 | Dave | Drive | Which merchants were affected by the outage and how much was refunded? | M-1043: SGD 18,400; M-2210: SGD 11,900; M-0877: SGD 6,300, from the shared postmortem |
| 4b | Dave | Drive | `npm run seed:drive -- --close-vendor-access`, then ask the same question **without polling** | No merchant details and no sign the postmortem exists. The audit records **Dropped by live re-check** |
| 5 | Carol (Admin) | Audit tab | Filter **Document = postmortem**, then click **Verify chain** | Dave's earlier "shown" decision, the later "dropped" decision, the detected permission change, and a passing chain check |

Restore afterwards: remove Bob from payments-incident, then `npm run seed:drive -- --reset` and `npm run drive:poll`. Exact commands and expected audit records are in the [test plan](test-plan.md).

Do not promise that every selected source will be cited: retrieval ranking and the evidence needed by the question determine citations. Open the source cards to show what was actually used.

## Optional demonstrations

Not in the video. Each one proves a single point; select only the named source. Exact commands and restore steps are in the [test plan](test-plan.md).

### Freshness: an edit shows up after a poll

| Who and source | Ask | Before the edit | Make the change | After the change |
| --- | --- | --- | --- | --- |
| Bob; Drive | How do I fail over the payment database? | pay-db-2, pool of 200 | `npm run seed:drive -- --edit-runbook`, then `npm run drive:poll` | pay-db-3, pool of 400 |
| Bob; Confluence | How often are signing keys rotated? | Undecided (rollout plan page) | `npm run seed:confluence -- --edit-rollout`, then `npm run confluence:poll` | Every 24 hours, with a 1-hour overlap |

### Negative case: same question, different person

Ask the question as the first person, then as the second. The second person must get no answer and no hint that the item exists.

| Source | Ask | Gets the answer | Gets nothing |
| --- | --- | --- | --- |
| Confluence | What did the outage follow-up review decide? | Alice (restricted review page) | Bob |
| Jira | What is PAY-243 about? | Carol (leadership-only issue) | Dave |
| Jira | What is SEC-2 about? | Carol (vulnerability issue) | Bob |

### Live revocation: access changes without re-indexing

| Who and source | Search | Change access | Expect | Restore |
| --- | --- | --- | --- | --- |
| Bob; Jira | `payments status dashboard` | As Carol, remove Bob from VEND-5's **Approvers** field | VEND-5 disappears immediately, **without polling** | Add Bob back, then `npm run jira:poll` |

### Audit of content changes

| Who and source | Action | Expect |
| --- | --- | --- |
| Any test person; Slack | Post a temporary message, edit it, then delete it | Three content-change records in Audit; Search shows the message, then the edit, then nothing |

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
