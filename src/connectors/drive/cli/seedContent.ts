// The demo story's Drive content, used by seed:drive and seed:story. What's in it and who sees what:
// docs/demo-data.md. The story: Company A's checkout broke one evening; Alice fixed it and wrote a postmortem,
// which Carol shared with Dave (Acme, the card processor) for follow-up work and then takes back.
//
// Rules: plain language, no dates (clock times only in the postmortem's timeline); each fact lives in one
// visibility tier; restricted files carry unique "canary" strings (M-3391, VULN-017, SGD 18,400, 99.95% ...) so
// a leak shows up in a simple text search; PDFs are ASCII only (minipdf); no real company names and nothing
// that looks like a real secret.
import type { Persona } from "../people.js";

export type Kind = "doc" | "sheet" | "slides" | "markdown" | "text" | "csv" | "json" | "pdf";
export type Slide = { title: string; body: string };

export type SeedFolder = { path: string[]; readers?: Persona[]; writers?: Persona[] };
export type SeedFile = {
  folder: string[];
  name: string;
  kind: Kind;
  readers?: Persona[]; // shared on the file itself, on top of what its folders give
  writers?: Persona[];
  body: string | Slide[];
};

// My Drive folders pass their shares down and a child can't drop them, so Engineering itself
// stays unshared: otherwise everyone in it could open Postmortems too.
export const FOLDERS: SeedFolder[] = [
  { path: ["Company"], readers: ["alice", "bob", "carol"] }, // all staff; Dave is external
  { path: ["Engineering"] },
  { path: ["Engineering", "Architecture"], readers: ["alice", "bob", "carol"] },
  { path: ["Engineering", "Runbooks"], readers: ["bob", "carol"], writers: ["alice"] },
  { path: ["Engineering", "Postmortems"], readers: ["alice", "carol"] },
  { path: ["Security"], readers: ["carol"] },
  { path: ["Vendors"], readers: ["carol"] },
  { path: ["Vendors", "Shared with Acme"], writers: ["dave"] }, // the external folder; Carol has it via Vendors
];

const ENG: Persona[] = ["alice", "bob", "carol"];

// ---- the runbook (S2: the live edit swaps the backup database and the pool size) ----

export const RUNBOOK_NAME = "Payment service runbook";

export function runbook(edited?: string): string {
  const reviewed = edited ? `Last updated ${edited} by Alice: pay-db-2 is retired.` : "Last updated by Alice after the checkout outage.";
  const promote = edited
    ? "pay-db-2 is retired. Switch to the backup database pay-db-3 and restart the payment API."
    : "Switch to the backup database pay-db-2 and restart the payment API.";
  const pool = edited ? 400 : 200;
  return `<h1>Payment service runbook</h1>
<p>Owner: Alice (payments team). Escalation: #payments-incident. ${reviewed}</p>
<h2>Symptoms</h2>
<p>Checkout errors, payment API latency above 2 seconds, or the alert that the payment database (pay-db-1) is running out of connections.</p>
<h2>Failover</h2>
<ol>
<li>Confirm the alert in the payments dashboard and page the on-call engineer.</li>
<li>Drain traffic from the main database pay-db-1.</li>
<li>${promote}</li>
<li>Check the connection pool size is at least ${pool} before restoring traffic.</li>
<li>Post an update in #payments-incident and on the status page.</li>
</ol>
<h2>Rollback</h2>
<p>Turn off the migration feature flag <code>tx_schema_v2</code> and redeploy the previous release.</p>`;
}

// ---- the postmortem (S4: Carol removes Dave's file-level share) ----

export const POSTMORTEM_NAME = "Payment outage postmortem";

