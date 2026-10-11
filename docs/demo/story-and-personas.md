# Demo story and personas

Company A runs a payments platform. Acme is its external payments vendor. After a checkout outage, staff need to find the incident history, follow-up work and operating instructions across several tools. Each person should see only what those tools permit.

## People

| Person | Role | What the demonstration shows |
| --- | --- | --- |
| Alice | Payments engineer on the incident team | Can read incident details and her team's follow-up work |
| Bob | Engineer outside the incident team | Can read ordinary engineering material and specific issues granted to him, such as VEND-5 through Approvers |
| Carol | Security lead and demo administrator | Can inspect security material and the admin audit log |
| Dave | External contractor at Acme | Can read vendor material and the specific Drive postmortem shared with him until that share is removed |

The crawler is a service account, not a fifth persona. It imports content; its broad source access must not become the asker's access.

## The story

The payment database ran out of connections during a migration, causing a 95-minute checkout incident. Alice handled it. Acme took 47 minutes to respond to a page, against its 15-minute commitment. Carol shared the postmortem with Dave so Acme could review the timeline, then removes that share during the permission test.

The story spans four implemented platforms:

| Platform | Role in the story |
| --- | --- |
| Slack | Conversations, incident coordination and private messages |
| Drive | Runbook, postmortem, merchant refund details and operating documents |
| Jira | Follow-up issues, vendor requests and issue-specific access |
| Confluence | Rollout plan, drill results, review pages and vendor guidance |

Gmail is a proposed connector and is not demonstrated.

## What judges should see

1. A cited answer can combine permitted evidence from several sources.
2. Two people can ask the same question and receive different evidence.
3. Removing source access stops that source item being returned before the next index sync.
4. Content edits reach the index through the platform's update mechanism.
5. The audit shows query decisions and detected changes; restoring demo data adds reversal records.

Access follows source permissions, not a persona's narrative role. For example, Dave can read whatever the temporarily shared postmortem contains, even though he is external. Bob can read his phishing report SEC-3 without gaining access to the other security issues.

## Baselines and changing data

Use [the demo script](script.md) for judge-facing questions and [the audit tests](audit-test-plan.md) for exact changes, commands and restoration.

The seed modules define the baseline: [Slack and Drive](data/slack-and-drive.md), [Jira](data/jira.md), [Confluence](data/confluence.md). A live site may have later edits or different status names. Do not promise exact current statuses without checking them.

The data intentionally supports a before/after runbook edit. Other seeded pages can describe a later system snapshot. Select one source for freshness tests so those snapshots do not confuse the result. Historical references such as “next week” are part of the sample content, not today's calendar.
