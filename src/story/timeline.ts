// The demo story as it happens, day by day: every Slack message and Drive change, at its time (SGT).
// Slack stamps a message when it's posted and can't backdate it, so `npm run seed:story -- --day N` is run on
// that day's real date (STORY_DAYS) and posts each step at its time. Story, cast and who-sees-what:
// docs/design/demo-story-and-mock-data.md in the team workspace. Drive content: connectors/drive/cli/seedContent.ts.
//
// Rules: each fact lives in one visibility tier (public channels never carry the root cause, ticket numbers of the
// incident, merchant data or contract terms); restricted content carries canaries (PAY-240, ACM-77812, SEC-0814,
// VULN-017, $40k ...); no "&", "<" or ">" in messages (Slack escapes them, which breaks the repeat check).
import {
  ACME_REPORT_NAME,
  ADR_NAME,
  ALERT_RULES_NAME,
  FAILED_CHECKOUTS_NAME,
  FILES,
  HANDOVER_NAME,
  POSTMORTEM_NAME,
  RENEWAL_NAME,
  RETIRED,
  adr,
  alertRules,
} from "../connectors/drive/cli/seedContent.js";
import { createNamed, rewrite, setMigrationStage, setRunbook, trash } from "../connectors/drive/cli/seedOps.js";

export { STORY_DAYS } from "../connectors/drive/cli/seedContent.js";

export type Who = "alice" | "bob" | "carol" | "dave";
export type WsKey = "main" | "vendors"; // "key" in slack-tokens.json

export type ChannelDef = { name: string; private: boolean; members: Who[]; general?: true; shown?: string };

// "general" is each workspace's default channel (found by is_general, whatever it's called).
export const CHANNELS: Record<WsKey, ChannelDef[]> = {
  main: [
    { name: "general", general: true, shown: "all-company-a", private: false, members: [] },
    { name: "payments", private: false, members: ["alice", "bob", "carol"] },
    { name: "db-migration", private: false, members: ["alice", "bob", "carol"] },
    { name: "eng-auth", private: false, members: ["alice", "bob", "carol"] },
    { name: "releases", private: false, members: ["alice", "bob", "carol"] },
    { name: "social", private: false, members: ["alice", "bob", "carol"] },
    { name: "payments-incident", private: true, members: ["alice", "carol"] },
    { name: "security", private: true, members: ["carol"] },
  ],
  vendors: [
    { name: "general", general: true, shown: "all-company-a-vendors", private: false, members: [] },
    { name: "acme-escalation", private: true, members: ["carol", "dave"] }, // temporary: Carol removes Dave in S4
    { name: "vendor-contracts", private: true, members: ["carol"] },
  ],
};

// A channel message (posted by the workspace's bot under the persona's name). `id` names a thread's first
// message; `thread` makes this a reply to it.
export type Post = { at: string; ws: WsKey; channel: string; as: Who; text: string; id?: string; thread?: string };
// A DM or group DM, posted as `as` with their own user token (they must have clicked Connect).
export type Dm = { at: string; ws: WsKey; as: Who; to: Who[]; text: string };
// A Drive change. `id` records it as done in story-state.json, so a re-run doesn't repeat it.
export type DriveStep = { at: string; id: string; drive: string; run: (admin: string) => Promise<unknown> };
export type Step = Post | Dm | DriveStep;

const A = (at: string, channel: string, as: Who, text: string, extra: Partial<Post> = {}): Post => ({ at, ws: "main", channel, as, text, ...extra });
const V = (at: string, channel: string, as: Who, text: string, extra: Partial<Post> = {}): Post => ({ at, ws: "vendors", channel, as, text, ...extra });
const dm = (at: string, ws: WsKey, as: Who, to: Who[], text: string): Dm => ({ at, ws, as, to, text });
const drive = (at: string, id: string, what: string, run: (admin: string) => Promise<unknown>): DriveStep => ({ at, id, drive: what, run });

// ---- Day 1, Sat 3 Oct: the new workspace, then the checkout outage (19:40 to 21:15) ----