const POSTMORTEM = `<h1>Payment outage postmortem</h1>
<p>Written by Alice. Severity: major. Blameless: this document describes systems and decisions, not people.</p>
<h2>Summary</h2>
<p>Card payments at checkout failed for 95 minutes one Saturday evening, from 19:40 to 21:15. 18% of checkout attempts failed: 1,842 failed payments. About SGD 310,000 of payments were delayed. Payouts were not affected.</p>
<h2>Timeline</h2>
<ul>
<li>The evening before: the migration flag tx_schema_v2 is switched on in production.</li>
<li>19:40: payment API latency alerts fire; checkout errors start.</li>
<li>19:52: Acme's support desk is paged in case the problem is on their side.</li>
<li>20:20: the on-call engineer finds the name of the backup database; the runbook didn't have it.</li>
<li>20:39: Acme answers the page. Their systems are fine.</li>
<li>20:48: failover to the backup database pay-db-2.</li>
<li>21:15: checkout success rate back to normal; incident resolved.</li>
</ul>
<h2>Root cause</h2>
<p>The database connection pool on pay-db-1 was exhausted after tx_schema_v2 was enabled. While the migration runs, every payment uses two connections instead of one, so the pool limit of 200 was reached at the dinner peak.</p>
<h2>What went well</h2>
<p>The failover itself took 8 minutes once started, and no payment data was lost.</p>
<h2>What went wrong</h2>
<ul>
<li>Finding the name of the backup database took 25 minutes. The runbook said "switch to the backup" without naming it.</li>
<li>Acme answered the page after 47 minutes; the agreement says 15. Acme is looking into it.</li>
<li>There was no alert for the pool filling up. The first alert was about latency, about 20 minutes later.</li>
</ul>
<h2>Affected merchants (confidential: incident team only)</h2>
<ul>
<li>M-1043 (food delivery platform): 312 failed payments, SGD 18,400 refunded.</li>
<li>M-2210 (travel agency): 207 failed payments, SGD 11,900 refunded.</li>
<li>M-0877 (electronics retailer): 158 failed payments, SGD 6,300 refunded.</li>
</ul>
<p>The full list is in Failed checkouts.csv in this folder. Refunds in total: SGD 82,200.</p>
<h2>Follow-up tickets</h2>
<ul>
<li>PAY-240: raise the connection limit from 200 to 400.</li>
<li>PAY-241: alert when the pool is more than 80% full for 5 minutes.</li>
<li>PAY-245: name the backup database in the runbook (done).</li>
</ul>`;

const FAILED_CHECKOUTS = `merchant_id,segment,failed_payments,refunded_sgd
M-1043,food delivery platform,312,18400
M-2210,travel agency,207,11900
M-0877,electronics retailer,158,6300
M-3391,online pharmacy,141,5200
M-1520,fashion marketplace,136,4900
M-0412,ride hailing,129,3100
M-2764,grocery delivery,124,4400
M-1988,event ticketing,118,7600
M-0655,furniture retailer,112,9800
M-3017,language school,104,2900
M-2482,beauty salon chain,101,2300
other (61 merchants),mixed,200,5400
total,,1842,82200
`;

// ---- the rest of Engineering ----

