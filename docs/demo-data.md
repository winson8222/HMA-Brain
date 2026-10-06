# Demo data

Everything the demo runs on: one fictional company, four people, one story, in two Slack workspaces and one Google Drive folder. Read this first.

## The story

**Company A** is a payments company. **Acme** is the vendor that processes its card payments.

One Saturday evening, card payments at Company A's checkout failed for 95 minutes. **Alice**, the engineer on call, fixed it: a database change she had switched on was using up all the database connections, and she switched over to the backup database. Afterwards she wrote a **postmortem**. It lists the root cause, the follow-up tickets, and the merchants affected with how much each was refunded. That last part is confidential.

**Carol** (security and compliance) shared the postmortem with **Dave** from Acme, because Acme's support desk had been slow to answer during the outage and Acme needed the timeline to look into it. Once Acme was done, Carol takes his access back.

**Bob**, the junior engineer, was not on the incident team. He knows payments were down and are fixed, and he can read the runbook. He never learns the root cause, the tickets or the merchants.

That's the whole story. Everything else in Slack and Drive is ordinary company chatter so the workspace looks real.

## The people

| | Role | Can see |
|---|---|---|
| **Alice** | Senior payments engineer, was on call | Everything about the outage: the private incident channel, the postmortem. Not the Security or Vendors folders. |
| **Bob** | Junior engineer, new | Public channels and the engineering docs (runbook, handbook, rota). Nothing private. |
| **Carol** | Security and compliance; runs both Slack workspaces and the Drive | Everything. She's the one who revokes access and reads the audit log. |
| **Dave** | Engineer at Acme, external | Only the Vendors workspace and the "Shared with Acme" folder, plus the postmortem until Carol removes it. |

Emails are in `.env` (`ALICE_EMAIL` etc). The same email identifies a person in Slack and in Drive.

## Where things are

### Slack: "Company A"

| Channel | Who | What's in it |
|---|---|---|
| `#all-company-a` | everyone | Office notices |
| `#payments` | everyone | The outage as the company saw it: "latency spiking", updates, "resolved". Team chatter. **No root cause.** |
| `#engineering` | everyone | Deploys, code reviews, staging |
| `#social` | everyone | Futsal, lunch, birthdays |
| 🔒 `#payments-incident` | Alice, Carol | The incident as it happened: the cause, the failover, the root cause, tickets PAY-240 and PAY-241, the postmortem |
| 🔒 `#security` | Carol | Carol's notes: "not a security incident", vulnerability register, Acme's temporary access |
| DMs | | Alice → Carol: "the outage was my migration flag". Carol → Alice, Bob: standup moved. |

### Slack: "Company A – Vendors"

| Channel | Who | What's in it |
|---|---|---|
| `#all-company-a-vendors` | Carol, Dave | Welcome |
| `#acme-support` | Carol, Dave | Acme's maintenance and monthly report, and the thread where Carol shares the postmortem for Acme's follow-up and Dave confirms the timeline |
| DM | Carol, Dave | "Don't share the outage timeline outside Acme" |

### Google Drive: folder "Company A"

| Folder | Shared with | Files |
|---|---|---|
| Company | Alice, Bob, Carol | Employee handbook, Quarterly business review (slides), IT helpdesk SLA |
| Engineering | Alice, Bob, Carol (file by file) | README, On-call rota, DB migration plan, Payment alert rules |
| Engineering/Architecture | Alice, Bob, Carol | ADR-012 Auth service tokens |
| Engineering/Runbooks | Alice (editor), Bob, Carol | **Payment service runbook**, Incident response handbook, On-call handover |
| Engineering/Postmortems | Alice, Carol, **+ Dave on the postmortem only** | **Payment outage postmortem**, Failed checkouts (CSV) |
| Security | Carol | Security incident report, Vulnerability register |
| Vendors | Carol | Acme renewal notes |
| Vendors/Shared with Acme | Dave (editor), Carol | Vendor SLA agreement (PDF), Vendor onboarding guide, Acme monthly report (PDF) |

Carol's Google account owns the Drive folder, and both Slack workspaces were created by her. Dave's postmortem share is the only share that doesn't come from a folder.

## The demo

Five moments. Ask the same question as different people and watch the answer change.

