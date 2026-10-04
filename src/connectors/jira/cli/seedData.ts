// The Jira demo data that `npm run seed:jira` creates. It mirrors docs/jira-mock-data-plan.md: change both together.
//
// ---- Scenario description ----
//
// Company A runs a payments platform. On 25 Sep, Alice enabled the `tx_schema_v2` migration flag for the
// transactions database. During the dual-write phase, every request held two connections, so the pay-db-1
// connection pool ran out and checkout failed for about 18% of customers between 09:40 and 11:15. The same
// story is told in Slack (#payments, #payments-incident) and Drive (postmortem, runbooks). Jira holds the tickets:
//
//   PAY (Payments Engineering): the migration step that's blocked (PAY-231), the postmortem follow-ups
//     (PAY-240 pool limits, PAY-241 alerting), a SEV4 near miss (PAY-242), the leadership-only estimate of the
//     contract penalty the outage triggered (PAY-243, $40k credit), and the P1 webhook to Acme (PAY-244).
//   SEC (Security): Carol's Q3 leaked API key (SEC-1) and CVE-2026-1234 patch (SEC-2), both restricted to the
//     security team, and a phishing email Bob reported (SEC-3).
//   VEND (Vendor Requests): Acme's requests via Dave (outage timeline VEND-1, September SLA report VEND-2),
//     the internal contract penalty review (VEND-3), a vendor-safe timeline Alice is writing (VEND-4), and
//     Acme's dashboard access request that Bob must approve (VEND-5).
//
// Who sees what, and which permission mechanism shows it:
//   Alice (payments engineer): PAY through the Engineers role (via group payments-eng), except PAY-243
//     (security level "Leadership only"). VEND-4 only, as its assignee. No SEC.
//   Bob (engineer, on call): same PAY access as Alice. SEC-3 only, as its reporter. VEND-5 only, because he's
//     named in its Approvers picker field. Never SEC-1/SEC-2 or the penalty tickets.
//   Carol (security lead, admin): everything. SEC and VEND through group security; PAY through the Engineers
//     role as a single user; PAY-243 as the only person in "Leadership only".
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
export const SECURITY_SCHEMES: Record<string, { name: string; level: string; description: string; members: Member[] }> = {
  SEC: { name: "SEC security", level: "Security team only", description: "Carol and the security team", members: [{ group: "security" }, { group: "brain-crawler" }] },
  PAY: { name: "PAY security", level: "Leadership only", description: "Leadership only", members: [{ user: "carol" }, { group: "brain-crawler" }] },
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
  secured?: boolean; // the project's security level
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
      { by: "bob", text: "Is this the same migration that was running during the checkout outage?" },
      { by: "alice", text: "Yes. Step 3 is on hold until PAY-240 is done." },
    ],
  },
  {
    key: "PAY-240",
    type: "Task",
    summary: "Raise DB connection pool limits and add back-pressure",
    description:
      "Follow-up from the 25 Sep payment outage. Root cause: the database connection pool on pay-db-1 was exhausted after the migration flag `tx_schema_v2` was enabled, because each request held two connections during the dual-write phase.\n\nRaise the pool limit to at least 200 and add back-pressure so the payment API queues requests instead of opening new connections.",
    status: "In Progress",
    assignee: "alice",
    reporter: "carol",
    labels: ["postmortem", "outage-2026-09-25"],
    comments: [
      { by: "alice", text: "Pool raised from 100 to 200 on pay-db-1 in staging. Back-pressure middleware PR is open, needs two reviewers (payment change)." },
      { by: "carol", text: "Keep the flag owner's name out of the vendor timeline and the public postmortem.", restrictedToRole: ROLES.admins },
    ],
  },
  {
    key: "PAY-241",
    type: "Task",
    summary: "Alert on connection pool saturation above 80%",
    description:
      "Follow-up from the 25 Sep payment outage. Add an alert when connection pool saturation on pay-db-1 goes above 80% for 5 minutes. Page the payments on-call engineer. Link the alert to the Payment service runbook.",
    status: "To Do",
    assignee: "bob",
    reporter: "carol",
    labels: ["postmortem", "outage-2026-09-25"],
    comments: [{ by: "bob", text: "Draft alert: pool saturation > 80% for 5 min pages payments on-call. Testing in staging this week." }],
  },
  {
    key: "PAY-242",
    type: "Bug",
    summary: 'SEV4: checkout error page shows raw "503 Service Unavailable" text',
    description:
      'During the 25 Sep outage, customers saw a plain "503 Service Unavailable" page at checkout instead of our branded error page with a retry button. Near miss, cosmetic: SEV4 per the incident response handbook.',
    status: "To Do",
    assignee: "bob",
    reporter: "bob",
    labels: ["sev4"],
    comments: [{ by: "bob", text: "Filed as SEV4 per the handbook. Low priority." }],
  },
  {
    key: "PAY-243",
    type: "Task",
    summary: "Estimate contract penalty exposure from the 25 Sep payment outage",
    description:
      "The payment processor contract renewal has a penalty clause that the 25 Sep outage triggered. Expected outcome: a $40k credit. Confirm the amount with finance and decide what to tell the vendor before the SLA review on Friday. Restricted to leadership.",
    status: "In Progress",
    assignee: "carol",
    reporter: "carol",
    labels: ["outage-2026-09-25"],
    secured: true,
    comments: [{ by: "carol", text: "Penalty clause confirmed with the processor: $40k credit. Waiting on finance before the SLA review." }],
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

  // ---- SEC ----
  {
    key: "SEC-1",
    type: "Task",
    summary: "Q3 incident: payment gateway API key leaked in a public repository",
    description:
      "An API key for the payment gateway was committed to a public repository and found by an external scanner. The key was rotated on 14 Aug. No fraudulent transactions were found. Report: Drive → Security → Q3 breach report.",
    status: "Done",
    assignee: "carol",
    reporter: "carol",
    labels: ["incident", "q3"],
    secured: true,
    comments: [{ by: "carol", text: "Key rotated 14 Aug. Scanner alerts now go to #security. Closing." }],
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
    secured: true,
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
    summary: "Share the payment outage timeline for the September SLA report",
    description: "From Acme: please share the 25 Sep payment outage timeline so we can include it in our SLA report. Start and end times and customer impact are enough.",
    status: "In Progress",
    assignee: "carol",
    reporter: "dave",
    labels: ["sla"],
    comments: [
      { by: "carol", text: "Incident window 09:40 to 11:15, 18% of checkouts failed. Please don't share this with other vendors yet." },
      { by: "dave", text: "Thanks, that's enough for the report." },
    ],
  },
  {
    key: "VEND-2",
    type: "Task",
    summary: "September SLA report: Acme support availability and P1 incidents",
    description:
      "Acme's monthly SLA report for September is due by the 5th working day of October (7 Oct). It covers support availability against the 99.9% target, response times, and every Priority 1 incident. Agreement: Drive → Vendors → Vendor SLA agreement.",
    status: "To Do",
    assignee: null,
    reporter: "dave",
    labels: ["sla"],
    comments: [{ by: "dave", text: "I'll send the draft to vendor-support by 7 Oct." }],
  },
  {
    key: "VEND-3",
    type: "Task",
    summary: "Payment processor contract renewal: penalty clause review",
    description: "The outage triggered the penalty clause in the payment processor contract renewal. Review the credit with finance. Internal only; not for vendors.",
    status: "In Progress",
    assignee: "carol",
    reporter: "carol",
    labels: ["contract"],
    comments: [{ by: "carol", text: "Penalty clause triggered by the outage. Finance reviewing before the vendor SLA review on Friday." }],
  },
  {
    key: "VEND-4",
    type: "Task",
    summary: "Prepare a vendor-safe outage timeline (no internal hostnames)",
    description: "Turn the postmortem timeline into a version we can give Acme: incident window and impact only. Remove internal hostnames, database names and who made the change.",
    status: "To Do",
    assignee: "alice",
    reporter: "carol",
    labels: ["sla"],
    comments: [{ by: "alice", text: "Will do. I'll base it on the postmortem and strip pay-db-1 and the flag name." }],
  },
  {
    key: "VEND-5",
    type: "Task",
    summary: "Approve Acme read-only access to the payments status dashboard",
    description:
      "Acme asked for read-only access to the payments status dashboard, so their 24x7 support team sees Priority 1 incidents sooner. This needs approval from the payments on-call engineer for the week of the request (Bob, primary in 2026-W40 per the on-call rota). The dashboard must not show internal hostnames or customer data.",
    status: "To Do",
    assignee: "carol",
    reporter: "carol",
    labels: ["access-request"],
    approvers: ["bob"],
    comments: [{ by: "carol", text: "Bob, you were on call when Acme asked. Please approve or reject by Wednesday; a read-only viewer role is enough." }],
  },
];