const DAY_1: Step[] = [
  drive("15:00", "d1-prepare", "Set the files to how they were before the outage: runbook without the replica's name, migration plan (dual-write live), ADR-012 proposed, alert rules without a pool alert; re-dated rota, Q3 review and onboarding guide; files from later days (and the old 25 Sep versions) to the trash", async () => {
    await setRunbook("before");
    await setMigrationStage(0);
    await rewrite(ADR_NAME, adr(false));
    await rewrite(ALERT_RULES_NAME, alertRules(false));
    for (const name of ["On-call rota", "Q3 business review", "Vendor onboarding guide"]) await rewrite(name);
    for (const f of [...FILES.filter((x) => (x.day ?? 0) > 1), ...RETIRED]) await trash(f.folder, f.name);
  }),
  A("15:02", "general", "carol", "Welcome to Company A's new Slack workspace :wave: We moved here this weekend, so the old chat tool is read-only from now on. Engineering channels: #payments, #db-migration, #eng-auth and #releases. Vendors and contractors are in a separate Vendors workspace."),
  A("15:06", "general", "carol", "Please welcome Bob to the payments team! He joined in September and takes his first on-call week from Monday 5 Oct, with Alice as secondary."),
  V("15:10", "general", "carol", "Welcome to the Company A Vendors workspace. This is where we work with our vendors and contractors. Dave from Acme Payments, our card processor, is the first one here :wave:"),
  V("15:25", "general", "dave", "Thanks Carol! For anything urgent, page Acme's Priority 1 desk: it's staffed 24x7. I'll pick up anything posted here on working days."),
  A("15:40", "payments", "alice", "I'm primary on call this weekend, Priya is secondary. Page me for anything checkout-related."),
  A("15:45", "db-migration", "alice", "Status: step 2 is live. Dual-write (tx_schema_v2) has been on in production since yesterday 18:05."),
  A("15:47", "db-migration", "alice", "Step 3 is blocked: schema lock on the `transactions` table, ticket PAY-231."),
  A("16:05", "db-migration", "bob", "Where's the rollback plan if dual-write misbehaves?", { id: "rollback" }),
  A("16:12", "db-migration", "alice", "In the DB migration plan doc in Drive (Engineering folder): turn off tx_schema_v2. The old schema stays authoritative until step 4, so nothing is lost.", { thread: "rollback" }),
  A("16:40", "social", "bob", "Anyone up for futsal tomorrow at 5? I've booked a court near Tanjong Pagar.", { id: "futsal" }),
  A("16:52", "social", "alice", "In, unless I get paged :sweat_smile:", { thread: "futsal" }),
  A("17:00", "social", "carol", "Count me in.", { thread: "futsal" }),

  // the outage
  A("19:41", "payments", "alice", "Payment API p99 latency spiking since 19:40, looking into it"),
  A("19:43", "payments-incident", "alice", "Declaring SEV1: card payments at checkout are failing, p99 latency above 4 seconds since 19:40. I'm incident commander."),
  A("19:46", "payments-incident", "alice", "pay-db-1 connection pool is at 200 of 200. Requests are queueing behind it."),
  A("19:48", "payments-incident", "carol", "Here. I'll take comms: the status page and the MAS notification (due within an hour of discovery)."),
  A("19:52", "payments-incident", "carol", "Paged Acme's Priority 1 desk at 19:52. No answer yet."),
  V("19:53", "acme-escalation", "carol", "Opening this channel for tonight's incident. Card payments at Company A checkout have been failing since 19:40. We paged your Priority 1 desk at 19:52: please acknowledge here."),
  A("19:58", "payments", "bob", "Is the checkout outage related to the DB migration?"),
  A("20:00", "payments", "carol", "Update 20:00: some card payments at checkout are failing. The team is on it. Next update by 20:30."),
  A("20:02", "security", "carol", "Checked auth and gateway logs for tonight's checkout incident: no unusual traffic. Not a security incident."),
  A("20:05", "payments-incident", "alice", "Each payment request is holding two connections instead of one. That's the dual-write: tx_schema_v2 went on yesterday at 18:05."),
  A("20:12", "payments-incident", "alice", 'Turning tx_schema_v2 off won\'t free the stuck connections fast enough, so I\'m failing over. Which replica is current? The runbook only says "promote the read replica".'),
  A("20:20", "payments-incident", "alice", "Found it in the DBA team's notes: the replica is pay-db-2. That took far too long."),
  A("20:30", "payments", "carol", "Update 20:30: still failing for some customers. A fix is in progress. Next update by 21:00."),
  A("20:31", "payments-incident", "carol", "MAS notified at 20:31. The root-cause report is due within 14 days."),
  V("20:39", "acme-escalation", "dave", "Acme here, sorry for the wait. Our ticket is ACM-77812. Processing looks healthy on our side; checking your gateway connection now."),
  A("20:41", "payments-incident", "carol", "Acme finally answered at 20:39, 47 minutes after the page."),
  A("20:48", "payments-incident", "alice", "Failed over to pay-db-2. Pool size checked: 200. Restoring traffic."),
  A("20:58", "payments-incident", "alice", "Checkout success rate is back to 94% and climbing."),
  A("21:00", "payments", "carol", "Update 21:00: payments are recovering. Next update by 21:30."),
  A("21:15", "payments-incident", "alice", "Resolved at 21:15: checkout success rate is back to normal. tx_schema_v2 stays off."),
  A("21:16", "payments", "alice", "Resolved: card payments at checkout are working again since 21:15. Thanks for your patience, everyone."),
  V("21:17", "acme-escalation", "carol", "Resolved on our side at 21:15. We'll go through the timeline with you on Monday."),
  A("21:22", "payments-incident", "alice", "Root cause of payment outage: connection pool exhausted after migration flag enabled. Dual-write holds two connections per request, so the 200-connection pool ran out at the dinner peak."),
  A("21:26", "payments-incident", "alice", "Follow-up tickets PAY-240 (pool limits) and PAY-241 (alerting) created. I'll write the postmortem draft tomorrow."),
  drive("21:30", "d1-runbook", "Alice adds the replica's name (pay-db-2) to the Payment service runbook", () => setRunbook("after")),
  A("21:31", "payments-incident", "alice", "Failover step added to runbook: switch to replica `pay-db-2`"),
  A("21:35", "db-migration", "alice", "tx_schema_v2 is off after tonight's checkout incident. The migration is paused until further notice."),
  A("21:40", "social", "alice", "Still in for tomorrow. Tonight was enough excitement :sweat_smile:", { thread: "futsal" }),
];