const HANDBOOK = `<h1>Incident response handbook</h1>
<p>Owner: Engineering. Applies to every production incident at Company A. Read this before your first on-call shift.</p>
<h2>Severity levels</h2>
<p><b>Major</b>: customers cannot pay, or card data may be exposed. Examples: checkout success rate below 90% for five minutes, the payment gateway is down, a suspected data breach. Page the incident lead immediately, at any hour.</p>
<p><b>Minor</b>: a feature is degraded but payments still succeed. Examples: refunds delayed, slow responses, one region failing over. Page the on-call engineer; they decide whether to escalate.</p>
<p><b>Low</b>: a small feature is broken or an internal tool is down, with a workaround. Handle during working hours.</p>
<p>If you are unsure between two levels, pick the higher one. It is always fine to downgrade later.</p>
<h2>Roles</h2>
<p><b>Incident lead</b>: owns the incident from start to finish. The lead does not debug; they coordinate, decide and keep the timeline. The on-call engineer is the lead until they hand over.</p>
<p><b>Communications</b>: posts updates to the status page and the #payments-incident channel, and briefs customer support. For a major incident, post an update every 30 minutes, even if nothing changed.</p>
<p><b>Scribe</b>: records decisions, actions and times, so the postmortem can be written from facts.</p>
<h2>Declaring an incident</h2>
<ol>
<li>Anyone can declare an incident. Post in #payments-incident with a one-line summary and a suggested severity.</li>
<li>The on-call engineer acknowledges within 5 minutes for a major incident, and becomes the incident lead.</li>
<li>The lead confirms the severity, assigns communications and a scribe, and posts the first update within 15 minutes.</li>
</ol>
<h2>Communication</h2>
<p>Internal updates go to the incident channel; customer-facing updates go to the status page. Never share customer names, card numbers or internal hostnames on the status page.</p>
<p>Customer support gets a short script from communications for major incidents, so they can answer tickets consistently.</p>
<h2>Payment-specific playbooks</h2>
<p><b>Card processor outage</b>: check Acme's status page and our gateway error rates. If Acme is failing, switch traffic to the backup processor with the payments_failover feature flag.</p>
<p><b>Payment database running out of connections</b>: follow the Payment service runbook in this folder. Drain traffic from pay-db-1, switch to the backup database, and check the connection pool size before restoring traffic.</p>
<p><b>Fraud spike</b>: if chargeback alerts fire or card-testing traffic appears, raise the risk score threshold in the fraud service and page the risk team.</p>
<h2>Escalation</h2>
<p>Escalate from the on-call engineer to the engineering manager after 30 minutes without a clear fix for a major incident. Escalate to the CTO for any suspected data breach, and involve the security team immediately. Vendor contacts are in the Vendors folder.</p>
<h2>After the incident</h2>
<p>Every major incident gets a blameless postmortem within 5 working days. The incident lead writes it. It covers the timeline, root cause, impact in numbers, what went well, and follow-up tickets.</p>
<p>Follow-ups are filed in the PAY Jira project with an owner and a due date. The engineering manager reviews open ones every Monday.</p>
<h2>On-call expectations</h2>
<p>The on-call rota is in the Engineering folder. On-call engineers keep their laptop and phone with them, stay within 15 minutes of an internet connection, and hand over on Monday mornings with a short note of open issues.</p>
<p>If you are paged overnight for a major incident, take the next morning off. Swaps are fine; update the rota and tell your manager.</p>`;

const HANDOVER = `On-call handover
From: Alice
To: Bob (his first week on call). Alice stays on as backup.

Open issues
- The database team plans to retire pay-db-2 after the storage refresh. Until the runbook says otherwise, failover still goes to pay-db-2.
- New alert: it pages the on-call engineer when the payment database connection pool is more than 80% full for 5 minutes. If it fires, start with the Payment service runbook.
- Customer support is still answering refund questions from the checkout outage. Nothing for on-call.

Tips for your first week
- The failover steps are in the Payment service runbook in this folder. Read them before your first shift.
- If Acme's support desk doesn't answer a page within 15 minutes, escalate to the Acme duty manager.
- Deploys go out on Tuesday and Thursday only.
`;

const ALERT_RULES = `${JSON.stringify(
  {
    service: "checkout-api",
    owner: "payments team",
    rules: [
      {
        name: "pool_saturation",
        description: "Pages the on-call engineer when the pay-db-1 connection pool is more than 80% full for 5 minutes. Added after the checkout outage.",
        metric: "db.pool.in_use_ratio",
        database: "pay-db-1",
        condition: "> 0.8 for 5m",
        severity: "minor",
        notify: "page on-call",
        runbook: "Engineering/Runbooks/Payment service runbook",
      },
      {
        name: "payment_api_latency",
        description: "Pages the on-call engineer when payment API latency is above 2 seconds for 5 minutes.",
        metric: "http.p99_latency_ms",
        condition: "> 2000 for 5m",
        severity: "minor",
        notify: "page on-call",
      },
      {
        name: "checkout_success_rate",
        description: "Pages the incident lead when fewer than 90% of checkouts succeed for 5 minutes.",
        metric: "checkout.success_ratio",
        condition: "< 0.9 for 5m",
        severity: "major",
        notify: "page incident lead",
      },
    ],
  },
  null,
  2,
)}\n`;

const ROTA = `Week,Primary,Backup,Notes
This week,Alice,Priya,Checkout outage on Saturday evening
Next week,Bob,Alice,Bob's first on-call week
Week 3,Marcus,Priya,
Week 4,Alice,Priya,
Week 5,Priya,Marcus,
Week 6,Bob,Alice,
Week 7,Marcus,Bob,11.11 sale week: payments deploy freeze`;

