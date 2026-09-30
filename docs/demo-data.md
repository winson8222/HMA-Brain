# Demo data

What is in the demo Slack workspaces today, who can see it, and which questions show it off.
Snapshot of the `brain` index on 2026-10-01 (branch `enhanced-retrieval-multi-workspace`): **19 messages, 2 workspaces, all embedded**.

Most of it comes from `npm run seed:slack` (`src/seedSlack.ts`). Rows marked *manual* were posted by hand and are not recreated by the seed script.

## People

The UI identifies people by email and links their accounts across workspaces.

| Person | Email | Company A Demo | Company A – Vendors | DMs connected |
|---|---|---|---|---|
| **Alice** | alicehmatest@gmail.com | member · 🔒 `#payments-incident` | — | ✅ |
| **Bob** | bobhmatest@gmail.com | member | — | — |
| **Carol** (owner) | the owner's own email (`CAROL_EMAIL`) | member · 🔒 `#payments-incident` · 🔒 `#security` | member · 🔒 `#vendor-contracts` | ✅ both workspaces |
| **Dave** | davehmatest@gmail.com | member | member | — |
| **jithin.bathula** | a teammate's real account | member | — | — |

"Member" means a full member (not a guest), so they can see every public channel in that workspace.

A DM is indexed once **any** participant connects. Alice's and Carol's connections cover every DM below.

## Channels and messages

Dates are UTC, when the message was posted.

### Company A Demo

| Channel | Type | Who can see it | Author · date | Message |
|---|---|---|---|---|
| `#all-company-a-demo` | public | everyone in the workspace | Carol · 25 Sep | Reminder: all-hands on Friday |
| `#payments` | public | everyone in the workspace | Alice · 25 Sep | Payment API p99 latency spiking since 09:40, looking into it |
| | | | Bob · 25 Sep | Is the checkout outage related to the DB migration? |
| `#db-migration` | public | everyone in the workspace | Alice · 25 Sep | Migration step 3 blocked: schema lock on `transactions` table, ticket PAY-231 |
| | | | Bob · 25 Sep | Rollback plan for the migration is in the Confluence runbook |
| `#vendor-support` | public | everyone in the workspace | Dave · 25 Sep | Can someone share the payment outage timeline for our SLA report? |
| `#payments-incident` | 🔒 private | Alice, Carol | Alice · 25 Sep | Root cause of payment outage: connection pool exhausted after migration flag enabled |
| | | | Carol · 25 Sep | Follow-up tickets PAY-240 (pool limits) and PAY-241 (alerting) created |
| | | | Alice · 25 Sep | Failover step added to runbook: switch to replica `pay-db-2` |
| | | | Carol · 25 Sep | *manual:* Failover step added to runbook: switch to replica `pay-db-3` |
| `#security` | 🔒 private | Carol | Carol · 25 Sep | Q3 breach incident report: leaked API key in public repo, rotated 14 Aug |
| | | | Carol · 25 Sep | Vulnerability CVE-2026-1234 in auth service, patch in progress |
| DM: Alice ↔ Carol | 🔒 DM | Alice, Carol | Alice · 28 Sep | Between us: the outage root cause was my migration flag. Postmortem draft coming tonight. |
| Group DM: Alice, Bob, Carol | 🔒 group DM | Alice, Bob, Carol | Carol · 28 Sep | Standup moved to 10am because of the payment outage |
| DM: Carol ↔ Dave | 🔒 DM | Carol, Dave | Carol · 25 Sep | *manual:* :wave: Hi @Dave |
| DM: Carol ↔ jithin.bathula | 🔒 DM | Carol, jithin | Carol · 30 Sep | *manual:* ⚠️ an inappropriate test message. Don't demo as Carol or jithin with questions that could surface it. |

`#new-channel` and `#social` exist but are empty.

### Company A – Vendors

| Channel | Type | Who can see it | Author · date | Message |
|---|---|---|---|---|
| `#vendor-general` | public | Carol, Dave | Carol · 28 Sep | Vendor SLA review for the payment outage is due Friday |
| `#vendor-contracts` | 🔒 private | Carol | Carol · 28 Sep | Payment processor contract renewal: penalty clause triggered by the outage, $40k credit |
| DM: Carol ↔ Dave | 🔒 DM | Carol, Dave | Carol · 28 Sep | Dave, please don't share the outage timeline with other vendors yet |

`#all-company-a-vendors`, `#social` and `#new-channel` exist but are empty.

## The story in the data

A payment outage on 25 Sep, told from different angles:
- **Public:** latency spikes, people asking about it (`#payments`, `#vendor-support`).
- **Private channel:** the real root cause and the runbook (`#payments-incident`).
- **DM:** Alice's admission that it was her change (DM with Carol).
- **Other workspace:** the commercial fallout, a $40k credit (`#vendor-contracts`).

Each layer is visible to fewer people, which is what makes the permission demo work.

## Demo questions (Ask)

Tested on 2026-10-01. None of these questions shares meaningful words with the message that answers it, so they rely on hybrid (meaning-based) search.

| Question | Ask as | Expected answer | Ask as | Expected answer |
|---|---|---|---|---|
| is there a company meeting this week? | Carol | all-hands on Friday | anyone | same (public) |
| why were there too many open database connections? | Alice | pool exhausted after migration flag, plus her DM | Dave | "I don't have information on that" |
| who admitted breaking things? | Alice | Alice, from her DM with Carol | Bob | "I don't have information on that" |
| did the morning sync get rescheduled? | Bob | standup moved to 10am (group DM) | Dave | "I don't have information on that" |
| what compensation are we getting because of the outage? | Carol | $40k credit (Vendors, private) | Alice | "I don't have information on that" |
| what's our plan if the payments database dies? | Alice | failover to a replica | Dave | "I don't have information on that" |

## Known quirks

- **Conflicting runbook.** `#payments-incident` names both `pay-db-2` and `pay-db-3`, so failover answers mention both.
- **"Friday" is relative.** The all-hands reminder was posted on Friday 25 Sep, so "Friday" could mean that day or 2 Oct. Search isn't date-aware yet, so questions like "what's happening tomorrow?" get "I don't have information on that".
- **Strict wording.** The LLM answers only what the messages support. "Card company" doesn't match "payment processor", so it declines even though the right message was retrieved.

## Rebuilding

```bash
npm run seed:slack    # recreate seeded channels, members and messages (skips existing ones)
npm run backfill      # reindex and re-embed everything
npm run verify        # compare Slack with the index, per channel and DM
```
DMs need their author to have connected at `/connect` first. The *manual* rows above are not recreated.
