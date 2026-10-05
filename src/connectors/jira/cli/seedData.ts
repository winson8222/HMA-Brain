// The Jira demo data that `npm run seed:jira` creates. It mirrors docs/jira-mock-data-plan.md: change both together.
//
// ---- Scenario description ----
//
// Company A runs a payments platform. Alice enabled the `tx_schema_v2` migration flag for the transactions
// database. While the migration runs, every payment holds two connections, so one Saturday evening the pay-db-1
// connection pool ran out and 18% of checkouts failed between 19:40 and 21:15. Acme's support desk took 47 minutes
// to answer the page. The same story is told in Slack (#payments, #payments-incident, #acme-support) and Drive
// (postmortem, runbooks); see docs/demo-data.md. Jira holds the tickets:
//
//   PAY (Payments Engineering): the migration step that's blocked (PAY-231), the postmortem follow-ups,
//     restricted to the incident team (PAY-240 connection limit, PAY-241 alerting, PAY-245 runbook), a SEV4 near miss (PAY-242), the leadership-only cost estimate for
//     bringing second-line support in-house instead of renewing Acme (PAY-243), and the P1 webhook to Acme (PAY-244).
//   SEC (Security): Carol's leaked API key (SEC-1) and CVE-2026-1234 patch (SEC-2), both restricted to the
//     security team, and a phishing email Bob reported (SEC-3).
//   VEND (Vendor Requests): Acme's requests via Dave (outage timeline VEND-1, monthly report VEND-2),
//     the internal renewal review (VEND-3), Alice checking Acme's side of the timeline (VEND-4), and
//     Acme's dashboard access request that Bob must approve (VEND-5).
//
// Who sees what, and which permission mechanism shows it:
//   Alice (payments engineer, led the incident): PAY through the Engineers role (via group payments-eng),
//     including the follow-ups (member of security level "Incident team"), except PAY-243 (level "Leadership
//     only"). VEND-4 only, as its assignee. No SEC.
//   Bob (engineer, new, not on the incident team): PAY through the Engineers role, but not the follow-ups or
//     PAY-243 (not in either level), so he never learns the root cause or the tickets. SEC-3 only, as its
//     reporter. VEND-5 only, because he's named in its Approvers picker field. Never SEC-1/SEC-2.
//   Carol (security lead, admin): everything. SEC and VEND through group security; PAY through the Engineers
//     role as a single user; the follow-ups and PAY-243 as a member of both PAY levels.
//   Dave (Acme contractor): VEND-1 and VEND-2 as their reporter, and PAY-244 because group vendors is its
//     Owning team (group picker field). Being in group vendors grants nothing else. Never VEND-3 or anything internal.
//   Nobody: Carol's comment on PAY-240, restricted to the Administrators role. The connector never indexes it.
//   Crawler (service account): browses everything (group brain-crawler is in every grant and every security
//     level) so the connector can index it; not a person in the story.

export type PersonaKey = "carol" | "alice" | "bob" | "dave" | "crawler";
export const PERSONA_NAMES: Record<PersonaKey, string> = { carol: "Carol", alice: "Alice", bob: "Bob", dave: "Dave", crawler: "HMA Brain crawler" };

export const GROUPS: Record<string, PersonaKey[]> = {
  "payments-eng": ["alice", "bob"],
  security: ["carol"],
  vendors: ["dave"],
  "brain-crawler": ["crawler"],
};

export const ROLES = { admins: "Administrators", engineers: "Engineers" } as const;
export const NEW_ROLES = [{ name: ROLES.engineers, description: "Engineers who work on this project" }];

export type FieldKey = "approvers" | "owningTeam";
export const FIELDS: Record<FieldKey, { name: string; description: string; type: string; searcherKey: string; project: string }> = {
  approvers: {
    name: "Approvers",
    description: "People who must approve this request. Being named here lets them see the issue.",
    type: "com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker",
    searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher",
    project: "VEND",
  },
  owningTeam: {
    name: "Owning team",
    description: "The team that owns this work. Members of the group named here can see the issue.",
    type: "com.atlassian.jira.plugin.system.customfieldtypes:grouppicker",
    searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:grouppickersearcher",
    project: "PAY",
  },
};

export type Actor = { user: PersonaKey } | { group: string };
export type ProjectSpec = { key: string; name: string; roles: Record<string, Actor[]> };
export const PROJECTS: ProjectSpec[] = [
  { key: "PAY", name: "Payments Engineering", roles: { [ROLES.admins]: [{ user: "carol" }], [ROLES.engineers]: [{ group: "payments-eng" }, { user: "carol" }] } },
  { key: "SEC", name: "Security", roles: { [ROLES.admins]: [{ user: "carol" }], [ROLES.engineers]: [] } },
  { key: "VEND", name: "Vendor Requests", roles: { [ROLES.admins]: [{ user: "carol" }], [ROLES.engineers]: [] } },
];