const README = `# Engineering handbook

Start here.

- Runbooks: Engineering/Runbooks (start with the Payment service runbook and the Incident response handbook).
- Postmortems: Engineering/Postmortems (incident team only).
- Architecture decisions: Engineering/Architecture.
- Alert rules for checkout-api: Payment alert rules.json in this folder.
- On-call rota: On-call rota in this folder.
- Payments dashboard: dashboards.companya.internal/payments

## Deploys

Deploys go out on Tuesday and Thursday. Payment changes need two reviewers.

## Tickets

Bugs and follow-ups go in the PAY Jira project.
`;

const ADR = `<h1>ADR-012: Short-lived tokens for the auth service</h1>
<p>Status: Accepted. Authors: Alice, Bob. Reviewers: Carol (security), Marcus.</p>
<h2>Context</h2>
<p>Merchants call the payments API with static API keys that never expire. Long-lived keys are hard to rotate and dangerous if one leaks: whoever has the key can take payments until someone notices.</p>
<h2>Decision</h2>
<ul>
<li>Merchants exchange their credentials for access tokens that live 15 minutes.</li>
<li>Refresh tokens live 24 hours, so long-running batch jobs refresh instead of using longer tokens.</li>
<li>Our 50 highest-volume merchants also use mutual TLS.</li>
<li>Static API keys are switched off once every merchant has moved.</li>
</ul>
<h2>Rollout</h2>
<p>Behind the feature flag auth_tokens_v1: 5% of merchants first, then 50%, then everyone.</p>
<h2>Consequences</h2>
<p>Merchant SDKs need an update, and customer support gets a migration guide.</p>
<h2>Alternatives considered</h2>
<p>60-minute tokens: simpler for batch jobs, but too long if a token leaks. Rotating static keys every 90 days: merchants forget, and a leaked key stays live for weeks.</p>`;

const MIGRATION = `<h1>Transactions database migration plan</h1>
<p>Owner: Alice. Database team: Priya. Feature flag: tx_schema_v2.</p>
<h2>Status</h2>
<p>Steps 1 and 2 are complete. The migration is paused after the checkout outage: tx_schema_v2 stays off until the connection pool changes are in production and tested.</p>
<p>Blocker: step 3 (backfill) is blocked by a schema lock on the transactions table (PAY-231).</p>
<h2>Steps</h2>
<ol><li>Create the new schema.</li><li>Write to both schemas behind tx_schema_v2.</li><li>Backfill historical rows.</li><li>Switch reads to the new schema and remove the old columns.</li></ol>
<h2>Rollback</h2>
<p>Turn off tx_schema_v2. The old schema stays authoritative until step 4, so rolling back loses no data.</p>`;

// ---- Security (Carol only) ----

const BREACH = `<h1>Security incident report: leaked API key</h1>
<p>Classification: restricted to the security team. Owner: Carol.</p>
<h2>Summary</h2>
<p>A live API key for the payment gateway was committed to a public code repository, payments-sdk-examples. An outside security researcher reported it the next morning. The key was revoked within the hour and every merchant key was re-issued. No fraudulent transactions were found.</p>
<h2>Root cause</h2>
<p>Merchant and service API keys are static and never expire, so a leaked key stays usable until someone notices.</p>
<h2>Actions</h2>
<ul>
<li>Secret scanning in CI for every repository (done).</li>
<li>Replace static keys with short-lived tokens (ADR-012).</li>
<li>Fix VULN-017 (token replay in the legacy auth service) before the next audit.</li>
</ul>`;

const VULNS = `ID,System,Issue,Severity,Status,Owner
CVE-2026-1234,auth service,Authentication bypass in a third-party library,High,Patch in progress,Carol
VULN-017,legacy auth service,Token replay: captured requests can be replayed for up to 24 hours,High,Open until ADR-012 ships,Alice
VULN-021,admin portal,Outdated TLS configuration,Medium,Fix scheduled,Marcus
VULN-024,payouts service,Error logs include full merchant bank details,Low,Accepted risk for now,Priya`;

// ---- Vendors ----

