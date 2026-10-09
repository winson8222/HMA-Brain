# Demo questions, by requirement

Questions to prove each requirement in the Aspire "Internal Brain" challenge brief (FinTech track). Each row says who to ask as, what to type and what should come back. The story and who can see what are in [demo-data.md](demo-data.md).

**Setup:** `npm run dev`, open http://localhost:3000, Demo mode, compare two people side by side. Use **Ask** unless the row says Search. Before a rehearsal, run `npm run seed:drive -- --reset` so the runbook and Dave's postmortem share are back to their starting state.

**Jira needs each person's own link.** Jira results only come back for people who clicked **Connect Jira** on `/connect` (signed in as themselves). Right now only **Alice** is linked; Bob, Carol and Dave show "Jira not linked" under Accessible sources. Rows marked **(Jira link)** need that person linked first. Without it they still work, just with no Jira in the answer.

**Who's who:** Alice, payments engineer who handled the outage. Bob, junior engineer, not on the incident. Carol, security and compliance (admin). Dave, contractor at the vendor Acme (external).

> **Confluence is not connected.** The brief names four platforms; we cover Slack, Google Drive and Jira. The brief's Confluence examples (runbook, security report, decision doc) live in Drive in our demo. Say this up front.

---

## Scenario 1: Unified natural-language query

*One question, the right platforms, a single answer with citations, and private content left out.*