// A permission grant, by name; seed.ts turns it into Jira's holder shape.
export type Grant = { role: string } | { group: string } | { user: PersonaKey } | "reporter" | "assignee" | { userField: FieldKey } | { groupField: FieldKey };
const admins: Grant = { role: ROLES.admins };
const engineers: Grant = { role: ROLES.engineers };
const crawler: Grant = { group: "brain-crawler" };

// Day-to-day work (edit, move, assign, ...): who works on the project's issues.
const WORK = ["EDIT_ISSUES", "TRANSITION_ISSUES", "ASSIGN_ISSUES", "RESOLVE_ISSUES", "SCHEDULE_ISSUES", "LINK_ISSUES", "CREATE_ATTACHMENTS", "EDIT_OWN_COMMENTS"];
// Admin-only housekeeping. DELETE_ISSUES lets the seed remove its counter placeholders.
const ADMIN_ONLY = ["ADMINISTER_PROJECTS", "MODIFY_REPORTER", "SET_ISSUE_SECURITY", "DELETE_ISSUES", "EDIT_ALL_COMMENTS", "DELETE_ALL_COMMENTS"];

function scheme(browse: Grant[], create: Grant[], assignable: Grant[], comment: Grant[], workers: Grant[]): Record<string, Grant[]> {
  return {
    BROWSE_PROJECTS: browse,
    CREATE_ISSUES: create,
    ASSIGNABLE_USER: assignable,
    ADD_COMMENTS: comment,
    ...Object.fromEntries(WORK.map((p) => [p, workers])),
    ...Object.fromEntries(ADMIN_ONLY.map((p) => [p, [admins]])),
  };
}

// Browse Projects is the row the connector reads; the rest only has to make the seeded story possible.
export const PERMISSION_SCHEMES: Record<string, { name: string; grants: Record<string, Grant[]> }> = {
  PAY: {
    name: "PAY permission scheme",
    grants: scheme([engineers, crawler, { groupField: "owningTeam" }], [engineers, admins], [engineers], [engineers, admins], [engineers, admins]),
  },
  SEC: {
    name: "SEC permission scheme",
    grants: scheme([{ group: "security" }, "reporter", crawler], [admins, { group: "payments-eng" }], [admins], [admins, "reporter"], [admins]),
  },
  VEND: {
    name: "VEND permission scheme",
    grants: scheme(
      [{ group: "security" }, "reporter", "assignee", { userField: "approvers" }, crawler],
      [admins, { group: "vendors" }],
      [admins, { group: "payments-eng" }],
      [admins, "reporter", "assignee"],
      [admins],
    ),
  },
};

export type Member = { user: PersonaKey } | { group: string };
export type LevelSpec = { level: string; description: string; members: Member[] };
export const SECURITY_SCHEMES: Record<string, { name: string; levels: LevelSpec[] }> = {
  SEC: {
    name: "SEC security",
    levels: [{ level: "Security team only", description: "Carol and the security team", members: [{ group: "security" }, { group: "brain-crawler" }] }],
  },
  PAY: {
    name: "PAY security",
    levels: [
      { level: "Leadership only", description: "Leadership only", members: [{ user: "carol" }, { group: "brain-crawler" }] },
      { level: "Incident team", description: "The people who worked the checkout outage", members: [{ user: "alice" }, { user: "carol" }, { group: "brain-crawler" }] },
    ],
  },
};

export type Comment = { by: PersonaKey; text: string; restrictedToRole?: string };
export type IssueSpec = {
  key: string;
  type: "Task" | "Bug";
  summary: string;
  description: string;
  status: "To Do" | "In Progress" | "Done";
  assignee: PersonaKey | null;
  reporter: PersonaKey;
  labels: string[];
  level?: string; // a security level of the project's scheme
  approvers?: PersonaKey[];
  owningTeam?: string; // group name
  comments: Comment[];
};

