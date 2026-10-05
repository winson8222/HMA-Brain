// The demo story's Slack side: every channel message and DM, in order. `npm run seed:story` posts them all
// (each as its author) and builds the Drive folder. What's in it and who sees what: docs/demo-data.md.
//
// The story: Company A is a payments company; Acme is the vendor that processes its card payments. One evening
// checkout broke. Alice fixed it and wrote a postmortem. Acme has follow-up work from it, so Carol shared the
// postmortem with Dave (Acme) in the Vendors workspace; it has confidential merchant data, so she takes his
// access back once he's done. Bob, the junior engineer, only knows payments were down and are fixed.
//
// Most messages are ordinary company chatter ("noise") so the workspace looks real and search has something to
// wade through. Only the ones marked STORY carry the plot. No dates; clock times only inside the incident channel.
//
// Rules: public channels never carry the root cause, the follow-up tickets, merchant data or anything from the
// private channels. Plain language. No "&", "<" or ">" (Slack escapes them, which breaks the repeat check).

export type Who = "alice" | "bob" | "carol" | "dave";
export type WsKey = "main" | "vendors"; // "key" in slack-tokens.json

export type ChannelDef = { name: string; private: boolean; members: Who[]; general?: true; shown?: string };

// "general" is each workspace's default channel (found by is_general, whatever it's called).
export const CHANNELS: Record<WsKey, ChannelDef[]> = {
  main: [
    { name: "general", general: true, shown: "all-company-a", private: false, members: [] },
    { name: "payments", private: false, members: ["alice", "bob", "carol"] },
    { name: "engineering", private: false, members: ["alice", "bob", "carol"] },
    { name: "social", private: false, members: ["alice", "bob", "carol"] },
    { name: "payments-incident", private: true, members: ["alice", "carol"] },
    { name: "security", private: true, members: ["carol"] },
  ],
  vendors: [
    { name: "general", general: true, shown: "all-company-a-vendors", private: false, members: [] },
    { name: "acme-support", private: false, members: ["carol", "dave"] },
  ],
};

// A channel message, posted as `as` with their own user token (they must have clicked Connect). `id` names a
// thread's first message; `thread` makes this a reply to it.
export type Post = { ws: WsKey; channel: string; as: Who; text: string; id?: string; thread?: string };
// A DM or group DM, posted as `as`.
export type Dm = { ws: WsKey; as: Who; to: Who[]; text: string };
export type Step = Post | Dm;

const A = (channel: string, as: Who, text: string, extra: Partial<Post> = {}): Post => ({ ws: "main", channel, as, text, ...extra });
const V = (channel: string, as: Who, text: string, extra: Partial<Post> = {}): Post => ({ ws: "vendors", channel, as, text, ...extra });
const dm = (ws: WsKey, as: Who, to: Who[], text: string): Dm => ({ ws, as, to, text });

