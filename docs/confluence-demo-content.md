# Confluence demo content

**Status:** written and **seeded 2026-10-07** with `npm run seed:confluence` (`HMA-Brain/src/connectors/confluence/cli/seedData.ts` mirrors section 4). All nine pages are on `hma-brain-demo.atlassian.net` with the restrictions in section 2, indexed as 12 chunks. Section 6 is done. Flags for the live beats: `--edit-rollout` / `--restore-rollout` (S2), `--restrict-drill` / `--unrestrict-drill` (S4); both verified. Note: a restriction change is picked up by the reconcile sweep, not the poll; the live re-check covers the gap.
Companion to [demo-story-and-mock-data.md](demo-story-and-mock-data.md) (the story, Slack and Drive) and [confluence-connector-plan.md](confluence-connector-plan.md) (the connector).

## 1. Rules

1. **Same story, same people.** The checkout outage of Sat 3 Oct 2026, Company A, Acme, Alice / Bob / Carol / Dave. Non-persona names allowed: Marcus (engineering manager), Priya (DBA).
2. **A document lives in Drive or in Confluence, never both.** Drive keeps the runbook, the postmortem, ADR-012, the incident response handbook, the rota, the vulnerability register. Confluence holds what a wiki holds: architecture, rollout plans, drill results, reviews, the vendor portal.
3. **Bob never learns the root cause (migration flag, pool exhaustion) or PAY-240 / PAY-241.** Every page Bob can see is written with that in mind.
4. **Dave never sees anything outside VEND**, and nothing he can see hints that a security review of Acme exists.
5. **No invented ticket keys.** Only keys that exist in Jira (PAY-231, PAY-240 to 245, PAY-252, SEC-1 to 3, VEND-1 to 5). Otherwise say "a follow-up in the PAY project".
6. **Every page restriction names group `brain-crawler`**, or the crawler can't index the page and nobody can find it.
7. Numbers that a model would guess wrong are the leak canaries: 6 min 40 s, 220 connections, 47 minutes, 31 March, 99.95%.

## 2. Spaces and access

| Key | Name | View (role Viewer) | Who that is |
|---|---|---|---|
| `ENG` | ENG | `payments-eng`, `security`, `brain-crawler` | Alice, Bob, Carol, crawler |
| `SEC` | SEC | `security`, `brain-crawler` | Carol, crawler |
| `VEND` | VEND (Acme vendor portal) | `vendors`, `security`, `brain-crawler` | Dave, Carol, crawler |

ENG and SEC exist. **VEND is new**: create it as Carol like the others (key `VEND`, Restricted, Knowledge base, then Users → add the three groups as Viewer). Trash the "Template - …" pages the template adds; the space overview pages ("ENG", "SEC", "VEND") can stay.

