// The demo story's Slack side: every channel message and DM, in story order. `npm run seed:story` posts them
// all at once (and builds the Drive folder). Story, cast and who-sees-what: docs/demo-data.md; the reasoning:
// docs/design/demo-story-and-mock-data.md in the team workspace. Drive content: connectors/drive/cli/seedContent.ts.
//
// The story: Company A's checkout fails on Sat 3 Oct 2026, 19:40 to 21:15 SGT, then two days of aftermath.
// Everything is posted at once, so Slack's timestamps are the posting time: messages carry their story times
// in the text ("Update 20:00", "paged at 19:52") and avoid "tonight" or "tomorrow".
//
// Rules: each fact lives in one visibility tier (public channels never carry the root cause, the incident's
// tickets, merchant data or contract terms); restricted content carries canaries (PAY-240, ACM-77812, SEC-0814,
// VULN-017, $40k ...); no "&", "<" or ">" in messages (Slack escapes them, which breaks the repeat check).

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

// A channel message, posted by the workspace's bot under the persona's name. `id` names a thread's first
// message; `thread` makes this a reply to it.
export type Post = { ws: WsKey; channel: string; as: Who; text: string; id?: string; thread?: string };
// A DM or group DM, posted as `as` with their own user token (they must have clicked Connect).
export type Dm = { ws: WsKey; as: Who; to: Who[]; text: string };
export type Step = Post | Dm;

const A = (channel: string, as: Who, text: string, extra: Partial<Post> = {}): Post => ({ ws: "main", channel, as, text, ...extra });
const V = (channel: string, as: Who, text: string, extra: Partial<Post> = {}): Post => ({ ws: "vendors", channel, as, text, ...extra });
const dm = (ws: WsKey, as: Who, to: Who[], text: string): Dm => ({ ws, as, to, text });

