// The Confluence demo content: three spaces and nine pages for the checkout-outage story.
// Spec and reasoning: docs/confluence-demo-content.md. seed.ts mirrors this file; edit here, then `seed:confluence`.
//
// Rules (from the spec): a document lives in Drive OR Confluence; Bob never sees the root cause or PAY-240/241;
// Dave sees VEND only; no invented ticket keys; every page restriction names group `brain-crawler`.

export type PersonaKey = "carol" | "alice" | "bob" | "dave";

export type SpaceSpec = { key: string; name: string; viewers: string[] }; // groups with the Viewer role
export const SPACES: SpaceSpec[] = [
  { key: "ENG", name: "ENG", viewers: ["payments-eng", "security", "brain-crawler"] },
  { key: "SEC", name: "SEC", viewers: ["security", "brain-crawler"] },
  { key: "VEND", name: "VEND", viewers: ["vendors", "security", "brain-crawler"] },
];

export type Restriction = { users: PersonaKey[]; groups: string[] }; // view restriction; `carol` also keeps edit
export type PageSpec = {
  space: string;
  title: string;
  renameFrom?: string[]; // earlier titles of the same page (hand-made before the seed existed)
  parent?: string; // title of the parent page in the same space; default: the space home page
  restrict?: Restriction;
  body: string; // plain text: blank-line blocks; "1. " lists; "- " bullets; a short first line is a heading
};

export const ROLLOUT_TITLE = "Auth service tokens: rollout plan";
export const DRILL_TITLE = "Checkout failover drill results";

// S2: the paragraph Alice replaces live, and what it becomes.
export const ROLLOUT_OPEN_QUESTION = "Open question\nSigning key rotation interval: not decided yet. Bob to propose by the next sprint review.";
export const ROLLOUT_DECIDED = "Decision (updated today)\nSigning keys rotate every 24 hours, with a 1-hour overlap. Proposed by Bob, agreed at the 7 Oct sprint review.";

// S4: the restriction Carol applies live to the drill page.
export const DRILL_RESTRICTION: Restriction = { users: ["carol", "alice"], groups: ["brain-crawler"] };

const POSTMORTEMS_TITLE = "Postmortems";