// ---- Day 2, Mon 5 Oct: the aftermath ----

const DAY_2: Step[] = [
  dm("08:45", "main", "carol", ["alice", "bob"], "Standup moved to 10:30 today: Alice and I are doing the incident review first."),
  drive("09:15", "d2-migration-paused", "DB migration plan: paused after the 3 Oct incident", () => setMigrationStage(1)),
  drive("09:30", "d2-postmortem", "Postmortem draft and the failed-checkouts list appear in Engineering/Postmortems (postmortem also shared with Dave)", async (admin) => {
    await createNamed(POSTMORTEM_NAME, admin);
    await createNamed(FAILED_CHECKOUTS_NAME, admin);
  }),
  dm("09:35", "main", "alice", ["carol"], "Between us: the outage root cause was my migration flag. I turned tx_schema_v2 on Friday evening without checking the pool headroom. Postmortem draft is in Engineering/Postmortems."),
  A("09:40", "payments-incident", "alice", "Postmortem draft is in Engineering/Postmortems. Comments welcome before Wednesday."),
  drive("10:00", "d2-handover", "On-call handover note (Alice to Bob) appears in Runbooks; the pool alert is added to Payment alert rules.json", async (admin) => {
    await createNamed(HANDOVER_NAME, admin);
    await rewrite(ALERT_RULES_NAME, alertRules(true));
  }),
  A("10:05", "payments", "bob", "I'm primary on call this week, Alice is secondary. Runbook bookmarked :slightly_smiling_face:"),
  A("10:10", "payments", "bob", "Before my shift: is there an alert on the database connection pool now?", { id: "pool-alert" }),
  A("10:14", "payments", "alice", "Yes, from today: above 80% for 5 minutes pages the primary. It's in Payment alert rules.json in the Engineering folder.", { thread: "pool-alert" }),
  A("11:00", "payments", "alice", "Customer update for Saturday's incident is on the status page: card payments at checkout failed between 19:40 and 21:15 SGT on 3 Oct. The postmortem is with the incident team; a summary goes to #all-company-a when it's final."),
  A("11:05", "payments-incident", "alice", "PAY-240 is in production: pool limit raised from 200 to 400, with back-pressure. The PAY-241 alert (pool above 80% for 5 minutes) is live."),
  A("11:10", "payments-incident", "carol", "I've shared the postmortem draft with Dave from Acme so they can confirm their part of the timeline. It still lists merchants and refunds, so I'll remove him as soon as they've confirmed."),
  A("11:12", "payments-incident", "alice", "Acme's desk took 47 minutes to answer our P1 page on Saturday, and never sent an update. Flagged for Carol's vendor review."),
  V("11:15", "acme-escalation", "carol", "Our timeline for Saturday: paged Acme 19:52 SGT, first response 20:39, no further update from Acme, recovered 21:15. The postmortem draft is shared with you in Drive: please confirm Acme's part."),
  dm("11:20", "vendors", "carol", ["dave"], "Dave, please don't share the outage timeline with other vendors yet."),
  A("12:00", "general", "carol", "Annual security awareness training is due by 31 Oct. The link is in the Employee handbook."),
  A("12:30", "social", "bob", "Chicken rice at the hawker centre, anyone? Leaving at 12:45."),
  drive("14:00", "d2-acme-report", "Dave uploads Acme's incident report to Shared with Acme (it claims every commitment was met)", (admin) => createNamed(ACME_REPORT_NAME, admin)),
  V("14:05", "acme-escalation", "dave", "Timeline confirmed from our side (ACM-77812). Acme's incident report is in the Shared with Acme folder."),
  V("14:30", "vendor-contracts", "carol", "Payment processor contract renewal: penalty clause triggered by the outage, $40k credit"),
  drive("14:35", "d2-renewal", "Carol's Acme renewal notes appear in Vendors", (admin) => createNamed(RENEWAL_NAME, admin)),
  V("14:40", "vendor-contracts", "carol", "Details: Acme answered our 3 Oct P1 page after 47 minutes (commitment: 15) and then sent no update for 36 minutes (commitment: every 30). Clause 4.2: two misses at USD 20k each, so a USD 40k credit. Internal until Legal signs off. Notes are in Vendors/Acme renewal notes."),
  A("15:00", "security", "carol", "Closed SEC-0814 (the Q3 key leak): no fraudulent transactions, every merchant key re-issued. Root cause: long-lived static keys. ADR-012 is the long-term fix. The report is in the Security folder."),
  A("15:05", "security", "carol", "Vulnerability CVE-2026-1234 in auth service, patch in progress"),
  A("15:10", "security", "carol", "VULN-017 (token replay in the legacy auth service) stays open until ADR-012 ships. It's on the Q4 audit list."),
  A("16:00", "eng-auth", "alice", "Design discussion for the new auth service: replace merchants' static API keys with short-lived tokens. Draft ADR-012 is in Engineering/Architecture. Open question: how long should access tokens live?", { id: "auth" }),
  A("16:20", "eng-auth", "bob", "15 minutes feels short for payout batch jobs. Some run for 40 minutes.", { thread: "auth" }),
  A("16:35", "eng-auth", "alice", "Batch jobs can use the refresh flow. Short tokens limit the damage if one leaks.", { thread: "auth" }),
  A("17:05", "eng-auth", "carol", "Security prefers 15 minutes, plus mTLS for our 50 highest-volume merchants. Long-lived keys are the risk we want gone.", { thread: "auth" }),
  A("17:20", "eng-auth", "bob", "Then I'll add token refresh to the payouts client.", { thread: "auth" }),
  A("17:30", "db-migration", "alice", "The pool fixes are in production. Plan: dual-write back on in staging tomorrow, production after the DBA review."),
];