const RENEWAL = `<h1>Acme renewal notes</h1>
<p>Internal: Company A only. Do not share with Acme. Owner: Carol.</p>
<h2>Contract</h2>
<p>Acme Payments processes our card payments and provides round-the-clock second-line support. The contract renews yearly; the decision is due 45 days before the end of the term.</p>
<h2>Points for the renewal meeting</h2>
<ul>
<li>During the checkout outage, Acme's desk took 47 minutes to answer our page. The agreement says 15. Acme has added a second person to the night shift since.</li>
<li>Ask for monthly reporting on page response times, not just availability.</li>
</ul>
<h2>Options</h2>
<ul><li>Renew with the stricter response reporting.</li><li>Bring second-line support in-house: about 3 engineers, roughly USD 450,000 a year.</li></ul>`;

const SLA = `Vendor SLA agreement
Service level agreement between Company A Pte Ltd and Acme Payments Pte Ltd. Confidential: Company A and Acme only.
## 1. Services
Acme processes card payments for the Company A payment gateway and provides round-the-clock second-line support, including monitoring, incident response and monthly reporting.
## 2. Availability
Acme commits to 99.95% monthly availability of payment processing and of the support service.
## 3. Response times
Priority 1 (payments failing): first response within 15 minutes, then an update at least every 30 minutes until resolved.
Priority 2 (degraded service): first response within 1 hour.
Priority 3 (questions and minor issues): first response within 1 business day.
## 4. Service credits
Below 99.95% but at least 99.0% availability: a credit of 5% of that month's fee. Below 99.0%: 10%.
## 5. Reporting
Acme sends a monthly report to the Shared with Acme folder by the 5th working day of the following month, covering availability, response times and every Priority 1 incident.
## 6. Term
The agreement runs for 12 months and renews automatically unless either party gives 45 days' written notice before the end of the term.
## 7. Contacts
Acme: the support desk (24x7), and the Acme duty manager for escalations. Company A: Carol (security and compliance) for vendor management, and Marcus (payments engineering manager) for everything else.`;

const ACME_REPORT = `Acme Payments: monthly report for Company A
Prepared by Dave (Acme account engineer).
## Availability
Payment processing: 99.98%. Support service: 100%.
## Priority 1 incidents
1 incident: card payment errors at Company A checkout, one Saturday evening. Acme's systems were healthy throughout; the cause was on Company A's side. Acme's desk answered the page later than our commitment, and we have added a second person to the night shift.
## Priority 2 and 3
Priority 2: 2 tickets, both answered within 1 hour. Priority 3: 9 tickets, all answered within 1 business day.
## Next month
Planned maintenance on the 18th, 02:00 to 03:00 Singapore time. No downtime expected.`;

const ONBOARDING = `<h1>Vendor onboarding guide</h1>
<p>For contractors and vendors working with Company A.</p>
<h2>Access</h2>
<p>Vendors get the Company A Vendors Slack workspace and this folder. Anything else is shared with you for a specific piece of work and taken back when it's done. Request anything else through your Company A contact, Carol.</p>
<h2>Security rules</h2>
<p>Keep Company A data in this folder; don't copy it to your own company's systems. Report a suspected security incident to Carol within 1 hour.</p>
<h2>Reporting</h2>
<p>Upload the monthly report to this folder by the 5th working day of the following month.</p>`;

// ---- Company (all staff) ----

const EMPLOYEE_HANDBOOK = `<h1>Employee handbook</h1>
<p>For everyone at Company A. Questions go to the People team.</p>
<h2>Working hours and leave</h2>
<p>Core hours are 10:00 to 16:00 Singapore time. Annual leave is 18 days a year, plus public holidays. Book leave in the HR system at least two weeks ahead for anything longer than three days.</p>
<h2>Expenses</h2>
<p>Pay for work expenses with your Company A corporate card. Upload the receipt within 30 days.</p>
<h2>Security</h2>
<p>Annual security awareness training is due by the end of the month. Lock your laptop when you leave your desk, and never share passwords or one-time codes, even with IT.</p>
<h2>Equipment</h2>
<p>Laptops and accounts come from the IT helpdesk. See the IT helpdesk SLA for response times.</p>`;