export const STORY: Step[] = [
  // ---- #all-company-a: office noise ----
  A("general", "carol", "Welcome to Company A's new Slack :wave: Engineering talk goes in #payments and #engineering, everything else in #social. Our vendors have their own workspace."),
  A("general", "carol", "Please welcome Bob to the payments team! He's our newest engineer and will start taking on-call shifts soon."),
  A("general", "carol", "Reminder: the all-hands is on Friday at 4. Slides will be in the Company folder in Drive afterwards."),
  A("general", "carol", "Annual security awareness training is due by the end of the month. The link is in the Employee handbook."),
  A("general", "carol", "The level 3 pantry is closed this week for repairs. Please use level 2."),

  // ---- #payments, before: team chatter ----
  A("payments", "alice", "Heads up: I'm on call this week. Priya is my backup."),
  A("payments", "bob", "Where do I find the runbooks? Still learning my way around.", { id: "runbooks" }),
  A("payments", "alice", "Drive, Engineering folder, then Runbooks. Start with the Payment service runbook and the Incident response handbook.", { thread: "runbooks" }),
  A("payments", "bob", "Got it, thanks!", { thread: "runbooks" }),
  A("payments", "alice", "The new checkout release is out. Merchants in Singapore can now take PayNow QR payments."),
  A("payments", "bob", "Nice. Is there a dashboard for payment success rates I can look at?", { id: "dashboard" }),
  A("payments", "alice", "Yes, the payments dashboard. The link is in the Engineering README in Drive.", { thread: "dashboard" }),

  // ---- STORY: the outage, as everyone saw it (#payments) and as the incident team lived it (🔒#payments-incident) ----
  A("payments", "alice", "Payment API latency is spiking since 19:40, looking into it."),
  A("payments-incident", "alice", "Declaring a major incident: card payments at checkout are failing since 19:40. I'm leading."),
  A("payments-incident", "alice", "The payment database has run out of connections. Requests are queueing behind it."),
  A("payments-incident", "carol", "I'm here. I'll handle the status page and customer support."),
  A("payments", "bob", "Is checkout down? A merchant just emailed support about failed payments."),
  A("payments", "carol", "Yes, some card payments at checkout are failing right now. The team is on it. We'll update here every 30 minutes."),
  A("payments-incident", "alice", "Found the cause. The database migration I switched on yesterday makes every payment use two connections instead of one. At the dinner peak that was too many."),
  A("payments-incident", "alice", "Switching the migration off won't free the stuck connections quickly, so I'm failing over to the backup database. The runbook doesn't say which one is the current backup, checking with the database team."),
  A("payments-incident", "alice", "Found it, the backup is pay-db-2. That took 25 minutes we didn't have."),
  A("payments-incident", "carol", "Paged Acme's support desk at 19:52 in case it was on their side. They answered at 20:39. Their systems are fine, it's ours."),
  A("payments", "carol", "Update: still failing for some customers. A fix is in progress."),
  A("payments-incident", "alice", "Failed over to pay-db-2 at 20:48. Payments are going through again."),
  A("payments-incident", "alice", "Success rate is back to normal at 21:15. Calling it resolved. The migration stays off."),
  A("payments", "alice", "Resolved: card payments at checkout are working again. Thanks for your patience, everyone."),
  A("security", "carol", "Checked the auth and gateway logs for the checkout incident. Nothing unusual, this was not a security incident."),

  // ---- STORY: afterwards ----
  A("payments-incident", "alice", "Root cause of the payment outage: the database connection pool was exhausted after the migration flag was enabled."),
  A("payments-incident", "alice", "Follow-up tickets created: PAY-240 to raise the connection limit and PAY-241 to add an alert before the pool fills up."),
  A("payments-incident", "alice", "I've updated the Payment service runbook so the failover step names the backup database, pay-db-2."),
  A("payments-incident", "alice", "Postmortem is written, it's in Engineering/Postmortems in Drive. Carol, have a look before I share it wider."),
  A("payments-incident", "carol", "Read it, looks good. One thing: it lists the affected merchants and refunds. Keep that section to the incident team."),
  A("payments-incident", "carol", "Acme needs the timeline for their own follow-up, so I've shared the postmortem with Dave. I'll remove his access as soon as they're done."),
  A("payments-incident", "alice", "PAY-240 is done: connection limit raised from 200 to 400. The PAY-241 alert is live too."),
  dm("main", "alice", ["carol"], "Between us: the outage was my migration flag. I switched it on without checking how many connections it would use. Lesson learned."),
  dm("main", "carol", ["alice", "bob"], "Standup moves to 10:30 today, Alice and I are doing the incident review first."),
  A("payments", "alice", "For anyone who missed it: checkout had an outage last night for about 95 minutes. It's fixed, and the fixes to stop it happening again are in. Customer support has a script if merchants ask."),
  A("payments", "bob", "Glad it's sorted. Is there anything I should read so I'd know what to do if it happened on my shift?", { id: "learn" }),
  A("payments", "alice", "The Payment service runbook covers it, the failover steps are all there now.", { thread: "learn" }),

  // ---- #payments, after: back to normal ----
  A("payments", "bob", "The refund tool is throwing an error for payments older than 90 days. Anyone seen this?", { id: "refund-tool" }),
  A("payments", "alice", "Known issue, there's a ticket for it. Use the manual refund form for those in the meantime.", { thread: "refund-tool" }),
  A("payments", "alice", "Payments deploy freeze during the 11.11 sale week. Only urgent fixes, with two reviewers."),

  // ---- #engineering: noise ----
  A("engineering", "alice", "Deploys go out on Tuesdays and Thursdays. If you need one outside that, ask in here first."),
  A("engineering", "bob", "What's the process for getting a code review? Just tag someone?", { id: "review" }),
  A("engineering", "alice", "Tag the team. Payment changes need two reviewers, everything else one.", { thread: "review" }),
  A("engineering", "carol", "New laptops are being rolled out next month. IT will contact you to book a slot."),
  A("engineering", "alice", "The staging environment is being rebuilt this afternoon, expect it to be down for an hour or so."),
  A("engineering", "bob", "Staging is back, confirmed working."),
  A("engineering", "alice", "Reminder: the on-call rota is in the Engineering folder in Drive. Swaps are fine, just update the sheet."),
  A("engineering", "carol", "If you get a suspicious email, forward it to the security team. Don't click anything."),
  A("engineering", "alice", "We're moving our error tracking to a new tool next quarter. I'll share a doc when there's a plan."),

  // ---- #social: noise ----
  A("social", "bob", "Anyone up for futsal on Sunday at 5? I've booked a court near Tanjong Pagar.", { id: "futsal" }),
  A("social", "alice", "In, unless I get paged :sweat_smile:", { thread: "futsal" }),
  A("social", "carol", "Count me in.", { thread: "futsal" }),
  A("social", "bob", "Chicken rice at the hawker centre, anyone? Leaving at 12:45."),
  A("social", "carol", "Happy birthday Priya :tada: Cake in the level 2 pantry at 3."),
  A("social", "alice", "Anyone have a recommendation for a good dentist near the office?"),

  // ---- 🔒#security: Carol's notes (nobody else sees this channel) ----
  A("security", "carol", "Reminder to myself: review the vulnerability register before the quarterly audit. It's in the Security folder."),
  A("security", "carol", "Secret scanning is now on for every repository. Any key committed by mistake gets flagged within minutes."),
  A("security", "carol", "Acme's temporary access to the postmortem is on my list to remove once their follow-up is done."),

  // ---- Vendors workspace ----
  V("general", "carol", "Welcome to the Company A Vendors workspace. Dave from Acme Payments, our card processor, is the first one here :wave:"),
  V("general", "dave", "Thanks Carol! For anything urgent, page Acme's support desk, it's staffed around the clock. I'll pick up anything posted here on working days."),
  V("acme-support", "dave", "Heads-up: Acme has planned maintenance on the 18th, 2 to 3 in the morning Singapore time. No downtime expected."),
  V("acme-support", "carol", "Thanks. Please also send the monthly report to the Shared with Acme folder as usual."),
  V("acme-support", "dave", "Monthly report is uploaded to the Shared with Acme folder."),
  // STORY: the follow-up work
  V("acme-support", "carol", "Dave, we had a checkout outage last night. It wasn't on your side, but your desk took 47 minutes to answer our page. Can Acme look into that?", { id: "followup" }),
  V("acme-support", "dave", "Sorry to hear that. Yes, I'll raise it with our support lead. Can you share the timeline?", { thread: "followup" }),
  V("acme-support", "carol", "I've shared the postmortem with you in Drive, it has the full timeline. Please keep it within Acme, it has merchant details.", { thread: "followup" }),
  V("acme-support", "dave", "Got it, thanks. I'll confirm our side of the timeline by Friday.", { thread: "followup" }),
  dm("vendors", "carol", ["dave"], "Dave, please don't share the outage timeline with anyone outside Acme."),
  V("acme-support", "dave", "Timeline confirmed from our side. Our support lead is adding a second person to the night shift so pages get answered faster.", { thread: "followup" }),
  V("acme-support", "carol", "Thanks Dave, that closes it. I'll remove the postmortem share now.", { thread: "followup" }),
];