export const PAGES: PageSpec[] = [
  {
    space: "ENG",
    title: ROLLOUT_TITLE,
    renameFrom: ["Auth service token redesign: decision"],
    body: `Owner: Bob. Reviewers: Alice, Marcus. Decision record: ADR-012 Auth service tokens (Engineering/Architecture in Drive, accepted 6 Oct 2026). Discussion: Slack #eng-auth.

What ADR-012 decided
Merchant API keys are replaced by short-lived access tokens (15 minutes) with refresh tokens, and server-to-server calls move to mTLS. This page is the rollout, not the decision.

Rollout
1. Week of 12 Oct: token service deployed to staging; Checkout sandbox merchants switched first.
2. Week of 19 Oct: production behind a per-merchant flag; the three largest Checkout merchants migrate with their account managers.
3. Week of 2 Nov: all new merchants get tokens only.
4. 31 Dec 2026: remaining static API keys are revoked.

Compatibility
Static keys and tokens are accepted side by side until the revocation date. The merchant dashboard shows a banner for every merchant still on a static key.

${ROLLOUT_OPEN_QUESTION}`,
  },
  {
    space: "ENG",
    title: "Payments platform overview",
    body: `Last reviewed 6 Oct 2026 by Alice.

Products
Checkout (merchant payments API), Corporate cards, Payouts. Card processing is handled by Acme Payments, our processor and second-line support.

Services
payment-api (public, 3 pods), auth service (tokens for merchants and services), ledger, notification service.

Databases
The payment database is PostgreSQL. pay-db-1 is the primary. pay-db-2 was the standby until 6 Oct and is being retired; pay-db-3 is the new standby. The application connection pool is capped at 200 connections per environment.

Where things are
Runbooks and the incident response handbook: Drive, Engineering/Runbooks. Architecture decisions: Drive, Engineering/Architecture (ADR-012 is the latest). Tickets: Jira project PAY. Alerts: #payments in Slack.`,
  },
  {
    space: "ENG",
    title: DRILL_TITLE,
    // Open before the demo; Carol restricts it live (S4). `--restrict-drill` / `--unrestrict-drill` do the same.
    body: `Drill date: 5 Oct 2026, 10:00 SGT. Run by: Alice. Observer: Carol.

Goal
Confirm the failover from pay-db-1 to the standby can be done in under 10 minutes, following the Payment service runbook as written.

Result
Failover completed in 6 minutes 40 seconds. The connection pool recovered to 220 connections within two minutes of restoring traffic.

Findings
1. The runbook step for draining connections was missing a wait; added.
2. The pool alert fired 90 seconds late because its threshold is on 5-minute averages.
3. The standby was 4 minutes behind the primary when promoted. Acceptable for a drill, not for production.

Follow-ups raised in the PAY project. Next drill: first week of November, run by Bob with Alice observing.`,
  },
  {
    space: "ENG",
    title: POSTMORTEMS_TITLE,
    restrict: { users: ["carol", "alice"], groups: ["brain-crawler"] },
    body: `Postmortems for the payments platform. Access is limited to the incident team and security. Ask Carol for access.

2026
- Outage follow-up review (3 Oct checkout outage)`,
  },
  {
    space: "ENG",
    title: "Outage follow-up review",
    parent: POSTMORTEMS_TITLE, // inherits the parent's restriction; none of its own
    body: `Review date: 7 Oct 2026. Chair: Marcus. Present: Alice, Carol, Priya.

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
95 minutes of failed checkouts, 677 failed payments across three merchants, SGD 36,600 refunded. 25 of the 95 minutes were spent finding the right runbook and the replica name, which is the case for the internal knowledge project.`,
  },
  {
    space: "SEC",
    title: "Acme vendor security review",
    body: `Review date: 30 Sep 2026. Reviewer: Carol. Vendor: Acme Payments (card processing).

Scope
Acme's support desk access, the shared incident timeline process, and the API credentials Acme holds for Company A.

Findings
1. Acme support agents share one login for the Company A merchant dashboard. High. Acme to issue individual accounts by 31 Oct.
2. Acme's first response to the 3 Oct page took 47 minutes against an SLA of 15. Medium. Credit requested under section 4.2 of the SLA.
3. Acme's API credentials for Company A were last rotated on 31 March 2026. Medium. Rotate by 15 Oct.

Conclusion
Continue with Acme for Q4. Re-review in January 2027 before the renewal decision.`,
  },
  {
    space: "SEC",
    title: "Access review: Q3 2026",
    body: `Reviewer: Carol. Period: July to September 2026, plus October changes to date.

Findings
1. A payment gateway API key was committed to a public repository in September (SEC-1, VULN-017). Revoked within two hours. This is the reason ADR-012 replaces static API keys with short-lived tokens; the ADR itself does not say so and should not.
2. The postmortem for the 3 Oct outage was shared with Dave (Acme) so Acme could check its side of the timeline (VEND-1). Access removed once Acme confirmed. Recorded here because the postmortem names the affected merchants.
3. CVE-2026-1234 in the auth service: patch in progress (SEC-2).

Standing rules
- Vendor staff get access to the VEND space in Confluence and the Vendors workspace in Slack only.
- Any share of internal content with a vendor is time-boxed and listed in this review.`,
  },
  {
    space: "VEND",
    title: "Acme integration guide",
    body: `For Acme Payments engineers working with Company A. Owner: Carol. Last updated 1 Oct 2026.

Environments
Sandbox: sandbox-api.companya.example, test merchant M-TEST-01. Production: api.companya.example, by allowlisted IP only.

Authentication
Acme's integration uses a dedicated service credential. From Q4 2026 it will be a short-lived token with mTLS, replacing the static key; Company A will send the migration date four weeks ahead.

Incident process
Company A pages Acme through the shared support desk for any P1 affecting card processing. Acme's SLA: first response within 15 minutes, updates every 30 minutes until resolved. Please acknowledge the page even if there is nothing to report yet.

Reports
Acme sends the monthly availability and response-time report to Carol by the 5th of each month (tracked in Jira VEND-2).`,
  },
  {
    space: "VEND",
    title: "Escalation contacts",
    body: `Company A contacts for Acme Payments. Business hours are 09:00 to 18:00 SGT.

- Vendor relationship and security questions: Carol (Head of Security and Compliance).
- Payment incidents, first line: the engineer on call, via the shared support desk page. Do not contact engineers directly.
- Engineering manager: Marcus.

Acme contacts for Company A
- Account engineer: Dave.
- Acme support desk: the shared P1 queue (see the integration guide).`,
  },
];

// Pages the space template adds; the seed trashes them so they don't show up as answers.
export const TRASH_TITLE_PREFIX = "Template - ";