**Who sees what** (✅ sees · 🔒 sees because named in the restriction · ❌ doesn't):

| Page | Alice | Bob | Carol | Dave |
|---|---|---|---|---|
| ENG › Auth service tokens: rollout plan | ✅ | ✅ | ✅ | ❌ |
| ENG › Payments platform overview | ✅ | ✅ | ✅ | ❌ |
| ENG › Checkout failover drill results | ✅ | ✅ until S4, then ❌ | ✅ | ❌ |
| ENG › Postmortems (restricted parent) | 🔒 | ❌ | 🔒 | ❌ |
| ENG › Postmortems › Outage follow-up review (inherits) | 🔒 | ❌ | 🔒 | ❌ |
| SEC › Acme vendor security review | ❌ | ❌ | ✅ | ❌ |
| SEC › Access review: Q3 2026 | ❌ | ❌ | ✅ | ❌ |
| VEND › Acme integration guide | ❌ | ❌ | ✅ | ✅ |
| VEND › Escalation contacts | ❌ | ❌ | ✅ | ✅ |

## 3. What each scenario uses

| Scenario | Page(s) | Beat |
|---|---|---|
| **S1 unified query** | Rollout plan + Slack `#eng-auth` + Drive ADR-012 (+ Jira PAY-245 for the runbook question) | "What's the plan for rolling out the new auth tokens?" cites all three sources. |
| **S2 freshness** | Rollout plan | Alice edits the open question into a decision (section 5). Bob asks "how often are signing keys rotated" before and after. |
| **S3 negative case** | Acme vendor security review | Dave: "What did the security review of Acme find?" → nothing, no hint. Carol gets the findings. |
| **Inheritance** | Postmortems › Outage follow-up review | Bob asks about the follow-up review → nothing. Alice gets it, through the parent's restriction only. |
| **S4 live revocation** | Checkout failover drill results | Bob asks, gets the result. Carol restricts the page to Alice, Carol, `brain-crawler`. Bob asks again at once → nothing; audit shows *dropped by live re-check*. |
| **S5 audit** | all | "Everything Dave retrieved from Confluence" → VEND pages only, plus the SEC denial. |

Drive keeps its S2 (runbook) and S4 (Dave's postmortem share) beats. Confluence adds a second instance of each, which is what the brief's own examples describe ("a Confluence page is restricted", "the runbook owner pushed an update to the Confluence page").

## 4. The pages

Titles are exact; the connector and the golden questions use them. Body text is plain paragraphs and numbered lists; no macros, tables or images needed.

### 4.1 ENG › Auth service tokens: rollout plan *(exists as "Auth service token redesign: decision"; rename and replace, see section 6)*

Open. S1 and S2.

```
Owner: Bob. Reviewers: Alice, Marcus. Decision record: ADR-012 Auth service tokens (Engineering/Architecture in Drive, accepted 6 Oct 2026). Discussion: Slack #eng-auth.

What ADR-012 decided
Merchant API keys are replaced by short-lived access tokens (15 minutes) with refresh tokens, and server-to-server calls move to mTLS. This page is the rollout, not the decision.

Rollout
1. Week of 12 Oct: token service deployed to staging; Checkout sandbox merchants switched first.
2. Week of 19 Oct: production behind a per-merchant flag; the three largest Checkout merchants migrate with their account managers.
3. Week of 2 Nov: all new merchants get tokens only.
4. 31 Dec 2026: remaining static API keys are revoked.

Compatibility
Static keys and tokens are accepted side by side until the revocation date. The merchant dashboard shows a banner for every merchant still on a static key.

Open question
Signing key rotation interval: not decided yet. Bob to propose by the next sprint review.
```

### 4.2 ENG › Payments platform overview *(new)*

Open. Background for S1; gives Bob something real to ask about.

```
Last reviewed 6 Oct 2026 by Alice.

Products
Checkout (merchant payments API), Corporate cards, Payouts. Card processing is handled by Acme Payments, our processor and second-line support.

Services
payment-api (public, 3 pods), auth service (tokens for merchants and services), ledger, notification service.

Databases
The payment database is PostgreSQL. pay-db-1 is the primary. pay-db-2 was the standby until 6 Oct and is being retired; pay-db-3 is the new standby. The application connection pool is capped at 200 connections per environment.

Where things are
Runbooks and the incident response handbook: Drive, Engineering/Runbooks. Architecture decisions: Drive, Engineering/Architecture (ADR-012 is the latest). Tickets: Jira project PAY. Alerts: #payments in Slack.
```

(No root cause, no PAY-240.)

### 4.3 ENG › Checkout failover drill results *(exists; small edits in section 6)*

**Open before the demo.** Carol restricts it live for S4 (to Carol, Alice and group `brain-crawler`).

```
Drill date: 5 Oct 2026, 10:00 SGT. Run by: Alice. Observer: Carol.

Goal
Confirm the failover from pay-db-1 to the standby can be done in under 10 minutes, following the Payment service runbook as written.

Result
Failover completed in 6 minutes 40 seconds. The connection pool recovered to 220 connections within two minutes of restoring traffic.

Findings
1. The runbook step for draining connections was missing a wait; added.
2. The pool alert fired 90 seconds late because its threshold is on 5-minute averages.
3. The standby was 4 minutes behind the primary when promoted. Acceptable for a drill, not for production.

Follow-ups raised in the PAY project. Next drill: first week of November, run by Bob with Alice observing.
```

### 4.4 ENG › Postmortems *(new, restricted parent)*

Restriction: view only for Carol, Alice, group `brain-crawler`. Child pages inherit it.

```
Postmortems for the payments platform. Access is limited to the incident team and security. Ask Carol for access.

2026
- Outage follow-up review (3 Oct checkout outage)
```

### 4.5 ENG › Postmortems › Outage follow-up review *(new, child of 4.4, no restriction of its own)*

The inheritance demo. Full of things Bob must never see.

```
Review date: 7 Oct 2026. Chair: Marcus. Present: Alice, Carol, Priya.

Status of the postmortem actions
1. PAY-240, raise the connection limit from 200 to 400: shipped 6 Oct.
2. PAY-241, alert when the pool is more than 80% full: in review.
3. PAY-245, name the backup database in the runbook: done.
4. Migration flag tx_schema_v2: stays off in production until PAY-231 and PAY-252 are closed; target 23 Oct.

Decisions
- pay-db-2 is retired; pay-db-3 is the standby from 6 Oct.
- Connection pooling moves to a shared PgBouncer in front of the primary. Priya owns the design.
- Acme's 47-minute first response is raised with the vendor under the SLA; Carol owns it.

Cost of the outage
95 minutes of failed checkouts, 677 failed payments across three merchants, SGD 36,600 refunded. 25 of the 95 minutes were spent finding the right runbook and the replica name, which is the case for the internal knowledge project.
```

### 4.6 SEC › Acme vendor security review *(exists, keep)*

Open inside SEC. S3.

```
Review date: 30 Sep 2026. Reviewer: Carol. Vendor: Acme Payments (card processing).

Scope
Acme's support desk access, the shared incident timeline process, and the API credentials Acme holds for Company A.

Findings
1. Acme support agents share one login for the Company A merchant dashboard. High. Acme to issue individual accounts by 31 Oct.
2. Acme's first response to the 3 Oct page took 47 minutes against an SLA of 15. Medium. Credit requested under section 4.2 of the SLA.
3. Acme's API credentials for Company A were last rotated on 31 March 2026. Medium. Rotate by 15 Oct.

Conclusion
Continue with Acme for Q4. Re-review in January 2027 before the renewal decision.
```

### 4.7 SEC › Access review: Q3 2026 *(new)*

Open inside SEC. Carol only. Ties S4 and S5 together and holds the restricted reason behind the auth redesign (storyline B).

```
Reviewer: Carol. Period: July to September 2026, plus October changes to date.

Findings
1. A payment gateway API key was committed to a public repository in September (SEC-1, VULN-017). Revoked within two hours. This is the reason ADR-012 replaces static API keys with short-lived tokens; the ADR itself does not say so and should not.
2. The postmortem for the 3 Oct outage was shared with Dave (Acme) so Acme could check its side of the timeline (VEND-1). Access removed once Acme confirmed. Recorded here because the postmortem names the affected merchants.
3. CVE-2026-1234 in the auth service: patch in progress (SEC-2).

Standing rules
- Vendor staff get access to the VEND space in Confluence and the Vendors workspace in Slack only.
- Any share of internal content with a vendor is time-boxed and listed in this review.
```

### 4.8 VEND › Acme integration guide *(new)*

Open inside VEND. Dave's legitimate content.

```
For Acme Payments engineers working with Company A. Owner: Carol. Last updated 1 Oct 2026.

Environments
Sandbox: sandbox-api.companya.example, test merchant M-TEST-01. Production: api.companya.example, by allowlisted IP only.

Authentication
Acme's integration uses a dedicated service credential. From Q4 2026 it will be a short-lived token with mTLS, replacing the static key; Company A will send the migration date four weeks ahead.

Incident process
Company A pages Acme through the shared support desk for any P1 affecting card processing. Acme's SLA: first response within 15 minutes, updates every 30 minutes until resolved. Please acknowledge the page even if there is nothing to report yet.

Reports
Acme sends the monthly availability and response-time report to Carol by the 5th of each month (tracked in Jira VEND-2).
```

(No mention of the 47 minutes, the credit, or the review.)

### 4.9 VEND › Escalation contacts *(new)*

Open inside VEND.

```
Company A contacts for Acme Payments. Business hours are 09:00 to 18:00 SGT.

- Vendor relationship and security questions: Carol (Head of Security and Compliance).
- Payment incidents, first line: the engineer on call, via the shared support desk page. Do not contact engineers directly.
- Engineering manager: Marcus.

Acme contacts for Company A
- Account engineer: Dave.
- Acme support desk: the shared P1 queue (see the integration guide).
```

## 5. Live edits during the demo

| Beat | Who | Change | Reset afterwards |
|---|---|---|---|
| S2 | Alice (or Carol) | In 4.1 replace the "Open question" paragraph with: **"Decision (updated today): signing keys rotate every 24 hours, with a 1-hour overlap. Proposed by Bob, agreed at the 7 Oct sprint review."** | Put the open-question text back. |
| S4 | Carol | On 4.3: lock icon → Restricted → Carol, Alice, group `brain-crawler`, all "Can view". | Set it back to Open. |

Freshness note: the S2 edit becomes searchable after the poll (≤60 s) plus Confluence's own search-index lag. Measure it in rehearsal and quote the real number.

## 6. Changes to the three pages that already exist

1. **"Auth service token redesign: decision"** → rename to **"Auth service tokens: rollout plan"** and replace the body with 4.1. The old body contradicted ADR-012 (90-day tokens vs 15-minute tokens) and cited PAY-245, which is the runbook ticket.
2. **"Checkout failover drill results"** → replace the body with 4.3 (drops the invented PAY-246/247 and the explicit "pay-db-2") and **remove the restriction** so it is Open before the demo.
3. **"Acme vendor security review"** → change "last rotated in March 2026" to "last rotated on 31 March 2026" and "January 2026" to "January 2027".

## 7. Golden questions (add to the main set)

| Ask as | Question | Expected | Canary (must not appear for the wrong person) |
|---|---|---|---|
| Bob | What's the plan for rolling out the new auth tokens? | The four rollout steps, citing the Confluence page, ADR-012 in Drive and the `#eng-auth` thread. | — |
| Bob | How often are signing keys rotated? | Before S2: not decided yet. After: every 24 hours with a 1-hour overlap. | — |
| Bob | Which database is the standby for payments now? | pay-db-3 (overview page). | — |
| Bob, then Alice | What did the outage follow-up review decide? | Bob: no information. Alice: PgBouncer, pay-db-2 retired, Acme raised under the SLA. | "PgBouncer", "SGD 36,600", "PAY-240" |
| Bob, then Carol restricts, then Bob | How long did the last failover drill take? | Before: 6 minutes 40 seconds. After: no information; audit shows dropped by live re-check. | "6 minutes 40" |
| Dave, then Carol | What did the security review of Acme find? | Dave: no information. Carol: shared login, 47 minutes, credentials rotated 31 March. | "shared login", "47 minutes", "31 March" |
| Dave | What is Acme's SLA for a P1 page? | 15 minutes first response, updates every 30 minutes (integration guide; the Drive SLA PDF says the same). | — |
| Dave | Who do I contact at Company A about a security question? | Carol. | — |
| Alice | Why did we move away from static API keys? | ADR-012's stated reason (hard to rotate, dangerous if leaked). **Not** the September leak, which is in SEC. | "public repository", "SEC-1", "VULN-017" |
| Carol | Which internal documents were shared with a vendor this quarter? | The postmortem, shared with Dave for VEND-1, access since removed. | — |

## 8. `seed:confluence`

Built 7 Oct. Runs as Carol (`JIRA_ADMIN_EMAIL` + `JIRA_ADMIN_API_TOKEN` or `CAROL_JIRA_API_TOKEN`). Creates missing spaces with their viewer groups (and the admin as space Admin), creates, renames or rewrites pages to match `seedData.ts` (a content hash in the page's version message makes re-runs no-ops), sets or clears view restrictions, and trashes template pages. `--dry-run` prints the plan. Live beats: `--edit-rollout` / `--restore-rollout`, `--restrict-drill` / `--unrestrict-drill`. After any run: `npm run confluence:backfill` (or wait for the poll; after a restriction flag, `npm run confluence:poll -- --sweep`).