| # | Ask as | Question | Expected | Shows |
|---|---|---|---|---|
| 1 | Alice, then Bob | *What was the root cause of the payment outage, and what follow-up tickets were created?* | **Alice:** connection pool exhausted after the migration flag; PAY-240 and PAY-241, citing `#payments-incident` and the postmortem. **Bob:** "I don't have information on that." | Same question, different answer |
| 2 | Bob, then Carol | *Show me all security vulnerabilities* | **Bob:** "I don't have information on that", with no hint anything exists. **Carol:** CVE-2026-1234, VULN-017, VULN-021, VULN-024. | Refusal without leaking |
| 3 | Bob | *How do I fail over the payment database?* Then Alice edits the runbook in Google Docs (or `npm run seed:drive -- --edit-runbook`), click Sync now, Bob asks again | Before: switch to pay-db-2, pool at least 200. After: pay-db-3, at least 400. | Freshness |
| 4 | Dave | *Which merchants were affected by the outage and how much was refunded?* Then Carol removes Dave from the postmortem in Drive's share dialog (or `-- --close-vendor-access`), Dave asks again straight away | Before: M-1043, SGD 18,400… After: "I don't have information on that." Admin view: "dropped by live re-check". | Live revocation |
| 5 | Carol | Audit log tab: filter by the postmortem, then by Dave, then Verify chain | What Dave saw, when, and when it was cut off. "All records intact." | Audit |

More questions that work:

| Ask as | Question | Expected |
|---|---|---|
| Alice | Did anyone admit the outage was their fault? | Yes, her DM to Carol. Bob asking the same: no information. |
| Alice | How long did Acme take to answer the page during the outage? | 47 minutes. Bob: no information. |
| Dave | What are Acme's response time commitments? | 15 minutes first response, updates every 30 minutes (the SLA PDF) |
| Carol | Is Company A thinking of replacing Acme? | The renewal notes: in-house option, about USD 450,000 a year. Dave: no information. |
| Bob | Who is on call next week? | Bob, with Alice as backup (the rota) |
| Bob | How much time do engineers spend looking for information? | 31% (the business review slides) |

Search is keyword-based unless embeddings are configured (`EMBEDDING_*` in `.env`), so questions work best when they reuse words from the content.

`npm run seed:drive -- --reset` puts the runbook and Dave's share back for the next rehearsal.

## Rebuilding

| Where | File |
|---|---|
| Every Slack message and DM, in order | `src/story/timeline.ts` |
| Every Drive file | `src/connectors/drive/cli/seedContent.ts` |
| Every Jira issue and comment | `src/connectors/jira/cli/seedData.ts` (setup: [jira-mock-data-plan.md](jira-mock-data-plan.md)) |

```bash
npm run seed:story -- --dry-run   # what would be posted
npm run seed:story                # Drive folder + every Slack message and DM (skips what's already there)
npm run backfill && npm run drive:backfill   # index it (or keep the server running with sync on)

npm run seed:jira -- --update     # Jira: create missing issues, rewrite existing ones to match seedData.ts
npm run jira:backfill             # index it
```

- Messages are posted **as their author**, so each of the four people must have clicked **Connect** once (`/connect`, in a browser signed in to Slack as them). Authors who haven't are listed at the end; run it again when they have.
- `-- --rewrite` also rewrites every Drive file from `seedContent.ts` after you edit it.
- Only one person needs to run it. Everyone else gets the data with `npm run backfill` and `npm run drive:backfill` using the shared `slack-tokens.json` and Drive token.
- Slack's timestamps are when the messages were posted, not story time. Nothing in the demo depends on them. Jira's are when the seed ran; run `seed:jira -- --update` around the same time as `seed:story` so the two don't look far apart.
- `seed:jira` without `--update` skips issues that already exist, so it won't pick up edits to `seedData.ts`. Don't delete an issue to redo it: Jira never reuses an issue number, so the key is lost.
- On a machine that ran an older story: set `DRIVE_ROOT_FOLDER_NAME=Company A` in `.env` and connect Drive as Carol (`npm run drive:connect`, check it prints `Connected as` Carol's address) before `drive:backfill`. Don't run `seed:drive` while Drive is connected as anyone else: it builds a second copy of the folder in that person's Drive.