export const STORY: Step[] = [
  // ---- before the outage: the new workspace ----
  A("general", "carol", "Welcome to Company A's new Slack workspace :wave: We've moved here, so the old chat tool is read-only from now on. Engineering channels: #payments, #db-migration, #eng-auth and #releases. Vendors and contractors are in a separate Vendors workspace."),
  A("general", "carol", "Please welcome Bob to the payments team! He joined in September and takes his first on-call week from Monday 5 Oct, with Alice as secondary."),
  V("general", "carol", "Welcome to the Company A Vendors workspace. This is where we work with our vendors and contractors. Dave from Acme Payments, our card processor, is the first one here :wave:"),
  V("general", "dave", "Thanks Carol! For anything urgent, page Acme's Priority 1 desk: it's staffed 24x7. I'll pick up anything posted here on working days."),
  A("payments", "alice", "I'm primary on call until Monday 5 Oct, Priya is secondary. Page me for anything checkout-related."),
  A("db-migration", "alice", "Status: step 2 is live. Dual-write (tx_schema_v2) has been on in production since 2 Oct 18:05."),
  A("db-migration", "alice", "Step 3 is blocked: schema lock on the `transactions` table, ticket PAY-231."),
  A("db-migration", "bob", "Where's the rollback plan if dual-write misbehaves?", { id: "rollback" }),
  A("db-migration", "alice", "In the DB migration plan doc in Drive (Engineering folder): turn off tx_schema_v2. The old schema stays authoritative until step 4, so nothing is lost.", { thread: "rollback" }),
  A("social", "bob", "Anyone up for futsal on Sunday at 5? I've booked a court near Tanjong Pagar.", { id: "futsal" }),
  A("social", "alice", "In, unless I get paged :sweat_smile:", { thread: "futsal" }),
  A("social", "carol", "Count me in.", { thread: "futsal" }),

  // ---- the outage, Sat 3 Oct 19:40 to 21:15 ----
  A("payments", "alice", "Payment API p99 latency spiking since 19:40, looking into it"),
  A("payments-incident", "alice", "Declaring SEV1: card payments at checkout are failing, p99 latency above 4 seconds since 19:40. I'm incident commander."),
  A("payments-incident", "alice", "pay-db-1 connection pool is at 200 of 200. Requests are queueing behind it."),
  A("payments-incident", "carol", "Here. I'll take comms: the status page and the MAS notification (due within an hour of discovery)."),
  A("payments-incident", "carol", "Paged Acme's Priority 1 desk at 19:52. No answer yet."),
  V("acme-escalation", "carol", "Opening this channel for the 3 Oct checkout incident. Card payments at Company A checkout have been failing since 19:40 SGT. We paged your Priority 1 desk at 19:52: please acknowledge here."),
  A("payments", "bob", "Is the checkout outage related to the DB migration?"),
  A("payments", "carol", "Update 20:00: some card payments at checkout are failing. The team is on it. Next update by 20:30."),
  A("security", "carol", "Checked auth and gateway logs for the 3 Oct checkout incident: no unusual traffic. Not a security incident."),
  A("payments-incident", "alice", "Each payment request is holding two connections instead of one. That's the dual-write: tx_schema_v2 went on at 18:05 on 2 Oct."),
  A("payments-incident", "alice", 'Turning tx_schema_v2 off won\'t free the stuck connections fast enough, so I\'m failing over. Which replica is current? The runbook only says "promote the read replica".'),
  A("payments-incident", "alice", "Found it in the DBA team's notes at 20:20: the replica is pay-db-2. That took far too long."),
  A("payments", "carol", "Update 20:30: still failing for some customers. A fix is in progress. Next update by 21:00."),
  A("payments-incident", "carol", "MAS notified at 20:31. The root-cause report is due within 14 days."),
  V("acme-escalation", "dave", "Acme here, sorry for the wait. Our ticket is ACM-77812. Processing looks healthy on our side; checking your gateway connection now."),
  A("payments-incident", "carol", "Acme finally answered at 20:39, 47 minutes after the page."),
  A("payments-incident", "alice", "Failed over to pay-db-2 at 20:48. Pool size checked: 200. Restoring traffic."),
  A("payments-incident", "alice", "Checkout success rate is back to 94% and climbing."),
  A("payments", "carol", "Update 21:00: payments are recovering. Next update by 21:30."),
  A("payments-incident", "alice", "Resolved at 21:15: checkout success rate is back to normal. tx_schema_v2 stays off."),
  A("payments", "alice", "Resolved: card payments at checkout are working again since 21:15. Thanks for your patience, everyone."),
  V("acme-escalation", "carol", "Resolved on our side at 21:15. We'll go through the timeline with you on Monday."),
  A("payments-incident", "alice", "Root cause of payment outage: connection pool exhausted after migration flag enabled. Dual-write holds two connections per request, so the 200-connection pool ran out at the dinner peak."),
  A("payments-incident", "alice", "Follow-up tickets PAY-240 (pool limits) and PAY-241 (alerting) created. Postmortem draft to follow."),
  A("payments-incident", "alice", "Failover step added to runbook: switch to replica `pay-db-2`"),
  A("db-migration", "alice", "tx_schema_v2 is off after the 3 Oct checkout incident. The migration is paused until further notice."),
  A("social", "alice", "Still in for Sunday. Saturday night was enough excitement :sweat_smile:", { thread: "futsal" }),

  // ---- Mon 5 Oct: the aftermath ----
  dm("main", "carol", ["alice", "bob"], "Standup on Monday moves to 10:30: Alice and I are doing the incident review first."),
  dm("main", "alice", ["carol"], "Between us: the outage root cause was my migration flag. I turned tx_schema_v2 on Friday evening without checking the pool headroom. Postmortem draft is in Engineering/Postmortems."),
  A("payments-incident", "alice", "Postmortem draft is in Engineering/Postmortems. Comments welcome before Wednesday."),
  A("payments", "bob", "I'm primary on call from Monday 5 Oct, Alice is secondary. Runbook bookmarked :slightly_smiling_face:"),
  A("payments", "bob", "Before my shift: is there an alert on the database connection pool now?", { id: "pool-alert" }),
  A("payments", "alice", "Yes, there is now: above 80% for 5 minutes pages the primary. It's in Payment alert rules.json in the Engineering folder.", { thread: "pool-alert" }),
  A("payments", "alice", "Customer update for Saturday's incident is on the status page: card payments at checkout failed between 19:40 and 21:15 SGT on 3 Oct. The postmortem is with the incident team; a summary goes to #all-company-a when it's final."),
  A("payments-incident", "alice", "PAY-240 is in production: pool limit raised from 200 to 400, with back-pressure. The PAY-241 alert (pool above 80% for 5 minutes) is live."),
  A("payments-incident", "carol", "I've shared the postmortem draft with Dave from Acme so they can confirm their part of the timeline. It still lists merchants and refunds, so I'll remove him as soon as they've confirmed."),
  A("payments-incident", "alice", "Acme's desk took 47 minutes to answer our P1 page on Saturday, and never sent an update. Flagged for Carol's vendor review."),
  V("acme-escalation", "carol", "Our timeline for Saturday: paged Acme 19:52 SGT, first response 20:39, no further update from Acme, recovered 21:15. The postmortem draft is shared with you in Drive: please confirm Acme's part."),
  dm("vendors", "carol", ["dave"], "Dave, please don't share the outage timeline with other vendors yet."),
  A("general", "carol", "Annual security awareness training is due by 31 Oct. The link is in the Employee handbook."),
  A("social", "bob", "Chicken rice at the hawker centre, anyone? Leaving at 12:45."),
  V("acme-escalation", "dave", "Timeline confirmed from our side (ACM-77812). Acme's incident report is in the Shared with Acme folder."),
  V("vendor-contracts", "carol", "Payment processor contract renewal: penalty clause triggered by the outage, $40k credit"),
  V("vendor-contracts", "carol", "Details: Acme answered our 3 Oct P1 page after 47 minutes (commitment: 15) and then sent no update for 36 minutes (commitment: every 30). Clause 4.2: two misses at USD 20k each, so a USD 40k credit. Internal until Legal signs off. Notes are in Vendors/Acme renewal notes."),
  A("security", "carol", "Closed SEC-0814 (the Q3 key leak): no fraudulent transactions, every merchant key re-issued. Root cause: long-lived static keys. ADR-012 is the long-term fix. The report is in the Security folder."),
  A("security", "carol", "Vulnerability CVE-2026-1234 in auth service, patch in progress"),
  A("security", "carol", "VULN-017 (token replay in the legacy auth service) stays open until ADR-012 ships. It's on the Q4 audit list."),
  A("eng-auth", "alice", "Design discussion for the new auth service: replace merchants' static API keys with short-lived tokens. Draft ADR-012 is in Engineering/Architecture. Open question: how long should access tokens live?", { id: "auth" }),
  A("eng-auth", "bob", "15 minutes feels short for payout batch jobs. Some run for 40 minutes.", { thread: "auth" }),
  A("eng-auth", "alice", "Batch jobs can use the refresh flow. Short tokens limit the damage if one leaks.", { thread: "auth" }),
  A("eng-auth", "carol", "Security prefers 15 minutes, plus mTLS for our 50 highest-volume merchants. Long-lived keys are the risk we want gone.", { thread: "auth" }),
  A("eng-auth", "bob", "Then I'll add token refresh to the payouts client.", { thread: "auth" }),
  A("db-migration", "alice", "The pool fixes are in production. Plan: dual-write back on in staging next, then production after the DBA review."),

  // ---- Tue 6 Oct: moving on ----
  A("eng-auth", "alice", "Decision: 15-minute access tokens, 24-hour refresh tokens, mTLS for the top 50 merchants. ADR-012 is now Accepted.", { thread: "auth" }),
  A("db-migration", "alice", "Resuming: dual-write is back on in staging. Step 3 (backfill) is still blocked by the schema lock (PAY-231); DBA review with Priya on Thursday."),
  A("releases", "alice", "checkout-api 4.13 is out: reliability fixes in the payments database layer."),
  A("releases", "bob", "payouts 1.6 is out: same-day USD payouts to US bank accounts (beta, 20 merchants)."),
  A("payments", "alice", "Deploy freeze for payments from 9 to 12 Nov for 11.11 sale traffic. Payment changes need two reviewers until then."),
  A("db-migration", "bob", "New blocker: the backfill job times out after 30 minutes on the 2024 partitions. Raised PAY-252."),
  A("db-migration", "alice", "Updated the DB migration plan with new dates: step 3 now targets 23 Oct, step 4 early November."),
  A("payments-incident", "alice", "pay-db-2 is being retired after the storage refresh. The failover target moves to pay-db-3; I'll update the runbook on the day."),
  dm("main", "alice", ["bob"], "For your on-call week: failover steps are in the Payment service runbook (Engineering/Runbooks). If the pool alert fires, page me before you promote the replica."),
  A("security", "carol", "To do: remove Acme's temporary access (postmortem draft, #acme-escalation) once the vendor review is done."),
  V("vendor-contracts", "carol", "Renewal decision due 15 Nov. Fallback: bring second-line support in-house."),
  V("general", "dave", "Heads-up: Acme's planned maintenance is on 18 Oct, 02:00 to 03:00 SGT. No downtime expected."),
];