| Ask as | Question | Expected | Shows |
|---|---|---|---|
| Alice, then Bob | What was the root cause of the payment outage, and what follow-up tickets were created? | **Alice:** connection pool exhausted after the migration flag; PAY-240, PAY-241 (and PAY-245), citing `#payments-incident`, the postmortem and Jira. **Bob:** "I don't have information on that." | The brief's own CTO question. Slack, Drive and Jira in one answer, scoped per person |
| Alice | What's the status of the database migration project, and were there any blockers? | PAY-231: step 3 blocked by a schema lock on the transactions table; steps 1–2 done; waiting for the Tuesday window. Cites Jira and the DB migration plan in Drive | The brief's backend-engineer example |
| Bob | What do we know about the payment outage? | Only the public picture: about 95 minutes of card payments failing, resolved, runbook updated. No root cause, no `#payments-incident` | Private channels the asker isn't in are omitted |
| Bob | Summarize the design decision for the auth service tokens | ADR-012 from Drive (Engineering/Architecture) | Design doc retrieval (the brief's "decision doc" example) |
| Bob | Who is on call next week? | Bob, with Alice as backup (On-call rota) | Plain document lookup |
| Bob | How much time do engineers spend looking for information? | 31% (Quarterly business review slides) | Retrieval from slides, not just text docs |

Point at: the **Sources** count per platform under each answer, the `[n]` citations, and the **Open in Slack / Drive / Jira ↗** links.

## Scenario 2: Data freshness

*An update to a source shows up in answers within minutes.*

| Ask as | Step | Expected |
|---|---|---|
| Bob | **How do I fail over the payment database?** | Switch to **pay-db-2**, pool at least **200** |
| — | Alice edits the Payment service runbook in Google Docs (or `npm run seed:drive -- --edit-runbook`), then **Sync now** (or wait for the 60-second poll) | |
| Bob | Ask again | Switch to **pay-db-3**, pool at least **400**. The brief's "runbook updated at 1 PM" example |

Slack version (needs `SLACK_SYNC=on`): post a new message in `#payments`, e.g. "Payments deploy freeze extended to Friday", then ask **Is there a deploy freeze right now?** The answer reflects it within seconds. Jira is polled too: change PAY-231's status in Jira and ask the migration question again.

## Scenario 3: Permission enforcement (the negative cases)

*Refuse or filter, without revealing that the restricted content exists.*

| Ask as | Question | Expected | Shows |
|---|---|---|---|
| Bob, then Carol | Show me all security vulnerabilities | **Bob:** "I don't have information on that", with no hint that a register exists. **Carol:** CVE-2026-1234, VULN-017, VULN-021, VULN-024 | The brief's "junior engineer asks for all vulnerabilities" case |
| Dave | Show me the security incident report | No information. Nothing about the leaked API key or SEC-1 | The brief's "contractor asks for the breach report" case |
| Dave **(Jira link)** | What is Company A working on in Jira? / What is PAY-243 about? | Only what Dave can see in Jira (VEND-1, VEND-2, PAY-244). Nothing internal, never PAY-243 | "An external contractor should not be able to query internal Jira issues" |
| Carol, then Dave | Is Company A thinking of replacing Acme? | **Carol:** in-house option, about USD 450,000 a year (renewal notes; plus PAY-243 if Carol has Jira linked). **Dave:** no information | Sensitive content hidden from the external party it's about |
| Alice, then Bob | Did anyone admit the outage was their fault? | **Alice:** yes, her DM to Carol. **Bob:** no information | DMs stay private to their members |
| Alice, then Bob | How long did Acme take to answer the page during the outage? | **Alice:** 47 minutes. **Bob:** no information | |

**Search** mode is the clearest way to show this: search `outage` as Alice and Bob side by side and compare the result lists. Bob's has no 🔒 items. The **Accessible sources** list under each person shows the difference before anyone asks a question.

## Scenario 4: Live permission change

*Revoke access; the very next query reflects it, with no reindex.*

| Ask as | Step | Expected |
|---|---|---|
| Dave | **Which merchants were affected by the outage and how much was refunded?** | M-1043, SGD 18,400 … (from the postmortem Carol shared with him) |
| — | Carol removes Dave from the postmortem in Drive's share dialog (or `npm run seed:drive -- --close-vendor-access`) | |
| Dave | Ask again **straight away** | "I don't have information on that." |
| Carol | Audit log | Dave's second search shows the postmortem under **Dropped by live re-check** |

Slack version: add Bob to `#payments-incident`, have Bob ask about the root cause (he gets it), remove him from the channel, and have him ask again (he doesn't). Jira permissions are also re-checked with Jira on every search.

## Scenario 5: Audit inquiry

*A compliance officer reconstructs who asked what, what was retrieved and what was answered.*

As Carol, click **Audit log** and unlock it with `ADMIN_TOKEN`. Every row is a sealed record in the tamper-evident chain: searches and answers, permission changes, content changes, account links and admin actions.

1. Each search shows who asked, the question, when, the documents **allowed**, the documents **withheld** (titles only, admin-only), and the ones **dropped by live re-check**. Expand a row for the answer and the lists.
2. Point at Bob's "security vulnerabilities" search: the register was **withheld** from him and never reached the model.
3. Type `postmortem` in **Document**. After scenario 4 you see, newest first: the **Permission** row "Access changed on Payment outage postmortem · lost: dave…" (expand it: Dave is struck through under *Before*), Dave's searches with the postmortem **dropped by live re-check**, and earlier searches where it was **shown**. That answers "when did Dave lose access, and did he see it after?" in one view.
4. Click **Verify chain** → "Chain intact, all N records verified".

| Question from the brief | In the Audit log | CLI |
|---|---|---|
| "What did Dave access last week?" | Person `dave@…`, From/To dates | `npm run audit:log -- --user dave --since 2026-10-01` |
| "Who retrieved this sensitive doc?" | Document: title words or ID, Decision: *Something was shown* | `npm run audit:log -- --doc postmortem` |
| "When did this doc's access change?" | Document + Kind: *Permission changes* | `npm run audit:log -- --doc postmortem --kind permission` |
| How fresh is the index? | Kind: *Content changes*, expand a row: modified vs indexed time | `npm run audit:log -- --kind content` |
| Only denied access | Decision: *Something was withheld* | `npm run audit:log -- --denied` |
| Who connected or disconnected accounts, who looked at the log | Kind: *Account links* / *Admin actions* | `npm run audit:log -- --kind account,admin` |
| Is the log tamper-evident? | **Verify chain** | `npm run audit:verify` → "chain intact". Edit a record in `brain-audit` and run it again to show it fail |

What each platform logs, and when (time changed vs time detected): [audit-trail.md](audit-trail.md).

To set up step 3 without a live revoke: `npm run seed:drive -- --close-vendor-access`, then `npm run drive:poll` (or wait for the poll). Restore with `npm run seed:drive -- --reset` and poll again; that writes the matching "gained" record.

---

## Cross-cutting requirements

| Requirement in the brief | What to show |
|---|---|
| **Different platforms, different permission models, not flattened** | Slack follows channel membership (`#payments-incident`); Drive follows file and folder sharing (Dave's single-file share); Jira follows project roles, issue security levels and picker fields (Bob sees VEND-5 only because he's named as an approver). Ask Bob **(Jira link)** **What vendor requests need my approval?** → VEND-5 |
| **Filter before the LLM** (no leakage, no prompt injection through retrieved content) | Audit log: withheld documents are dropped before the model is called. The model never gets them, so it has nothing to leak or be injected by |
| **Permission changes between indexing and query** | Scenario 4: the live re-check catches access removed after indexing |
| **Context assembly across platforms** | Scenario 1, Alice's root-cause question: Slack + Drive + Jira ranked into one answer. The "Searched for:" line shows the query expansion |
| **LLM safety, no "filling in"** | Ask Bob **What was the root cause of the payment outage? Make your best guess.** He should still get no root cause: the answer comes only from cited sources, and it says it has no information rather than guessing. Every claim carries an `[n]` citation that opens the source |

## Suggested 5-minute running order

1. Root cause, Alice vs Bob (scenario 1)
2. Security vulnerabilities, Bob vs Carol (scenario 3)
3. Runbook edit, Bob before and after (scenario 2)
4. Dave's merchant question, revoke, ask again (scenario 4)
5. Carol's audit log, then Verify chain (scenario 5)