export const ISSUES: IssueSpec[] = [
  // ---- PAY ----
  {
    key: "PAY-231",
    type: "Task",
    summary: "Migration step 3 blocked: schema lock on transactions table",
    description:
      "Step 3 of the transactions DB migration (backfill historical rows) is blocked by a schema lock on the `transactions` table. Steps 1 and 2 are complete. The lock is held while dual-write behind the `tx_schema_v2` flag is running.\n\nRollback: turn off `tx_schema_v2`; the old schema stays authoritative until step 4. Plan: Drive → Engineering → DB migration plan.",
    status: "In Progress",
    assignee: "alice",
    reporter: "alice",
    labels: ["blocked", "db-migration"],
    comments: [
      { by: "alice", text: "The lock is held by the dual-write job. Waiting for the Tuesday maintenance window to pause it and finish step 3." },
      { by: "bob", text: "Is there anything I can pick up on this?" },
      { by: "alice", text: "Not yet, the migration is paused for now. I'll ping you when step 3 is ready to run." },
    ],
  },
  {
    key: "PAY-240",
    type: "Task",
    summary: "Raise the payment database connection limit from 200 to 400",
    description:
      "Follow-up from the checkout outage. Root cause: the database connection pool on pay-db-1 was exhausted after the migration flag `tx_schema_v2` was enabled. While the migration runs, every payment uses two connections instead of one, so the pool limit of 200 was reached at the dinner peak.\n\nRaise the connection limit on pay-db-1 from 200 to 400.",
    status: "Done",
    assignee: "alice",
    reporter: "alice",
    labels: ["postmortem", "checkout-outage"],
    level: "Incident team",
    comments: [
      { by: "alice", text: "Done: connection limit on pay-db-1 raised from 200 to 400. The migration stays off until it's tested." },
      { by: "carol", text: "The postmortem is blameless: keep the name of whoever switched the flag on out of it before it goes to Acme.", restrictedToRole: ROLES.admins },
    ],
  },
  {
    key: "PAY-241",
    type: "Task",
    summary: "Alert when the connection pool is more than 80% full",
    description:
      "Follow-up from the checkout outage. There was no alert for the pool filling up; the first alert was about latency, about 20 minutes later. Add an alert when the pay-db-1 connection pool is more than 80% full for 5 minutes. Page the payments on-call engineer. Link the alert to the Payment service runbook.",
    status: "Done",
    assignee: "alice",
    reporter: "alice",
    labels: ["postmortem", "checkout-outage"],
    level: "Incident team",
    comments: [{ by: "alice", text: "Alert is live: pool_saturation pages the on-call engineer when pay-db-1 is more than 80% full for 5 minutes." }],
  },
  {
    key: "PAY-242",
    type: "Bug",
    summary: 'SEV4: checkout error page shows raw "503 Service Unavailable" text',
    description:
      'During the checkout outage, customers saw a plain "503 Service Unavailable" page at checkout instead of our branded error page with a retry button. Near miss, cosmetic: SEV4 per the incident response handbook.',
    status: "To Do",
    assignee: "bob",
    reporter: "bob",
    labels: ["sev4"],
    comments: [{ by: "bob", text: "Filed as SEV4 per the handbook. Low priority." }],
  },
  {
    key: "PAY-243",
    type: "Task",
    summary: "Estimate the cost of bringing second-line payment support in-house",
    description:
      "Input for the Acme renewal decision, due 45 days before the end of the term. Option: replace Acme's second-line support with our own team. Estimate headcount and yearly cost, and what we lose (Acme's round-the-clock desk). Restricted to leadership; Acme must not see this. Notes: Drive → Vendors → Acme renewal notes.",
    status: "In Progress",
    assignee: "carol",
    reporter: "carol",
    labels: ["acme-renewal"],
    level: "Leadership only",
    comments: [{ by: "carol", text: "First estimate: about 3 engineers, roughly USD 450,000 a year. No service credit to offset it: Acme's availability was 99.98%, above the 99.95% in the agreement." }],
  },
  {
    key: "PAY-244",
    type: "Task",
    summary: "Send P1 incident notifications to Acme's support desk",
    description:
      "The SLA agreement promises Acme a response within 15 minutes for Priority 1 incidents. Send a webhook to Acme's support desk when a SEV1 is declared, so their 24x7 team starts the clock. Acme builds the receiving end; Owning team is set to the vendors group so they can follow this ticket.",
    status: "To Do",
    assignee: "bob",
    reporter: "carol",
    labels: ["vendor-integration"],
    owningTeam: "vendors",
    comments: [{ by: "bob", text: "Webhook payload agreed: incident ID, severity and start time only. No customer data or internal hostnames." }],
  },
  {
    key: "PAY-245",
    type: "Task",
    summary: "Name the backup database in the Payment service runbook",
    description:
      "Follow-up from the checkout outage. Finding the name of the backup database took 25 minutes because the runbook said \"switch to the backup\" without naming it. Update the failover step to name the backup database, pay-db-2.",
    status: "Done",
    assignee: "alice",
    reporter: "alice",
    labels: ["postmortem", "checkout-outage"],
    level: "Incident team",
    comments: [{ by: "alice", text: "Done: the failover step in the Payment service runbook now names pay-db-2." }],
  },

  // ---- SEC ----
  {
    key: "SEC-1",
    type: "Task",
    summary: "Payment gateway API key leaked in a public repository",
    description:
      "A live API key for the payment gateway was committed to the public repository payments-sdk-examples. An outside security researcher reported it the next morning. The key was revoked within the hour and every merchant key was re-issued. No fraudulent transactions were found. Report: Drive → Security → Security incident report.",
    status: "Done",
    assignee: "carol",
    reporter: "carol",
    labels: ["incident"],
    level: "Security team only",
    comments: [{ by: "carol", text: "Key revoked and all merchant keys re-issued. Secret scanning is now on for every repository. Closing." }],
  },
  {
    key: "SEC-2",
    type: "Bug",
    summary: "Patch CVE-2026-1234 in the auth service",
    description: "CVE-2026-1234 affects the auth service. Patch in progress, due 30 Sep.",
    status: "In Progress",
    assignee: "carol",
    reporter: "carol",
    labels: ["cve"],
    level: "Security team only",
    comments: [{ by: "carol", text: "Patch is in staging. Missed the 30 Sep due date; new target 9 Oct." }],
  },
  {
    key: "SEC-3",
    type: "Task",
    summary: "Phishing email pretending to be the payments on-call bot",
    description:
      'Bob received an email that looked like a page from the payments on-call bot, asking him to "re-authenticate" at an outside link. He didn\'t click it. Forwarded to security.',
    status: "In Progress",
    assignee: "carol",
    reporter: "bob",
    labels: ["phishing"],
    comments: [
      { by: "carol", text: "Thanks Bob. Sender domain blocked, and a warning went to the engineering team." },
      { by: "bob", text: "Got two more of these on Friday, also blocked now." },
    ],
  },

  // ---- VEND ----
  {
    key: "VEND-1",
    type: "Task",
    summary: "Share the checkout outage timeline so Acme can look into its page response",
    description:
      "From Acme: Company A says our support desk took 47 minutes to answer its page during the checkout outage; the agreement says 15. Please share the timeline so I can look into it with our support lead.",
    status: "In Progress",
    assignee: "carol",
    reporter: "dave",
    labels: ["outage-follow-up"],
    comments: [
      { by: "carol", text: "I've shared the postmortem with you in Drive, it has the full timeline: paged 19:52, answered 20:39. Please keep it within Acme, it has merchant details. I'll remove your access once you're done." },
      { by: "dave", text: "Got it, thanks. I'll confirm our side of the timeline by Friday." },
    ],
  },
  {
    key: "VEND-2",
    type: "Task",
    summary: "Monthly report: Acme availability, response times and P1 incidents",
    description:
      "Acme's monthly report goes in the Shared with Acme folder by the 5th working day of the following month. It covers availability against the 99.95% commitment, response times, and every Priority 1 incident. Agreement: Drive → Vendors → Shared with Acme → Vendor SLA agreement.",
    status: "Done",
    assignee: null,
    reporter: "dave",
    labels: ["sla"],
    comments: [{ by: "dave", text: "Uploaded to the Shared with Acme folder. Availability 99.98%; one Priority 1 incident, the checkout outage, where our desk answered later than the 15 minutes we commit to." }],
  },
  {
    key: "VEND-3",
    type: "Task",
    summary: "Acme renewal: points for the renewal meeting",
    description:
      "Acme's contract renews yearly; the decision is due 45 days before the end of the term. Raise the 47-minute page response during the checkout outage (the agreement says 15) and ask for monthly reporting on page response times, not just availability. Internal only; not for vendors.",
    status: "In Progress",
    assignee: "carol",
    reporter: "carol",
    labels: ["acme-renewal"],
    comments: [{ by: "carol", text: "Acme has added a second person to the night shift since. Still asking for response-time reporting before we renew." }],
  },
  {
    key: "VEND-4",
    type: "Task",
    summary: "Check Acme's side of the outage timeline against the postmortem",
    description:
      "Dave is confirming Acme's side of the checkout outage timeline (VEND-1). Check it against the postmortem so I can close the follow-up and remove Acme's access to the postmortem.",
    status: "To Do",
    assignee: "alice",
    reporter: "carol",
    labels: ["outage-follow-up"],
    comments: [{ by: "alice", text: "Matches the postmortem: paged at 19:52, Acme answered at 20:39, 47 minutes against the 15 in the agreement." }],
  },
  {
    key: "VEND-5",
    type: "Task",
    summary: "Approve Acme read-only access to the payments status dashboard",
    description:
      "Acme asked for read-only access to the payments status dashboard, so their 24x7 support team sees Priority 1 incidents sooner. This needs approval from the payments on-call engineer for the week the access starts: next week, when Bob is primary per the on-call rota. The dashboard must not show internal hostnames or customer data.",
    status: "To Do",
    assignee: "carol",
    reporter: "carol",
    labels: ["access-request"],
    approvers: ["bob"],
    comments: [{ by: "carol", text: "Bob, you're on call next week when Acme's access would start, so it's your call. Please approve or reject by Wednesday; a read-only viewer role is enough." }],
  },
];