const HELPDESK_SLA = `<h1>IT helpdesk SLA</h1>
<p>What to expect from the IT helpdesk. Open a ticket with the IT helpdesk form.</p>
<h2>Response times</h2>
<ul>
<li>Urgent (you can't work at all): first response within 1 business hour.</li>
<li>Laptop and account issues: first response within 4 business hours, fixed within 2 business days.</li>
<li>Requests (new software, accessories): within 5 business days.</li>
</ul>
<h2>Hours</h2>
<p>Monday to Friday, 09:00 to 18:00 Singapore time. Outside these hours, only urgent issues, by phone.</p>`;

const Q3_REVIEW: Slide[] = [
  { title: "Quarterly business review", body: "Company A all-hands" },
  {
    title: "Highlights",
    body: "Total payment volume up 18% on last quarter\n1,200 new SMB customers\nCorporate cards: per-employee spend limits and merchant-category blocking",
  },
  {
    title: "Reliability",
    body: "Checkout availability this quarter: 99.97%\nTransactions database migration: step 2 live",
  },
  {
    title: "How we work",
    body: "Engineering survey: engineers spend 31% of their week looking for information\nTop pain points: finding runbooks, knowing who decided what, docs scattered across tools",
  },
  {
    title: "Priorities for next quarter",
    body: "Short-lived auth tokens for merchants (ADR-012)\nFinish the transactions database migration\nSame-day USD payouts out of beta",
  },
];

export const FILES: SeedFile[] = [
  // Company: all staff (folder share)
  { folder: ["Company"], name: "Employee handbook", kind: "doc", body: EMPLOYEE_HANDBOOK },
  { folder: ["Company"], name: "Quarterly business review", kind: "slides", body: Q3_REVIEW },
  { folder: ["Company"], name: "IT helpdesk SLA", kind: "doc", body: HELPDESK_SLA },
  // Engineering: shared file by file (the folder itself isn't shared)
  { folder: ["Engineering"], name: "README.md", kind: "markdown", readers: ENG, body: README },
  { folder: ["Engineering"], name: "On-call rota", kind: "sheet", readers: ENG, body: ROTA },
  { folder: ["Engineering"], name: "DB migration plan", kind: "doc", readers: ENG, body: MIGRATION },
  { folder: ["Engineering"], name: "Payment alert rules.json", kind: "json", readers: ENG, body: ALERT_RULES },
  { folder: ["Engineering", "Architecture"], name: "ADR-012 Auth service tokens", kind: "doc", body: ADR },
  { folder: ["Engineering", "Runbooks"], name: RUNBOOK_NAME, kind: "doc", body: runbook() },
  { folder: ["Engineering", "Runbooks"], name: "Incident response handbook", kind: "doc", body: HANDBOOK }, // several chunks
  { folder: ["Engineering", "Runbooks"], name: "On-call handover.txt", kind: "text", body: HANDOVER },
  // Postmortems: incident team, plus Dave on the postmortem only (shared for Acme's follow-up; removed in S4)
  { folder: ["Engineering", "Postmortems"], name: POSTMORTEM_NAME, kind: "doc", readers: ["dave"], body: POSTMORTEM },
  { folder: ["Engineering", "Postmortems"], name: "Failed checkouts.csv", kind: "csv", body: FAILED_CHECKOUTS },
  // Security: Carol only
  { folder: ["Security"], name: "Security incident report", kind: "doc", body: BREACH },
  { folder: ["Security"], name: "Vulnerability register", kind: "sheet", body: VULNS },
  // Vendors: Carol; Shared with Acme adds Dave
  { folder: ["Vendors"], name: "Acme renewal notes", kind: "doc", body: RENEWAL },
  { folder: ["Vendors", "Shared with Acme"], name: "Vendor SLA agreement.pdf", kind: "pdf", body: SLA },
  { folder: ["Vendors", "Shared with Acme"], name: "Vendor onboarding guide", kind: "doc", body: ONBOARDING },
  { folder: ["Vendors", "Shared with Acme"], name: "Acme monthly report.pdf", kind: "pdf", body: ACME_REPORT },
];