// ---- Day 3, Tue 6 Oct: moving on ----

const DAY_3: Step[] = [
  A("09:30", "eng-auth", "alice", "Decision: 15-minute access tokens, 24-hour refresh tokens, mTLS for the top 50 merchants. ADR-012 is now Accepted.", { thread: "auth" }),
  drive("09:31", "d3-adr", "ADR-012 status: Accepted", () => rewrite(ADR_NAME, adr(true))),
  A("10:00", "db-migration", "alice", "Resuming: dual-write is back on in staging. Step 3 (backfill) is still blocked by the schema lock (PAY-231); DBA review with Priya on Thursday."),
  A("11:00", "releases", "alice", "checkout-api 4.13 is out: reliability fixes in the payments database layer."),
  A("11:30", "releases", "bob", "payouts 1.6 is out: same-day USD payouts to US bank accounts (beta, 20 merchants)."),
  A("11:45", "payments", "alice", "Deploy freeze for payments from 9 to 12 Nov for 11.11 sale traffic. Payment changes need two reviewers until then."),
  A("14:00", "db-migration", "bob", "New blocker: the backfill job times out after 30 minutes on the 2024 partitions. Raised PAY-252."),
  drive("14:20", "d3-migration-resumed", "DB migration plan: resumed, PAY-252, new targets", () => setMigrationStage(2)),
  A("14:22", "db-migration", "alice", "Updated the DB migration plan with new dates: step 3 now targets 23 Oct, step 4 early November."),
  A("15:00", "payments-incident", "alice", "pay-db-2 is being retired after the storage refresh. The failover target moves to pay-db-3; I'll update the runbook on the day."),
  dm("15:10", "main", "alice", ["bob"], "For the rest of your on-call week: failover steps are in the Payment service runbook (Engineering/Runbooks). If the pool alert fires, page me before you promote the replica."),
  A("16:00", "security", "carol", "To do: remove Acme's temporary access (postmortem draft, #acme-escalation) once the vendor review is done."),
  V("16:30", "vendor-contracts", "carol", "Renewal decision due 15 Nov. Fallback: bring second-line support in-house."),
  V("17:00", "general", "dave", "Heads-up: Acme's planned maintenance is on 18 Oct, 02:00 to 03:00 SGT. No downtime expected."),
];

export const DAYS: Record<number, Step[]> = { 1: DAY_1, 2: DAY_2, 3: DAY_3 };
