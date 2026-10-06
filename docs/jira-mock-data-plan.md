# Jira demo data: step-by-step plan

[← Back to README](../README.md) · [Jira connector plan](jira-connector-plan.md) · [Demo data (Slack)](demo-data.md)

This plan sets up a Jira Cloud site whose data continues the Slack and Drive demo story: the checkout outage, the follow-up tickets PAY-240, PAY-241 and PAY-245, Carol's security work, and Dave's vendor requests. Most of it is done by **`npm run seed:jira`** (`src/connectors/jira/cli/seed.ts`). The main path is three parts:

1. **[Before seeding](#2-before-seeding-manual-15-min)** (manual, about 15 minutes): the site, the trial, the accounts and tokens the script can't create.
2. **[Run the seed](#3-run-the-seed)**: groups, roles, projects, fields, schemes, security levels, issues and comments.
3. **[After seeding](#4-after-seeding-manual)** (manual): the crawler's admin permission, Connect Jira, backfill and the acceptance test.

Section 5's tables are the **single source of truth** for the data. The seed script mirrors them. If you change a table, change the script too. [Appendix A](#appendix-a-manual-setup-if-you-cant-run-the-seed-or-to-check-what-it-did) has click-by-click steps to build the same data by hand, or to check what the seed did.

Written 2026-10-04. Atlassian renamed parts of the Jira UI during 2025–2026: **projects are now "spaces"**, **issues are now "work items"**, **issue security is now "work item security"** and **project roles are now "space roles"**. This plan uses the old terms because the REST API, the connector code and [jira-connector-plan.md](jira-connector-plan.md) still use them. If a menu label doesn't match what you see, look for the same words with "space" or "work item" in place of "project" or "issue".

**Verified on a real site (2026-10-04).** The setup was run end to end on `hma-brain-demo.atlassian.net`. Steps marked ✔ *verified* match what Atlassian's UI and API actually did that day. The rest comes from Atlassian's docs.

**Nothing here goes in git except this file.** Never paste an API token, the OAuth client secret or Carol's real email into a doc, a commit or a chat.

## Scenario description

Company A runs an online payment service. Alice enabled the migration flag `tx_schema_v2` for the transactions database. While the migration runs every payment holds two connections, so one Saturday evening the connection pool on `pay-db-1` ran out and from 19:40 to 21:15 18% of checkouts failed. Acme's support desk took 47 minutes to answer the page. Slack and Drive already tell this story ([demo-data.md](demo-data.md)). Jira holds the tickets everyone refers to.

- **The engineering follow-ups** live in **PAY**. PAY-231 is the migration step blocked by a schema lock. The outage follow-ups, PAY-240 (connection limit from 200 to 400), PAY-241 (alert when the pool is over 80% full) and PAY-245 (name the backup database in the runbook), are done and visible only to the incident team (Alice and Carol), so Bob never learns the root cause. PAY-242 is a small SEV4 found during the outage. PAY-243 estimates the cost of bringing second-line support in-house instead of renewing Acme, and only leadership (Carol) may see it. PAY-244 sends P1 incident notifications to Acme, the support vendor. Acme's team follows that ticket because the `vendors` group is named in its **Owning team** field.
- **Carol's security work** lives in **SEC**. SEC-1 is the leaked payment gateway API key (revoked within the hour). SEC-2 is CVE-2026-1234 in the auth service, now overdue. Both are restricted to the security team. SEC-3 is a phishing email that **Bob reported**, so Bob can follow it even though he can't see the rest of SEC.
- **Acme's requests** live in **VEND**. Dave filed VEND-1 (share the outage timeline so Acme can look into its 47-minute page response) and VEND-2 (Acme's monthly report), so he sees those. VEND-3 (points for the Acme renewal meeting) is internal. VEND-4 asks **Alice** to check Acme's side of the timeline against the postmortem, so she sees it as the assignee. VEND-5 asks **Bob**, on call next week, to approve Acme's dashboard access. Bob sees it only because he's named in its **Approvers** field.
- One comment on PAY-240, *restricted to Administrators*, asks to keep the name of whoever switched the flag on out of the postmortem before it goes to Acme. It must never be indexed.

What each person should find, and why:

| Persona | Should find | Should not find |
|---|---|---|
| **Alice** (payments engineer, led the incident) | All of PAY except PAY-243 (Engineers role, via `payments-eng`; the follow-ups through the "Incident team" level). VEND-4 (assignee). | PAY-243 (security level), all of SEC (no Browse), VEND-1/2/3/5 (not reporter, assignee or approver), the restricted comment |
| **Bob** (engineer, new, not on the incident team) | PAY-231, PAY-242, PAY-244 (Engineers role). SEC-3 (reporter). VEND-5 (Approvers field). | PAY-240/241/245 ("Incident team" level), PAY-243, SEC-1/2, VEND-1–4, the restricted comment |
| **Carol** (security lead, admin) | Everything: PAY (Engineers role, as a user), SEC and VEND (`security` group), PAY-240/241/243/245 and SEC-1/2 (member of every security level) | The restricted comment, in the app only. She can read it in Jira, but it's never indexed. |
| **Dave** (Acme contractor) | VEND-1, VEND-2 (reporter). PAY-244 (`vendors` group in the Owning team field). | Everything else: no Browse in PAY, SEC or VEND otherwise |

Which permission mechanism each part demonstrates:

| Mechanism | Where |
|---|---|
| Project role (expanded to a group and a user) | PAY: role Engineers = group `payments-eng` + Carol |
| Group | SEC and VEND: group `security`; the crawler's `brain-crawler` everywhere |
| Reporter | SEC-3 (Bob), VEND-1 and VEND-2 (Dave) |
| Assignee | VEND-4 (Alice) |
| User picker field | VEND-5: Approvers = Bob |
| Group picker field | PAY-244: Owning team = `vendors` (Dave) |
| Issue security level | PAY-240, PAY-241, PAY-245 (Incident team), PAY-243 (Leadership only), SEC-1 and SEC-2 (Security team only) |
| Restricted comment (never indexed) | PAY-240, Carol's comment restricted to Administrators |

## The people

| Persona | Email | Role in the story | Jira groups |
|---|---|---|---|
| **Alice** | `ALICE_EMAIL` (alicehmatest@gmail.com) | Payments engineer. Her migration flag caused the outage. | `payments-eng` |
| **Bob** | `BOB_EMAIL` (bobhmatest@gmail.com) | Engineer, on call for payments. | `payments-eng` |
| **Carol** | `CAROL_EMAIL` (the owner's own address; keep it a placeholder) | Security lead. Owns the site and is its admin. Runs the seed. | `security` |
| **Dave** | `DAVE_EMAIL` (davehmatest@gmail.com) | External contractor at Acme (vendor). | `vendors` |
| **Crawler** | a new, dedicated address (`JIRA_EMAIL`) | The account the connector signs in as. Not a person in the story. | `brain-crawler` |

"Who does it" tags on each step: **[Carol]**, **[Crawler]** (signed in as the crawler account), **[Alice]**, **[Bob]**, **[Dave]**, **[each persona]**, or **[you, on the laptop]** (whoever runs the app and the seed).

Tip: use one browser profile (or a private window) per persona. Atlassian keeps you signed in, and it's easy to do a step as the wrong person.

### Accounts at a glance

The trial belongs to the **site**, not to an account. Carol creates the site and starts the trial once; everyone she invites gets the paid features automatically.

| Account | What it does in Jira | Starts a trial? | How it gets onto the site |
|---|---|---|---|
| **Carol** | Creates the site, is its admin, runs the seed (her token = `JIRA_ADMIN_*`) | ✅ the only one | Creates it (2.1) |
| **Crawler** | The account HMA Brain signs in as (`JIRA_EMAIL` / `JIRA_API_TOKEN`) | ❌ | Seed invite (2.5) |
| **Alice, Bob, Dave** | Demo personas | ❌ | Seed invite (2.5) |

- **Nobody but Carol signs up for Jira.** "Get it free" on atlassian.com from any other account creates a separate, empty site. Everyone else joins Carol's site by accepting the invite email.
- **Accept each invite with that exact email** (Bob as `BOB_EMAIL`, and so on); otherwise the seed won't find them on the next run. Someone who already has an Atlassian account (e.g. Alice, from an earlier site) just accepts; their old site doesn't matter.
- **Never use a persona as the crawler or the admin.** That persona would see everything in the demo.

## How HMA Brain connects to Jira

There are **two separate connections**, each with one job.

**1. The crawler: HMA Brain's server ↔ your Jira site.** The server signs in as the crawler (`JIRA_EMAIL` + `JIRA_API_TOKEN`) and, under that one account:
- **copies issues in**: every issue in PAY, SEC and VEND, with comments, into the `brain-jira` index (`jira:backfill`, and every poll when `JIRA_SYNC=on`);
- **reads permissions**: schemes, roles, groups, security levels and picker fields, stored as labels on each issue (this is why it needs Administer Jira, 4.1);
- **checks live on every search**: "can this person browse these issues right now?" Jira answers that about another person only for an admin.

It has to see everything, which is why `brain-crawler` is in every Browse grant and every security level. It's a system account, not a person in the story: nobody searches as it, and nobody's results come from it.

**2. Connect Jira: each person ↔ their own Atlassian account.** Once per person (4.6), they prove which Atlassian account is theirs, and HMA Brain stores `person → Atlassian account ID`. **No issue data moves through this connection.** It only answers "whose permissions apply?"

When Alice asks a question:

```
Alice asks "what's the status of the pool limit fix?"
  ├─ Connect Jira link   → Alice = Atlassian account 712020:…
  ├─ crawler (cached)    → that account's groups: payments-eng
  ├─ search brain-jira   → only issues labelled for her account or groups (PAY-240, never PAY-243 or SEC-1)
  ├─ crawler live check  → "can 712020:… browse PAY-240 now?" → yes
  └─ answer from PAY-240, alongside any Slack and Drive results
```

| Piece | Lives in | Used for |
|---|---|---|
| Crawler token | `.env` (`JIRA_API_TOKEN`) | Reading issues and permissions, live checks |
| OAuth app client ID / secret | `.env` (`JIRA_OAUTH_CLIENT_*`) | The Connect Jira sign-in |
| Each person's link | `brain-jira-state` index (person → account ID only) | Knowing whose permissions to apply |
| Issue copies and labels | `brain-jira` index | Fast search |
| Carol's admin token | `.env` (`JIRA_ADMIN_*`) | **Only** `seed:jira`; the app never uses it |

Without the crawler there's nothing to search; without a person's link, that person gets no Jira results (their Slack and Drive results are unaffected).

---

## 1. Prerequisites and plan choice

### What the demo needs from Jira

| Feature | Why the demo needs it |
|---|---|
| Custom **permission schemes** | Each project must grant Browse Projects to different people. |
| **Project (space) roles** you can fill per project | The connector expands role grants into users and groups. One grant must use a role. |
| **Issue (work item) security levels** | The second permission layer: PAY-240/241/243/245, SEC-1 and SEC-2 are hidden from people who can otherwise browse the project. |
| **Custom fields** (user picker, group picker) usable in permission grants | Browse granted to whoever is named in Approvers (VEND-5) or Owning team (PAY-244). |
| **Administer Jira** global permission for the crawler | Without it the crawler can't read schemes or ask Jira "can this person see this issue?", and every Jira result is withheld. |
| 5 users | Carol, Alice, Bob, Dave and the crawler. |

### What the Free plan can't do

Atlassian's page [Permissions limitations in Free Jira sites](https://support.atlassian.com/jira-cloud-administration/docs/permissions-and-issue-level-security-in-free-plans/) says Free sites can't assign space roles, can't configure work item security schemes, and can't restrict permissions using schemes. On an always-free site, everyone with Jira access is effectively a project admin and can see everything. That breaks the whole demo: Dave would see the security tickets. The seed would also fail when it tries to create the schemes.

Free does allow up to 10 users ([Explore Jira Cloud plans](https://support.atlassian.com/jira-cloud-administration/docs/explore-jira-cloud-plans/)), so the user limit isn't the problem. Permissions are.

### What to use instead

Use **Jira Standard** (or Premium). Per [Explore Jira Cloud plans](https://support.atlassian.com/jira-cloud-administration/docs/explore-jira-cloud-plans/), Permissions and Roles and work item security start at Standard, and a Free site can try **Standard free for 14 days** or **Premium free for 30 days**.

Recommendation: start the **Premium 30-day trial** if the demo has to last more than two weeks, otherwise the Standard trial. Nothing here needs a Premium-only feature.

**When the trial ends** and you don't pay, the site drops to Free. The same Atlassian page says existing permission schemes, roles and security schemes are *preserved but can't be edited*. So the demo data should keep working, read-only, but the seed can no longer fix schemes. **Not verified:** whether `permissions/check` and the scheme endpoints behave exactly the same on a downgraded site. Run `npm run jira:doctor` after any plan change.

**Couldn't confirm:** whether starting a trial asks for card details. If it does, Carol enters them herself on Atlassian's billing page; nobody else should.

---

## 2. Before seeding (manual, ~15 min)

Only what the script can't do.

### 2.1 Create the site and start the trial **[Carol]** ✔ *verified*

> **Whoever signs up first owns the site.** Do this in a **private window** (or Carol's own browser profile), so you aren't already signed in to Atlassian as someone else. On the real run, the first attempt happened while signed in as Alice, which created a site named after Alice (with an auto-created KAN board) owned by Alice. The fix was to start over as Carol. The stray site can be ignored or deleted. Renaming a site URL needs a paid plan and is limited to 3 times, so don't plan on fixing it that way.

1. In a private window, go to atlassian.com → Jira → **Get it free**. Atlassian shows **Create your account**: enter `CAROL_EMAIL` and a **Full name** (e.g. "Carol HMA"), then verify the email. The person who creates the site is its site admin, which the seed needs.
2. Name the site, for example `hma-brain-demo`. The site URL becomes `https://hma-brain-demo.atlassian.net`. This is `JIRA_BASE_URL`.
3. Skip the onboarding questions. Onboarding may create a **team-managed KAN project** anyway. Ignore it (`JIRA_PROJECTS=PAY,SEC,VEND` keeps it out of the index) or delete it. Don't create any issues by hand in a project called PAY, or the seed can't get the keys PAY-231 and PAY-240..245 (see troubleshooting).
4. Start the paid-plan trial: ⚙ **Settings** (top right) → **Billing** → find Jira under your subscriptions → **Change plan** → **Standard** (or Premium) → **Start trial**. The exact wording varies; look for "Change plan", "Upgrade" or "Try Standard". You can also reach it from admin.atlassian.com → **Billing**.
5. Check the plan: admin.atlassian.com → **Directory** → **Users** → Carol → the Jira app-access row shows the plan. On the real site it showed **Premium**, so the trial was active. You can also open `https://<site>.atlassian.net/secure/admin/ViewPermissionSchemes.jspa`: it should open without an "upgrade" message.

### 2.2 Choose the crawler's email **[Carol]**

The crawler is a **normal Atlassian user** with its own email. It is **not** a persona, for the same reason Drive uses a dedicated admin: if Alice were the crawler, she'd hold admin rights and her own account would appear in every grant. It counts as a user (a seat).

**Don't use Atlassian's "service account" feature** (admin.atlassian.com → Directory → Service accounts). Those accounts can only create *scoped* API tokens, and scoped tokens must call `https://api.atlassian.com/ex/jira/{cloudId}/...` with a Bearer header ([Manage API tokens for service accounts](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)). The connector calls `JIRA_BASE_URL` directly with Basic auth (`client.ts`), which needs a normal account and a classic token.

1. Pick an address you control, for example a Gmail plus-address like `<owner>+jira-crawler@gmail.com`, or a separate mailbox (the real run used a separate Yahoo mailbox). This is `JIRA_EMAIL`. In admin.atlassian.com it shows as **External user**, because its email domain isn't managed by your organization. That's fine. ✔ *verified*
2. You don't need to invite it by hand: the seed invites it on its first run (2.5). Its API token comes after it has accepted (2.6).

### 2.3 Carol's API token for seeding **[Carol]**

✔ *verified.* The same steps work for the crawler (2.6) and for the personas' optional tokens.

1. Signed in as Carol, open **https://id.atlassian.com/manage-profile/security/api-tokens**. Or: avatar → **Manage account** → **Security** → **Create and manage API tokens**.
2. **Create API token**: the plain one, **not** "Create API token with scopes". Name it `hma-brain-seed`, pick a short expiry (a few days is enough), **Create**, **Copy**. Atlassian shows the token **only once**.
3. Paste it straight into `.env` as `JIRA_ADMIN_API_TOKEN`.

This token acts as a **site admin**. Only the seed uses it; the connector never does. Revoke it on the same page once the demo data is in place, and create a new one if you need to seed again.

### 2.4 Put the seed's variables in `.env` **[you, on the laptop]**

Names only. Never commit `.env`.

| Variable | Value | Needed for |
|---|---|---|
| `JIRA_BASE_URL` | `https://<site>.atlassian.net` | seed and connector |
| `JIRA_ADMIN_EMAIL` | `CAROL_EMAIL`'s value (the site admin) | seed only |
| `JIRA_ADMIN_API_TOKEN` | Carol's token from 2.3 | seed only |
| `JIRA_EMAIL` | the crawler's address from 2.2 | seed (to find or invite it and add it to `brain-crawler`) and connector |
| `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL` | already set for the Slack seed | seed |
| `ALICE_JIRA_API_TOKEN`, `BOB_JIRA_API_TOKEN`, `DAVE_JIRA_API_TOKEN` | *optional.* Each persona's own classic token, created by that persona the same way as 2.3. With it, their comments are posted as them; without it, Carol posts them "On behalf of …". | seed only |
| `CAROL_JIRA_ACCOUNT_ID`, `ALICE_JIRA_ACCOUNT_ID`, `BOB_JIRA_ACCOUNT_ID`, `DAVE_JIRA_ACCOUNT_ID`, `CRAWLER_JIRA_ACCOUNT_ID` | *optional.* Only if the seed says it can't find someone by email (their email is hidden). See troubleshooting for how to find an account ID. | seed only |

**Check before you run the seed:** `JIRA_BASE_URL`, `JIRA_ADMIN_EMAIL`, `JIRA_ADMIN_API_TOKEN`, `JIRA_EMAIL` (the crawler), `JIRA_PROJECTS=PAY,SEC,VEND` and the four persona emails are set. `JIRA_API_TOKEN` (the crawler's, 2.6) and the optional persona tokens come next. **Set the persona tokens before the run that creates the issues**: comments are only posted when an issue is first created, so a token added later doesn't change who wrote them. `JIRA_SYNC=on` is fine to set now.

There are **no separate "Jira emails"** for the personas: the seed reuses `CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL` and `DAVE_EMAIL`, the same variables the Slack and Drive demos use. `JIRA_EMAIL` is the crawler and `JIRA_ADMIN_EMAIL` is Carol.

The seed looks people up **by email only to build the demo data**. The app itself never matches anyone by email: each person links their own Atlassian account with Connect Jira (4.6).

### 2.5 First run: invites **[you, then Alice, Bob, Dave, Crawler]**

1. **[you]** `npm run seed:jira`.
2. On a new site, nobody but Carol has an account yet. The seed invites everyone it can't find (Alice, Bob, Dave and the crawler) with Jira access, then **stops** and lists who has to accept the invite email. That's expected.
3. **[each invitee]** Open the email "… invited you to Jira" in that mailbox → **Accept invite** / **Join now** → sign in with **Continue with Google** using that same address, or create an Atlassian account with it. For the crawler, name it "HMA Brain crawler" so it's obvious in user pickers.
4. Landing on an empty Jira home page is correct.
5. **[Carol]** Optional check: admin.atlassian.com → **Directory** → **Users**. Everyone shows **Active** (not "Invited"), with Jira access on your site. On the real run, Alice, Bob, Dave and the crawler all had Jira access on `hma-brain-demo` before the full seed run, and their tokens worked. ✔ *verified*

### 2.6 The crawler's API token **[Crawler]**

1. Signed in as the crawler: **https://id.atlassian.com/manage-profile/security/api-tokens** → **Create API token** (plain, not "with scopes"). Name it `hma-brain`, pick the longest expiry offered, **Create**, **Copy** (shown only once).
2. Paste it into `.env` as `JIRA_API_TOKEN`. Put a reminder in your calendar for when it expires.

You can do this step later, during [After seeding](#4-after-seeding-manual); the seed doesn't need it.

---

## 3. Run the seed

**[you, on the laptop]**

```bash
npm run seed:jira
```

Run it again after everyone has accepted their invite. The output is grouped under headings: **People, Groups, Roles, Projects, Work types, Picker fields, Permission schemes, Issue security, Issues** ✔ *verified*. It's **idempotent**: safe to re-run at any time. It finds things by name and fixes them to match section 5. The exceptions are issues and comments; see below.

### What it does, in order

1. **People.** Finds the four personas and the crawler (by email, or by `*_JIRA_ACCOUNT_ID`). Invites anyone missing and stops (2.5).
2. **Groups.** Creates `payments-eng` (Alice, Bob), `security` (Carol), `vendors` (Dave) and `brain-crawler` (crawler), and syncs their members to exactly that.
3. **Roles.** Finds **Administrators** and creates the project role **Engineers**. On the real site the existing roles were Administrator, atlassian-addons-project-access, jira-guest-member, Member and Viewer; the seed listed "Administrators" and "Engineers" ✔ *verified*.
4. **Projects.** Creates PAY, SEC and VEND as company-managed Kanban projects with lead Carol. Syncs role memberships **exactly** as in 5.2, and removes any other actors Jira added.
5. **Work types.** A new site may have only **Epic** and **Story** (the real one did ✔ *verified*). The seed creates **Task** and **Bug** if they're missing and adds them to the PAY, SEC and VEND work type schemes.
6. **Picker fields.** Creates **Approvers** (multi-user picker) and **Owning team** (group picker), and adds each to its project's screens: those whose name starts with `VEND:` or `PAY:`. The field **context is left global**, not limited to one project. This differs from the manual step (A.6) and is harmless: only VEND's scheme grants on Approvers, and only PAY's on Owning team.
   - **An existing field with the same name is reused only if it's searchable.** Some sites already have a Jira-created "Approvers" field with no search template. The real site did (`customfield_10003`), and Jira refused it in a permission grant (see troubleshooting). The seed now tries to add a search template to it; if it can't, it creates its own "Approvers" field and warns.
   - **Field IDs differ per site.** On the real site Owning team became `customfield_10043`. Use the IDs the seed and `jira:doctor` print, not the examples in this doc.
7. **Permission schemes.** Creates or updates `PAY permission scheme`, `SEC permission scheme` and `VEND permission scheme` with exactly the grants in 5.5, and assigns each to its project.
8. **Issue security.** Creates `PAY security` and `SEC security` with the levels and members in 5.6, and assigns them. Assignment is asynchronous in Jira; if a level isn't on the project yet, re-run.
9. **Issue keys.** Gets the exact keys PAY-231 and PAY-240..245 by creating throwaway placeholder issues and deleting them at the end. If PAY's counter is already past a key (for example, issues were created by hand before), it **warns and skips that issue** instead of guessing.
10. **Issues.** Creates every issue in 5.7, including PAY-244, with reporter, assignee, labels, security level and picker values. Then it moves each one to its status.
11. **Comments.** Adds the comments in 5.7. A comment by Alice, Bob or Dave is posted **as that person** only if their `*_JIRA_API_TOKEN` is set. Otherwise Carol posts it, starting with "On behalf of <Name>:", and the script says so. The PAY-240 restricted comment is posted with visibility **role Administrators**.

**Existing issues** (matched by key) are left alone, not edited, so manual edits made during the demo survive a re-run. Comments are only added when the issue is newly created.

**To bring existing issues in line with section 5.7** (after `seedData.ts` changes, or to undo demo edits), run:

```bash
npm run seed:jira -- --update
```

For every issue that already exists it rewrites summary, description, labels, reporter, assignee, picker values and security level, and moves it to its status. Its comments are compared with 5.7 (text and restriction, in order, ignoring the "On behalf of" prefix). If they differ, all of the issue's comments are deleted and the seeded ones are posted again, so they get today's date. Missing issues are created as usual. The work type isn't changed; the seed warns if it differs.

**Don't delete an issue to reset it.** Jira never reuses an issue number, so a deleted PAY-240 can't be created again: the seed would warn that the counter is past it and skip it. Use `--update` instead.

### What it does not do

| Not done by the seed | Where |
|---|---|
| Give the crawler **Administer Jira** (done through the crawler's app role in admin.atlassian.com) | 4.1 |
| Set the crawler's time zone (optional) | 4.2 |
| Create the Atlassian **OAuth app** for Connect Jira | 4.3 |
| The Connect Jira clicks | 4.6 |
| Backdate created dates: they show the seed date (the story has no dates, so nothing contradicts it) | — |
| Site creation, the trial, accepting invites, API tokens | 2 |

---

## 4. After seeding (manual)

### 4.1 Give the crawler Administer Jira **[Carol]** ✔ *verified*

**Don't use** Jira's ⚙ Settings → System → **Global permissions** page. On the real site its **Grant Permission** dropdown didn't offer Administer Jira at all. It listed only: Browse users and groups, Share dashboards and filters, Manage group filter subscriptions, Make bulk changes, the Atlassian Home issue glance, Create team-managed spaces, and Manage custom onboarding.

What worked:

1. **admin.atlassian.com** → **Directory** → **Users** → open the crawler (e.g. "crawler HMA").
2. **Apps** tab → the **Jira** row for your site (`hma-brain-demo`) → **Roles** dropdown.
3. Tick **both** **User** and **User access admin** → save.

The UI describes User access admin as "No app access. Can administer users and groups for this app in Atlassian Administration". Even so, afterwards the API reported **ADMINISTER = true** for the crawler (checked with `GET /rest/api/3/mypermissions?permissions=ADMINISTER`). Keep **User** ticked as well, or the crawler loses Jira access.

Fallbacks, if your site looks different:
- If the Roles dropdown offers an **Administrator** / **App admin** role for Jira, use that (with User).
- Otherwise, on the crawler's page, use **Add to group** and add it to your site's Jira admin group. **Don't** add it to `org-admins`: that makes it an organization admin. (For reference, Carol's groups on the real site were `jira-users-hma-brain-demo`, `org-admins` and `security`.)

Check: `npm run jira:doctor` prints `ok    service account has Administer Jira`.

Administer Jira does **not** let the crawler see issues. Browse comes from each scheme, and restricted issues need security-level membership. The seed sets both through `brain-crawler`.

### 4.2 Crawler time zone **[Crawler]** (optional)

Any zone works: the connector reads it from `/myself` for JQL dates, and `jira:doctor` prints it. On the real site it came out as **Asia/Singapore**, and nothing needed changing ✔ *verified*. If you want to change it: profile picture → **Manage account** → **Account preferences** → time zone. Restart the server if you change it while it's running.

### 4.3 Connect Jira OAuth app **[Crawler, recommended; or Carol]**

This registers HMA Brain with Atlassian, so the **Connect Jira** button can show an Atlassian sign-in and learn the person's account ID. It asks only for `read:me` and reads no Jira data. It's like a website registering with Google before it can offer "Sign in with Google".

**Done once in total, by one account.** Not once per person:

| | How many times | Who |
|---|---|---|
| Create the OAuth app (developer console → client ID and secret into `.env`) | **Once** | One account: the crawler (recommended) or Carol |
| Click **Connect Jira** | **Once per person** | Alice, Bob, Carol, Dave, each for themselves (4.6) |

People who connect **never** create an app or see the developer console. They click Connect Jira, sign in to Atlassian and click Accept.

**Why the app needs an owner account:** Atlassian requires every app to have one. The owner holds the client secret (and rotates it if it leaks), sets the callback URL and the sharing setting, and is who Atlassian contacts or holds accountable. The consent screen also tells people which app is asking. **Any free Atlassian account can own it**: it doesn't have to be on your site or be a Jira admin. The crawler is the tidier choice because it's a system account, so the app doesn't depend on a person's login.

**It isn't tied to your site.** The app is registered under its owner's account, not under `hma-brain-demo`, and only answers "who is this person?". The same app would work for any Atlassian account and any site. What a person can *see* still depends on your site, because the crawler checks their account against it.

**Why not just use the crawler's token?** The crawler's token only proves "I am the crawler". It can't tell HMA Brain which Atlassian account belongs to Alice; only Alice can, by signing in to Atlassian herself.

1. Signed in as the owner: developer.atlassian.com → profile icon → **Developer console** → **Create** → **OAuth 2.0 integration**. Name it "HMA Brain Connect Jira". The owner reads and accepts the developer terms.
2. **Permissions** → **User identity API** → **Add** → **Configure** → tick `read:me` → **Save**.
3. **Authorization** → OAuth 2.0 (3LO) → **Configure** → Callback URL: `<PUBLIC_URL>/connect/jira/callback` (for local use, `http://localhost:3000/connect/jira/callback`) → **Save**.
4. **Distribution** → **Edit** → turn on **Enable sharing**. Fill in the required fields: vendor name and privacy policy URL (for a private demo, your own name and a placeholder page are fine). The app stores the Atlassian account ID and display name, so answer the personal-data question accordingly. **Without sharing, only the app's owner can authorize it, and Alice, Bob and Dave get an error when they click Connect Jira** ([OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)).
5. **Settings** → copy **Client ID** and **Secret** into `.env` (`JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`).

### 4.4 The rest of `.env` **[you, on the laptop]**

| Variable | Value |
|---|---|
| `JIRA_API_TOKEN` | the crawler's token (2.6) |
| `JIRA_PROJECTS` | `PAY,SEC,VEND` |
| `JIRA_OAUTH_CLIENT_ID` / `JIRA_OAUTH_CLIENT_SECRET` | from 4.3 |
| `JIRA_REDIRECT_URI` | leave unset unless the callback isn't `<PUBLIC_URL>/connect/jira/callback` |
| `JIRA_SYNC` | `on` while demoing, so edits show up within a minute; `off` otherwise |
| `PUBLIC_URL` | must match the callback host in 4.3 |

You can now revoke Carol's seed token (2.3) if you won't re-seed soon.

### 4.5 Doctor and backfill **[you, on the laptop]**

```bash
npm run jira:doctor     # expect: Administer Jira ok; PAY, SEC, VEND with browse labels; PAY with 2 security levels, SEC with 1; Connect Jira set up
npm run jira:backfill   # index every issue in PAY, SEC, VEND
```

Expected doctor lines (roughly):
- `PAY: 3 browse label(s) + group field customfield_MMMMM, 2 security level(s)`. The labels are the crawler group, plus the `payments-eng` group and Carol's user from the Engineers role. MMMMM is Owning team's field ID.
- `SEC: 2 browse label(s) + reporter, 1 security level(s)`
- `VEND: 2 browse label(s) + reporter + assignee + user field customfield_NNNNN`. NNNNN is the Approvers field ID.
- There must be **no** "skipped grants we can't label yet (userCustomField / groupCustomField)" warning in the backfill output.
- `warn  nobody has connected Jira yet` until 4.6 is done.
- Field IDs differ per site (on the real site Owning team was `customfield_10043`). Compare against the IDs the seed printed.

Then start the app (`npm run dev`) so the Connect page and polling are live.

### 4.6 Each persona links their account **[each persona]**

Connect Jira needs the person signed in to the app, which today means Slack sign-in on the Connect page.

> **The link is made between the person signed in to HMA Brain and whichever Atlassian account is signed in in that same browser.** If Carol's Atlassian session is still open when Alice clicks Connect Jira, Alice gets linked to Carol's account. Use **one browser profile per persona**, signed in to both Slack/HMA Brain and Atlassian **as the same person**, and check the account on Atlassian's consent screen before accepting. Afterwards the Connect page shows **"Linked to <name>"**. If it's the wrong name, click **Disconnect** and connect again from the right profile.

1. In that persona's browser profile, open `<PUBLIC_URL>/connect.html` and sign in with Slack as that persona.
2. In the **Jira** card, click **Connect Jira**.
3. Atlassian shows "**HMA Brain is requesting access to your Atlassian account**", with "In User, it would like to: View → me". ✔ *verified*
   - **"Install app on: Choose a site"** is required even though the app only reads your profile. Pick **your demo site** (e.g. `hma-brain-demo.atlassian.net`). The choice doesn't change anything for HMA Brain: it only learns who you are, and Jira results always come from the demo site through the crawler and your permissions there. Accept stays greyed out until a site is chosen.
   - **The site list tells you who you're signed in as.** It lists every site that Atlassian account belongs to. On the real run, Alice's screen also listed `alicehmatest.atlassian.net` (her accidental first site), which confirmed it was Alice. Bob and Dave typically see only the demo site. If the list shows a site belonging to someone else, you're in the wrong browser profile: click **Cancel**.
   - Check the account is that persona's (`ALICE_EMAIL` etc.), then **Accept**.
4. Back on the Connect page: "Connected Jira …", and the Jira card shows "Linked to <name>". Check the name.
5. Repeat for Alice, Bob, Carol and Dave.
6. **[you]** `npm run jira:doctor` now lists four `person → account` links, each with several keys.

In Demo mode (`ALLOW_IMPERSONATION=on`), acting as someone who hasn't linked shows nothing from Jira. That's the fail-closed rule, not a bug. So each persona must connect once **before** the demo. The link persists until they click Disconnect.

**What the link is, and isn't.** Connecting doesn't log anyone in to Jira or to HMA Brain (HMA Brain sign-in is still Slack). What happens:
1. **Connect Jira** goes to `/connect/jira/start`, which sends the person to Atlassian with the app's client ID and a signed `state` saying who started it.
2. They sign in to Atlassian and click **Accept**.
3. Atlassian sends them back to `/connect/jira/callback`. HMA Brain checks that the `state` is genuine and that the same person is still signed in to HMA Brain in that browser. If not, it refuses.
4. HMA Brain trades the one-time code for a short-lived token, reads the account ID from `api.atlassian.com/me`, and **throws the token away**.
5. It stores `{ person, Atlassian account ID, display name, date }` in `brain-jira-state`. One Atlassian account belongs to one person: linking it again moves it.

It never stores the person's password, OAuth token or refresh token, and it can't act as them in Jira. Disconnect deletes the link.

### 4.8 Adding more test users later

The same OAuth app works for every Atlassian account, as long as **Enable sharing** is on (4.3); no new app per person. For someone new to get Jira results, all three must be true:

1. **They can sign in to HMA Brain** (Slack Connect on the Connect page).
2. **Their Atlassian account is on your site with Jira access.** Invite them in admin.atlassian.com, or add them to the seed's personas.
3. **Jira permissions let them see something**: a group (`payments-eng`, `security`, `vendors`), a project role, or being the reporter, assignee or approver on an issue.

Then they click Connect Jira once. **Linking alone grants nothing.** An account that isn't on your site, or has no permissions there, simply gets no Jira results, because the live check asks your site.

### 4.9 Other people running HMA Brain

- **A teammate running their own copy of HMA Brain** (their own server, their own `.env`) needs a client ID and secret too. Either share yours privately (never in git), adding their callback URL to the app if it differs (`http://localhost:3000/...` works for anyone on port 3000), or they create their own app the same way. Their users still just click Connect Jira.
- **Another company using HMA Brain:**
  - **Self-hosted** (they run their own copy, like this demo): their admin does this setup once for their site. That means their own OAuth app, plus a crawler account in their Jira with an API token and Jira admin. Their employees only click Connect Jira.
  - **Offered as a product to many companies:** you register **one** OAuth app for HMA Brain (shared or publicly distributed), and every company's users connect through it. The crawler changes: instead of each customer creating an account and sending you a token, their Jira admin approves HMA Brain once for their site (OAuth with Jira read scopes, or an Atlassian Forge/Connect app), and HMA Brain stores that site's credentials in an encrypted per-customer store instead of `.env`. Labels, the live check and Connect Jira stay the same. Atlassian asks for privacy and security declarations before an app is distributed widely; a Marketplace listing is optional unless you want customers to find it there.

Today's code fits the self-hosted model.

### 4.7 Acceptance

Work through the [who-sees-what matrix](#6-who-sees-what-the-acceptance-test), the [demo questions](#7-demo-questions) and the [checklist](#8-verification-checklist-and-troubleshooting).

---

## 5. Demo data (the seed mirrors these tables)

### 5.1 Groups

| Group | Members | Used for |
|---|---|---|
| `payments-eng` | Alice, Bob | PAY access (through the Engineers role), VEND assignable users, SEC "create" |
| `security` | Carol | SEC and VEND access |
| `vendors` | Dave | Named in PAY-244's Owning team field, which grants Browse on that one issue. No scheme grants Browse to the group itself. |
| `brain-crawler` | the crawler | Browse on every project and every security level. (Administer Jira comes from the crawler's app role, not from this group; see 4.1.) |

Why the connector keys groups by **ID**: group names can be renamed in admin.atlassian.com, and Jira's API marks the name parameter as deprecated. A label like `jira:<site>:group:<groupId>` stays correct after a rename; a name-based label would silently stop matching. Nobody needs to type the ID.

### 5.2 Role and memberships

One site-wide role, **Engineers** ("Engineers who work on this project"), plus Jira's built-in **Administrators**.

| Project | Administrators | Engineers |
|---|---|---|
| PAY | Carol (user) | group `payments-eng`, **and** Carol (user) |
| SEC | Carol (user) | (empty) |
| VEND | Carol (user) | (empty) |

No other actors in any role. The crawler doesn't need a role. PAY's Engineers role deliberately holds both a **group** and a **user**, so role expansion is tested for both actor types.

### 5.3 Projects

All **company-managed**, Kanban template (To Do → In Progress → Done; "blocked" is a label, not a status), lead Carol.

| Key | Name | Purpose |
|---|---|---|
| `PAY` | Payments Engineering | Engineering tickets, SEV4s and postmortem action items (Drive's handbook sends them here) |
| `SEC` | Security | Security incidents and vulnerabilities |
| `VEND` | Vendor Requests | Requests to and from Acme; Dave sees only his own, plus nothing else in VEND |

Why company-managed: the connector reads each project's **permission scheme**, **roles** and **issue security scheme**, and only company-managed projects use shared schemes. Team-managed projects have their own simple access setting that the connector doesn't read yet (see "Next steps" 4 in [jira-connector-plan.md](jira-connector-plan.md)). `jira:doctor` marks a team-managed project with "(team-managed)".

### 5.4 Picker fields

| Field | Type | On screens of | Grants Browse in | Issue that depends on it |
|---|---|---|---|---|
| **Approvers** | User Picker (multiple users) | VEND | VEND permission scheme (`userCustomField`) | VEND-5 (Approvers = Bob) |
| **Owning team** | Group Picker (single group) | PAY | PAY permission scheme (`groupCustomField`) | PAY-244 (Owning team = `vendors`) |

The grant's parameter is the field ID (`customfield_NNNNN`). During sync the connector reads the field on each issue and turns the people or groups in it into labels, the same as reporter and assignee. Service Management customer grants are still not supported.

### 5.5 Permission schemes

The seed builds each scheme **from scratch**: it grants exactly the rows below and nothing else, so no "Any logged in user" or "Application access" grant can sneak in. (By hand you can copy Jira's Default Permission Scheme instead, as long as the rows end up matching; see A.7.) **Browse Projects** has exactly these grants:

| Scheme | Browse Projects grants | Code path it exercises |
|---|---|---|
| **PAY** | Space role **Engineers** · Group **brain-crawler** · **Group custom field value → Owning team** | `projectRole` (expanded to group `payments-eng` + user Carol), `group`, `groupCustomField` (PAY-244) |
| **SEC** | Group **security** · **Reporter** · Group **brain-crawler** | `group`, `reporter` (Bob on SEC-3) |
| **VEND** | Group **security** · **Reporter** · **Current assignee** · **User custom field value → Approvers** · Group **brain-crawler** | `reporter` (Dave), `assignee` (Alice on VEND-4), `userCustomField` (Bob on VEND-5) |

Other grants:

| Permission | PAY | SEC | VEND | Why |
|---|---|---|---|---|
| **Create Issues** | role Engineers, role Administrators | role Administrators, group `payments-eng` | role Administrators, group `vendors` | Gives Bob and Dave a valid "reporter" status. **Not verified** whether Jira's reporter picker needs it. |
| **Assignable User** | role Engineers | role Administrators | role Administrators, group `payments-eng` | Alice can be assigned VEND-4 |
| **Add Comments** | role Engineers, role Administrators | role Administrators, Reporter | role Administrators, Reporter, Current assignee | Bob comments on SEC-3 (reporter), Dave on VEND-1/2 (reporter), Alice on VEND-4 (assignee). Bob doesn't comment on VEND-5: he's only an Approver |
| **Day-to-day work**: Edit Issues, Transition Issues, Assign Issues, Resolve Issues, Schedule Issues, Link Issues, Create Attachments, Edit Own Comments | role Engineers, role Administrators | role Administrators | role Administrators | Who works on the project's issues |
| **Admin only**: Administer Projects, Modify Reporter, Set Issue Security (may be **Set work item security**), Delete Issues, Edit All Comments, Delete All Comments | role Administrators | role Administrators | role Administrators | Carol manages each project; the seed (as Carol) sets reporters and security levels and deletes its counter placeholders |

**No other permission is granted** in any of the three schemes. In particular, nothing may grant **Browse Projects** to "Any logged in user", "Application access" or "Public".

### 5.6 Issue security

| Scheme | Project | Level | Members | Default level? | Used on |
|---|---|---|---|---|---|
| PAY security | PAY | Leadership only | user Carol, group `brain-crawler` | No | PAY-243 |
| PAY security | PAY | Incident team | users Alice and Carol, group `brain-crawler` | No | PAY-240, PAY-241, PAY-245 |
| SEC security | SEC | Security team only | group `security`, group `brain-crawler` | No (SEC-3 has no level) | SEC-1, SEC-2 |

**The crawler must be a member of every level.** Jira admins don't bypass issue security. If the crawler isn't in a level, JQL never returns those issues, so they're never indexed and nobody can find them through the app.

### 5.7 Issues and comments

Reporter Carol and no picker value unless the table says otherwise.

#### PAY: Payments Engineering

| Key | Type | Summary | Status | Assignee | Reporter | Owning team | Labels | Security level |
|---|---|---|---|---|---|---|---|---|
| PAY-231 | Task | Migration step 3 blocked: schema lock on transactions table | In Progress | Alice | Alice | (empty) | `blocked`, `db-migration` | None |
| PAY-240 | Task | Raise the payment database connection limit from 200 to 400 | Done | Alice | Alice | (empty) | `postmortem`, `checkout-outage` | **Incident team** |
| PAY-241 | Task | Alert when the connection pool is more than 80% full | Done | Alice | Alice | (empty) | `postmortem`, `checkout-outage` | **Incident team** |
| PAY-242 | Bug | SEV4: checkout error page shows raw "503 Service Unavailable" text | To Do | Bob | Bob | (empty) | `sev4` | None |
| PAY-243 | Task | Estimate the cost of bringing second-line payment support in-house | In Progress | Carol | Carol | (empty) | `acme-renewal` | **Leadership only** |
| PAY-244 | Task | Send P1 incident notifications to Acme's support desk | To Do | Bob | Carol | **`vendors`** | `vendor-integration` | None |
| PAY-245 | Task | Name the backup database in the Payment service runbook | Done | Alice | Alice | (empty) | `postmortem`, `checkout-outage` | **Incident team** |

Descriptions:

- **PAY-231** · Step 3 of the transactions DB migration (backfill historical rows) is blocked by a schema lock on the `transactions` table. Steps 1 and 2 are complete. The lock is held while dual-write behind the `tx_schema_v2` flag is running. Rollback: turn off `tx_schema_v2`; the old schema stays authoritative until step 4. Plan: Drive → Engineering → DB migration plan.
- **PAY-240** · Follow-up from the checkout outage. Root cause: the database connection pool on pay-db-1 was exhausted after the migration flag `tx_schema_v2` was enabled. While the migration runs, every payment uses two connections instead of one, so the pool limit of 200 was reached at the dinner peak. Raise the connection limit on pay-db-1 from 200 to 400.
- **PAY-241** · Follow-up from the checkout outage. There was no alert for the pool filling up; the first alert was about latency, about 20 minutes later. Add an alert when the pay-db-1 connection pool is more than 80% full for 5 minutes. Page the payments on-call engineer. Link the alert to the Payment service runbook.
- **PAY-242** · During the checkout outage, customers saw a plain "503 Service Unavailable" page at checkout instead of our branded error page with a retry button. Near miss, cosmetic: SEV4 per the incident response handbook.
- **PAY-243** · Input for the Acme renewal decision, due 45 days before the end of the term. Option: replace Acme's second-line support with our own team. Estimate headcount and yearly cost, and what we lose (Acme's round-the-clock desk). Restricted to leadership; Acme must not see this. Notes: Drive → Vendors → Acme renewal notes.
- **PAY-244** · The SLA agreement promises Acme a response within 15 minutes for Priority 1 incidents. Send a webhook to Acme's support desk when a SEV1 is declared, so their 24x7 team starts the clock. Acme builds the receiving end; Owning team is set to the vendors group so they can follow this ticket.
- **PAY-245** · Follow-up from the checkout outage. Finding the name of the backup database took 25 minutes because the runbook said "switch to the backup" without naming it. Update the failover step to name the backup database, pay-db-2.

| Key | Author | Comment |
|---|---|---|
| PAY-231 | Alice | The lock is held by the dual-write job. Waiting for the Tuesday maintenance window to pause it and finish step 3. |
| PAY-231 | Bob | Is there anything I can pick up on this? |
| PAY-231 | Alice | Not yet, the migration is paused for now. I'll ping you when step 3 is ready to run. |
| PAY-240 | Alice | Done: connection limit on pay-db-1 raised from 200 to 400. The migration stays off until it's tested. |
| PAY-240 | Carol, **restricted to role Administrators** | The postmortem is blameless: keep the name of whoever switched the flag on out of it before it goes to Acme. |
| PAY-241 | Alice | Alert is live: pool_saturation pages the on-call engineer when pay-db-1 is more than 80% full for 5 minutes. |
| PAY-242 | Bob | Filed as SEV4 per the handbook. Low priority. |
| PAY-243 | Carol | First estimate: about 3 engineers, roughly USD 450,000 a year. No service credit to offset it: Acme's availability was 99.98%, above the 99.95% in the agreement. |
| PAY-244 | Bob | Webhook payload agreed: incident ID, severity and start time only. No customer data or internal hostnames. |
| PAY-245 | Alice | Done: the failover step in the Payment service runbook now names pay-db-2. |

#### SEC: Security

| Key | Type | Summary | Status | Assignee | Reporter | Labels | Security level |
|---|---|---|---|---|---|---|---|
| SEC-1 | Task | Payment gateway API key leaked in a public repository | Done | Carol | Carol | `incident` | **Security team only** |
| SEC-2 | Bug | Patch CVE-2026-1234 in the auth service | In Progress | Carol | Carol | `cve` | **Security team only** |
| SEC-3 | Task | Phishing email pretending to be the payments on-call bot | In Progress | Carol | **Bob** | `phishing` | None |

Descriptions:

- **SEC-1** · A live API key for the payment gateway was committed to the public repository payments-sdk-examples. An outside security researcher reported it the next morning. The key was revoked within the hour and every merchant key was re-issued. No fraudulent transactions were found. Report: Drive → Security → Security incident report.
- **SEC-2** · CVE-2026-1234 affects the auth service. Patch in progress, due 30 Sep.
- **SEC-3** · Bob received an email that looked like a page from the payments on-call bot, asking him to "re-authenticate" at an outside link. He didn't click it. Forwarded to security.

| Key | Author | Comment |
|---|---|---|
| SEC-1 | Carol | Key revoked and all merchant keys re-issued. Secret scanning is now on for every repository. Closing. |
| SEC-2 | Carol | Patch is in staging. Missed the 30 Sep due date; new target 9 Oct. |
| SEC-3 | Carol | Thanks Bob. Sender domain blocked, and a warning went to the engineering team. |
| SEC-3 | Bob | Got two more of these on Friday, also blocked now. |

#### VEND: Vendor Requests

| Key | Type | Summary | Status | Assignee | Reporter | Approvers | Labels | Security level |
|---|---|---|---|---|---|---|---|---|
| VEND-1 | Task | Share the checkout outage timeline so Acme can look into its page response | In Progress | Carol | **Dave** | (empty) | `outage-follow-up` | None |
| VEND-2 | Task | Monthly report: Acme availability, response times and P1 incidents | Done | Unassigned | **Dave** | (empty) | `sla` | None |
| VEND-3 | Task | Acme renewal: points for the renewal meeting | In Progress | Carol | Carol | (empty) | `acme-renewal` | None |
| VEND-4 | Task | Check Acme's side of the outage timeline against the postmortem | To Do | **Alice** | Carol | (empty) | `outage-follow-up` | None |
| VEND-5 | Task | Approve Acme read-only access to the payments status dashboard | To Do | Carol | Carol | **Bob** | `access-request` | None |

Descriptions:

- **VEND-1** · From Acme: Company A says our support desk took 47 minutes to answer its page during the checkout outage; the agreement says 15. Please share the timeline so I can look into it with our support lead.
- **VEND-2** · Acme's monthly report goes in the Shared with Acme folder by the 5th working day of the following month. It covers availability against the 99.95% commitment, response times, and every Priority 1 incident. Agreement: Drive → Vendors → Shared with Acme → Vendor SLA agreement.
- **VEND-3** · Acme's contract renews yearly; the decision is due 45 days before the end of the term. Raise the 47-minute page response during the checkout outage (the agreement says 15) and ask for monthly reporting on page response times, not just availability. Internal only; not for vendors.
- **VEND-4** · Dave is confirming Acme's side of the checkout outage timeline (VEND-1). Check it against the postmortem so I can close the follow-up and remove Acme's access to the postmortem.
- **VEND-5** · Acme asked for read-only access to the payments status dashboard, so their 24x7 support team sees Priority 1 incidents sooner. This needs approval from the payments on-call engineer for the week the access starts: next week, when Bob is primary per the on-call rota. The dashboard must not show internal hostnames or customer data.

| Key | Author | Comment |
|---|---|---|
| VEND-1 | Carol | I've shared the postmortem with you in Drive, it has the full timeline: paged 19:52, answered 20:39. Please keep it within Acme, it has merchant details. I'll remove your access once you're done. |
| VEND-1 | Dave | Got it, thanks. I'll confirm our side of the timeline by Friday. |
| VEND-2 | Dave | Uploaded to the Shared with Acme folder. Availability 99.98%; one Priority 1 incident, the checkout outage, where our desk answered later than the 15 minutes we commit to. |
| VEND-3 | Carol | Acme has added a second person to the night shift since. Still asking for response-time reporting before we renew. |
| VEND-4 | Alice | Matches the postmortem: paged at 19:52, Acme answered at 20:39, 47 minutes against the 15 in the agreement. |
| VEND-5 | Carol | Bob, you're on call next week when Acme's access would start, so it's your call. Please approve or reject by Wednesday; a read-only viewer role is enough. |

Bob doesn't comment on VEND-5: VEND's Add Comments doesn't include the Approvers field.

When a persona's token isn't set, their comments appear as Carol's, starting with "On behalf of Alice:" (or Bob, Dave). Answers may then cite Carol as the author. That's fine for the demo, but set the three tokens if you want authors to look right.

---

## 6. Who sees what (the acceptance test)

✅ = can browse in Jira **and** can find it through the app once linked. ❌ = must never appear for that person.

| Issue | Alice | Bob | Carol | Dave |
|---|---|---|---|---|
| PAY-231 | ✅ Engineers role (via `payments-eng`) | ✅ Engineers role (via `payments-eng`) | ✅ Engineers role (as a user) | ❌ no Browse in PAY |
| PAY-240 | ✅ Engineers role + level member | ❌ not in "Incident team" | ✅ Engineers role + level member | ❌ no Browse in PAY |
| PAY-241 | ✅ Engineers role + level member | ❌ not in "Incident team" | ✅ Engineers role + level member | ❌ no Browse in PAY |
| PAY-242 | ✅ Engineers role | ✅ Engineers role | ✅ Engineers role | ❌ no Browse in PAY |
| PAY-243 | ❌ not in "Leadership only" | ❌ not in "Leadership only" | ✅ Engineers role + level member | ❌ no Browse in PAY |
| PAY-244 | ✅ Engineers role | ✅ Engineers role | ✅ Engineers role | ✅ **`vendors` group in Owning team field** (only reason) |
| PAY-245 | ✅ Engineers role + level member | ❌ not in "Incident team" | ✅ Engineers role + level member | ❌ no Browse in PAY |
| SEC-1 | ❌ no Browse in SEC | ❌ no Browse in SEC | ✅ `security` group + level member | ❌ no Browse in SEC |
| SEC-2 | ❌ no Browse in SEC | ❌ no Browse in SEC | ✅ `security` group + level member | ❌ no Browse in SEC |
| SEC-3 | ❌ no Browse in SEC | ✅ Reporter grant | ✅ `security` group | ❌ no Browse in SEC |
| VEND-1 | ❌ not reporter/assignee/approver | ❌ not reporter/assignee/approver | ✅ `security` group | ✅ Reporter grant |
| VEND-2 | ❌ not reporter/assignee/approver | ❌ not reporter/assignee/approver | ✅ `security` group | ✅ Reporter grant |
| VEND-3 | ❌ not reporter/assignee/approver | ❌ not reporter/assignee/approver | ✅ `security` group | ❌ not reporter/assignee/approver |
| VEND-4 | ✅ Assignee grant | ❌ not reporter/assignee/approver | ✅ `security` group | ❌ not reporter/assignee/approver |
| VEND-5 | ❌ not reporter/assignee/approver | ✅ **in Approvers field** (only reason) | ✅ `security` group | ❌ not reporter/assignee/approver |
| PAY-240's restricted comment | ❌ never indexed | ❌ never indexed | ❌ never indexed (even though Carol can read it in Jira) | ❌ never indexed |

**Totals: Alice 7 issues, Bob 5, Carol 15, Dave 3.**

To check a row in Jira itself **[each persona]**: sign in and open `https://<site>.atlassian.net/browse/<KEY>`. ❌ shows "You don't have permission" or "This issue can't be found". Then check the same in the app (section 7).

---

## 7. Demo questions

Ask with the sources set to Jira plus Slack and Drive (or "all"). Expected answers assume the data above and the existing Slack and Drive seed data. Avoid demoing as Carol with questions that could pull in the test DM noted in [demo-data.md](demo-data.md).

| # | Question | Ask as | Expected answer | Ask as | Expected answer |
|---|---|---|---|---|---|
| 1 | what was the root cause of the payment outage, and what follow-up tickets were created? | Alice | Pool exhausted after the migration flag; PAY-240 (limit 200 → 400, done), PAY-241 (alert above 80%, live), PAY-245 (runbook names pay-db-2), plus the postmortem (Drive) and `#payments-incident` (Slack) | Bob | "I don't have information on that" (demo moment 1: Bob isn't in the "Incident team" level) |
| 2 | why can't the migration move past step 3? | Bob | PAY-231: schema lock on `transactions` held by the dual-write job, waiting for Tuesday's window; also Slack `#db-migration` | Dave | Only the public Slack message (schema lock, PAY-231). Nothing from Jira: no window, no dual-write detail |
| 3 | when is my monthly report due and what has to be in it? | Dave | VEND-2: by the 5th working day of the month, in the Shared with Acme folder; covers availability vs 99.95%, response times and P1 incidents (Jira + the Vendor SLA agreement in Drive) | Alice | "I don't have information on that" |
| 4 | why did Company A ask about our page response during the outage? | Dave | VEND-1: paged 19:52, answered 20:39, 47 minutes against 15; the postmortem is shared for the timeline, keep it within Acme (Jira + `#acme-support` and Carol's DM in Slack) | Bob | "I don't have information on that" (Bob can't see VEND-1 or the postmortem) |
| 5 | what do I need to do for Acme? | Alice | VEND-4: check Acme's side of the outage timeline against the postmortem (assignee grant). May also mention PAY-244. | Bob | PAY-244 (the webhook he's assigned), not VEND-4 |
| 6 | has anyone looked at the suspicious email I forwarded? | Bob | SEC-3: Carol blocked the sender domain and warned engineering (reporter grant) | Alice | "I don't have information on that" |
| 7 | is the auth service vulnerability fixed? | Carol | SEC-2: not yet, missed 30 Sep, new target 9 Oct; plus Slack `#security` and Drive's vulnerability register | Alice | "I don't have information on that" |
| 8 | what would it cost to replace Acme's support with our own team? | Carol | PAY-243: about 3 engineers, roughly USD 450,000 a year; no service credit to offset it (Jira + Drive's Acme renewal notes) | Alice | "I don't have information on that", **even though Alice can browse PAY** (security level) |
| 9 | whose name should stay out of the postmortem? | Carol | Nothing from Jira: the only text saying this is the restricted comment on PAY-240, which is never indexed | Alice | Nothing from Jira either. (Slack may surface Alice's DM about her flag; that's Slack's permission, not Jira's.) |
| 10 | are the postmortem action items done? | Alice | Yes: PAY-240, PAY-241 and PAY-245 are all Done | Bob | "I don't have information on that" |
| 11 | is anything waiting on my approval? | Bob | VEND-5: Acme wants read-only access to the payments status dashboard; Carol asked for a decision by Wednesday (access only through the Approvers field) | Alice | "I don't have information on that". Dave also gets nothing, even though the request is about Acme |
| 12 | how will Acme find out about P1 incidents? | Dave | PAY-244: a webhook with incident ID, severity and start time when a SEV1 is declared (access only through Owning team), plus the 15-minute P1 response time from the SLA agreement in Drive | Alice | PAY-244 only, through the Engineers role. No 15-minute figure: the SLA agreement in Drive is shared only with Carol and Dave |

Same question, different answers: #1 and #10 (Alice vs Bob), #3 and #12 (vs Dave). Jira combined with Slack or Drive: #1, #3, #4, #7, #8, #12. Security-level layer: #1, #8, #10. Restricted comment: #9. Picker-field grants: #11 (user) and #12 (group).

---

## 8. Verification checklist and troubleshooting

### Checklist **[you, with each persona]**

- [ ] `npm run seed:jira` ends without warnings about skipped issues, and a second run changes nothing. A second `-- --update` run reports "comments unchanged" for every issue.
- [ ] `npm run jira:doctor` ends with "All good." (or only the "nobody connected" warning before 4.6).
- [ ] `npm run jira:backfill` finishes with "Index now has … chunks from PAY, SEC, VEND". Every issue fits in one chunk, so expect about 14 chunks (6 PAY, 3 SEC, 5 VEND), and no placeholder issues.
- [ ] For each persona, the section 6 matrix holds in Jira (open each `/browse/KEY`).
- [ ] For each persona, a Jira-only search for `PAY`, `SEC`, `VEND` in the app returns exactly their ✅ issues (Alice 6, Bob 7, Carol 14, Dave 3).
- [ ] Question 8 as Alice returns nothing from Jira.
- [ ] Question 9 as Carol returns nothing from Jira.
- [ ] Question 11 as Bob returns VEND-5; as Alice and as Dave it returns nothing from Jira.
- [ ] Picker field removal: **[Carol]** clear Bob from **Approvers** on VEND-5. Ask question 11 as Bob **right away**: nothing from Jira, because the live check asks Jira, and Jira already says no. After the next poll (`JIRA_POLL_SECONDS`, default 60 s; or `npm run jira:poll`), the VEND-5 labels no longer include Bob, so the index stops matching him at all. Put Bob back afterwards, wait one poll, and question 11 works again. (Re-running the seed won't put him back: existing issues are left alone.)
- [ ] Same test for Owning team: clear `vendors` from PAY-244, and Dave loses it the same way (question 12 as Dave).
- [ ] Live change: **[Carol]** set SEC-3's reporter to Carol. Ask question 6 as Bob right away: nothing from Jira. Put Bob back afterwards.
- [ ] The audit log (`/drive.html`) shows each Jira answer with the asker and the issues used.

### Troubleshooting: the seed

| Symptom | Likely cause | Fix |
|---|---|---|
| Seed stops with "Invited Alice, Bob, … Each must accept the invite email, then run `npm run seed:jira` again." | Expected on the first run, or someone hasn't accepted yet | Each invitee accepts (2.5), then re-run. admin.atlassian.com → **Directory** → **Users** shows who is still "Invited"; **Resend invite** from their row if the email is lost |
| Seed fails with "Couldn't find or invite <Name> (<email>) … or set <NAME>_JIRA_ACCOUNT_ID", although they've accepted | Their Atlassian profile hides their email, so the user search returns nothing | Set `<NAME>_JIRA_ACCOUNT_ID` (or `CRAWLER_JIRA_ACCOUNT_ID`). To find it: admin.atlassian.com → **Directory** → **Users** → open the person; the address bar ends in their account ID. Or open their Jira profile; the URL is `/jira/people/<accountId>`. Then re-run |
| Seed fails with "PAY is team-managed. Delete it (or pick another key) and re-run" | A project with that key was created by hand as team-managed | Move it to trash and delete it permanently, then re-run |
| 401 from the seed | Wrong `JIRA_ADMIN_EMAIL` / `JIRA_ADMIN_API_TOKEN`, a scoped token, or an expired token | A plain token from Carol's own account (2.3), with Carol's email |
| Seed fails with "<email> isn't a Jira admin on <site>. JIRA_ADMIN_* must be a site admin (Carol)", or a 403 on invites, groups or schemes | `JIRA_ADMIN_*` isn't a site admin / doesn't have Administer Jira | Use the site creator's account. In admin.atlassian.com → **Directory** → **Users** → Carol, check she's site admin (or org admin) and has Jira admin access |
| Warning "PAY-231: PAY's numbering is already past 231 (next was …), so this issue can't get its key. Skipped." (or 240..244) | Issues were created in PAY before the seed, by hand or by an earlier partial run | Jira never reuses numbers and the seed can't go back. Either move the PAY project to trash, delete it permanently and re-run the seed, or accept different numbers and update `src/seedSlack.ts`, `src/connectors/drive/cli/seed.ts` and `docs/demo-data.md`. **Not verified:** whether a trashed project's key can be reused before it's permanently deleted |
| Permission schemes step fails with "400 Custom field 'Approvers' is not indexed for searching - please add a Search Template to this Custom Field." ✔ *seen on the real site* | The site already had a Jira-created "Approvers" field with no search template (`customfield_10003` there), and the seed reused it. Jira won't accept an unsearchable field in a permission grant | Update to the fixed seed and **re-run; it's safe**. The PAY and SEC schemes had already been applied, and the seed now adds a search template or creates its own searchable "Approvers" field (with a warning). The leftover unsearchable field on VEND's screens is harmless |
| Creating VEND-5 or PAY-244 fails with "Field 'customfield_…' cannot be set. It is not on the appropriate screen" | The project's screens don't start with `VEND:` / `PAY:`, so the seed didn't add the field to them | Add the field to that project's create and edit screens by hand (A.6, "Add it to the screens"), then re-run. The seed creates the missing issue |
| Seed fails with "PAY-243 needs security level "Leadership only", but PAY has none" (or another secured issue), or setting the level fails | Assigning a security scheme to a project runs as a background task in Jira | Wait a minute and re-run. Check in **Space settings** → **Work item security** that the scheme is attached |
| Seed says "Comments by … were posted by <Carol's email> as \"On behalf of …\"" | `ALICE_/BOB_/DAVE_JIRA_API_TOKEN` not set | Fine for the demo. To have real authors, set the tokens, delete those issues and re-run (the PAY keys can't be recreated; see the "counter" row) |
| A persona's own token fails when posting a comment (403) | That persona lacks Add Comments on that issue | Check 5.5 "Add Comments" (Reporter and Current assignee in SEC and VEND) |
| Issue security fails with "400 The group <id> isn't a valid parameter." ✔ *seen on the real site* | Older seed sent group **IDs** as security level members; Jira wants group **names** there | Fixed in the seed; re-run |
| Issue security fails with "400 The oldToNewSecurityLevelMappings has to be provided." ✔ *seen on the real site* | Jira's scheme-association endpoint insists on a level mapping even for an empty project | Fixed: the seed now sets the scheme on the project directly, and only falls back to that endpoint (with a mapping and a `!` warning). Re-run |
| "POST /rest/api/3/issue/PAY-231/comment: 404 Issue does not exist or you do not have permission to see it." right after the issue was created ✔ *seen on the real site* | Jira applies new permissions with a few seconds' delay, so the reporter or assignee can't see a brand-new issue yet | Fixed: the seed retries comments on 404, and a re-run finishes an issue an earlier run created but didn't comment on. Just re-run |
| Warnings "no transition to "To Do" (available: Backlog, Selected for Development, In Progress, Done)" ✔ *seen on the real site* | The company-managed Kanban template has no "To Do" status. New issues start in **Backlog** | Harmless: To Do issues stay in Backlog. The current seed no longer warns about it |
| "Approvers: made existing field customfield_… searchable" on every run | Jira doesn't report the field's search template back the way the seed checks it | Harmless. If the VEND scheme step succeeds, the field is searchable |
| Your output is identical to an error you already fixed (e.g. still shows group IDs) | You ran an older copy of the seed, or the edit wasn't saved before the run | Check you're in the right folder and the file is saved, then re-run. The seed prints `!` warnings for its fallbacks, so a missing warning means old code |

### Troubleshooting: connector and demo

| Symptom | Likely cause | Fix |
|---|---|---|
| `jira:backfill` right after seeding says "Index now has 0 chunks", or fewer issues than expected ✔ *seen on the real site* | Jira's search lags behind permission changes. For a minute or two the crawler's JQL returned nothing (later only some projects), even though it could open each issue directly | Wait a minute or two and run `npm run jira:backfill` again. On the real site the second and third runs indexed all 14 issues (28 chunks). The connector now never removes a project's indexed issues because a search came back empty; it logs "search returned no issues but N are indexed; not removing them" instead |
| The permission scheme shows an extra Browse grant for role **jira-guest-member** (also on Add Comments) ✔ *seen on the real site* | Jira adds its guest-access role to every permission scheme automatically | Harmless while the role has no members in PAY, SEC and VEND (the default). Anyone later added to these projects as a **guest** would get Browse through it |
| You only see KAN-1…3 (or SAM1-…) in Jira, not the seeded issues | Jira opens the first project it created (the onboarding KAN board, or the SAM1 sample) | Spaces → View all spaces → Payments Engineering / Security / Vendor Requests, or open `<site>/browse/PAY-240`. KAN and SAM1 are ignored by HMA Brain (`JIRA_PROJECTS`) |
| `npm run dev` hangs with "[WARN] bolt-app A pong wasn't received from the server before the timeout of 5000ms!" and never prints "HMA Brain on …" | Slack live sync (`SLACK_SYNC=on`) can't hold its Socket Mode connection, and the server waits for it before listening | Not Jira-related. Start with `SLACK_SYNC=off npm run dev` (or set it off in `.env`); Jira and Connect Jira don't need it |
| doctor: "Jira rejected the API token" | Wrong `JIRA_EMAIL`, a scoped token, or an expired token | Use the crawler's email and a plain token (2.6) |
| doctor: "lacks Administer Jira" | The crawler's Jira app role doesn't include admin rights (the seed can't set it). Jira's Global permissions page doesn't offer Administer Jira | 4.1: admin.atlassian.com → Directory → Users → crawler → Apps → Jira → Roles: **User** + **User access admin** |
| Two personas show the same "Linked to <name>", or a persona is linked to the wrong Atlassian account | Connect Jira was clicked in a browser where another person was signed in to Atlassian | **Disconnect** on the Connect page, then reconnect from that persona's own browser profile (4.6) |
| doctor: "can't see project(s) PAY" | Crawler has no Browse in that scheme, or the scheme isn't attached | Re-run the seed; check 5.5 / A.7 |
| doctor: "PAY (team-managed)" | Project was created team-managed by hand | Delete it and let the seed recreate it company-managed; you can't convert in place |
| doctor: "nobody would see its issues" | Browse row is empty or only has holder types the connector skips | Re-run the seed; compare with 5.5 |
| doctor: "Connect Jira isn't set up" | `JIRA_OAUTH_CLIENT_*` missing | 4.3, 4.4 |
| doctor/backfill warns "skipped grants we can't label yet (userCustomField / groupCustomField)" | The connector build you're running doesn't have picker support, or the field ID can't be read | Update to the build with picker support. Until then Bob misses VEND-5 and Dave misses PAY-244 in the app (safe, incomplete) |
| Backfill misses PAY-240/241/243/245, SEC-1, SEC-2 | Crawler isn't a member of the security level | Re-run the seed (it syncs level members); check 5.6 |
| A persona sees nothing from Jira | Not linked; no Jira product access; or Connect failed | doctor lists links; check product access (2.5 step 5); redo 4.6 |
| Alice/Bob/Dave get an Atlassian error on Connect Jira | OAuth app sharing is off, or callback URL mismatch | 4.3 step 4 (Enable sharing) and step 3 (exact callback) |
| Dave sees PAY or SEC issues in Jira (other than PAY-244) | Browse granted to "Any logged in user" / "Application access", e.g. after a manual edit | Re-run the seed (it resets grants to 5.5) |
| Approvers / Owning team doesn't appear on an issue, so its value can't be set by hand | The field isn't on that project's screen | A.6, "Add it to the screens". A grant on a field nobody can fill gives nobody access: safe, but VEND-5 / PAY-244 disappear for Bob / Dave |
| "Not valid for this user picker" when setting Approvers | The field has a user filter that excludes Bob | Turn the user filter off (A.6, step 7) |
| Bob still finds VEND-5 after being removed from Approvers | Must not happen: the live check asks Jira every time | Check the audit log entry. If Jira itself still lets Bob open `/browse/VEND-5`, he has another grant (role, group, assignee) |
| A restricted issue shows up in the app for the wrong person | Must not happen: labels filter it and the live check drops it | Check the audit log entry for that answer; run doctor; report it as a bug with the issue key and persona |
| Edits in Jira don't show up | `JIRA_SYNC=off`, or the server wasn't restarted after changing `.env` | Set `on` and restart, or run `npm run jira:poll` |
| Edits show up late or not at all after changing the crawler's time zone | JQL dates use the crawler's time zone; a running server cached the old one | Restart the server; doctor prints the zone it sees |
| Commands on the laptop fail with "fork failed: resource temporarily unavailable" | Not Jira: the Mac hit its per-user process limit. On the real run it was ~1,100 stuck `docker` / `com.docker.cli` processes | `pkill -f com.docker.cli; pkill -x docker`, then restart Docker Desktop. Elasticsearch runs in Docker, and backfill needs it |
| Deleted issue still in the index | Deletes are only caught by the reconcile sweep | Wait `JIRA_RECONCILE_MINUTES` or run `npm run jira:backfill`. It's already withheld at query time |

---

## Appendix A. Manual setup (if you can't run the seed, or to check what it did)

Every step builds something from section 5. Do them in this order. Where the seed does it differently, it says so.

### A.1 Invite people and check access **[Carol, then each invitee]**

1. admin.atlassian.com → your organization → **Directory** → **Users** → **Invite users** ([Invite a user](https://support.atlassian.com/user-management/docs/invite-a-user/)).
2. Enter `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL` and the crawler's address.
3. Under app access, give each one **Jira** with the **User** role. No Service Management, no admin role.
4. **Invite**. Each invitee accepts as in 2.5 step 3.
5. Check: **Directory** → **Users** shows all five **Active** with **Jira – User**. If someone has no Jira access, use **Grant access** on their page. Without product access Jira gives them nothing, and the connector also drops the "any logged-in user" key for them (`people.ts`, `hasProductAccess`).

### A.2 Groups **[Carol]**

admin.atlassian.com → **Directory** → **Groups** → **Create group** ([Create groups](https://support.atlassian.com/user-management/docs/create-groups/)). Then open each group → **Add group members** → add people → **Add**. Groups and members: 5.1.

### A.3 Project role **[Carol]**

1. ⚙ **Settings** → **System** → in the sidebar, **Space roles** (older UI: **Project roles**).
2. Add **Engineers**, description "Engineers who work on this project" → **Add**.
3. Check that **Administrators** exists. If your site only has roles like "Administrator / Member / Viewer", use the admin one wherever this plan says Administrators.

### A.4 Projects **[Carol]**

For each project in 5.3: top bar → **Spaces** (or **Projects**) → **Create space** → **Software development → Kanban** → choose **Company-managed** (the link may say "Change template type" or "Space type") → name and key → **Create**. The key must be exactly `PAY`, `SEC`, `VEND`; Jira may suggest another one.

**Work types.** A new site may have only Epic and Story (the real one did ✔ *verified*), and 5.7 needs **Task** and **Bug**. ⚙ **Settings** → **Work items** → **Work types** → **Add work type** → create `Task` and `Bug` (standard type) if missing. Then **Work type schemes** → edit the scheme used by PAY (then SEC, VEND) → drag Task and Bug into the scheme → **Save**. The seed does this automatically.

### A.5 Role memberships **[Carol]**

In each project: **•••** next to the project name → **Space settings** → **People** (older UI: **Access** or **People and roles**) → **Add people** → pick the user or group → pick the role → **Add**. Match 5.2, and remove anything else Jira added (for example `jira-users-<site>` or `atlassian-addons-admin` in a role).

### A.6 Picker fields **[Carol]**

Do this before A.7: the permission grant asks you to pick the field. Fields: 5.4.

**Create the field**

1. ⚙ **Settings** → **Work items** (older UI: **Issues**) → under **Fields**, **Custom fields** (newer UI: **Fields**) → **Create custom field** (newer UI: **Create new field**) ([Create a custom field](https://support.atlassian.com/jira-cloud-administration/docs/create-a-custom-field/)).
2. Pick the type: search for "User Picker (multiple users)" for Approvers, or "Group Picker (single group)" for Owning team. The type can't be changed later.
3. Name it (`Approvers` / `Owning team`) and add a description, for example "People who must approve this request. Being named here lets them see the issue." → **Create**.
4. If Jira offers **Associate field to screens** right away (older UI), tick the project's screens (below) → **Update**.

**Context**

5. Custom fields list → the field → **•••** → **Contexts and default value** (newer UI: open the field → **Contexts**).
6. Manual setup: under **Applicable spaces**, pick only VEND (Approvers) or PAY (Owning team). *The seed leaves the context global instead. Both work.*
7. Leave the default value empty. If there's a **user filter**, leave it **off**, or Bob may be rejected with "not valid for this user picker" ([Atlassian KB](https://support.atlassian.com/jira/kb/one-or-more-of-the-selected-users-dont-exist-or-are-not-valid-for-this-user-picker-while-creating-jira-issue/)).

**Add it to the screens**

8. ⚙ **Settings** → **Work items** → **Screens**. Find the screens whose names start with `VEND:` (or `PAY:`), for example `VEND: Kanban Default Issue Screen` or "… Work Item Screen". Kanban usually has one screen for create, edit and view; if there are several, do all of them.
9. **Configure** → at the bottom, **Select field** / **Add field** → the field name → add it.
10. Check: **+ Create** in VEND shows **Approvers**; existing issues show it in the details panel (maybe under **More fields**).

**Find the field ID**

11. Custom fields list → the field → **•••** → **Contexts and default value** (or **Edit details**). The address bar ends in something like `customFieldId=10050` or `id=10050`. The field ID is `customfield_10050`.
12. Or, signed in as Carol, open `https://<site>.atlassian.net/rest/api/3/field` in the browser and search for `"name":"Approvers"`. Its `"id"` is the field ID.

### A.7 Permission schemes **[Carol]**

**Copy the default**

The seed builds each scheme from scratch with only the rows in 5.5. By hand, copying the default is less clicking. That's fine as long as, when you're done, every row matches 5.5 and every other row is empty (or at least grants nothing to "Any logged in user", "Application access", "Public" or people outside 5.5).

1. Open **`https://<site>.atlassian.net/secure/admin/ViewPermissionSchemes.jspa`** ✔ *verified*. The ⚙ **Settings** → **Work items** sidebar on a real site has no "Work item attributes" heading and no obvious Permission schemes link; its sections are Work types (Work type hierarchy, Work types, Work type schemes, Sub-tasks), Workflows, Screens, Fields, Priorities and Work item features. ([Create a new permission scheme](https://support.atlassian.com/jira-cloud-administration/docs/create-a-new-permission-scheme/))
2. On **Default Permission Scheme**: **•••** / **Actions** → **Copy**. Rename the copy (**Edit**) to `PAY permission scheme`. Repeat for SEC and VEND.

**Set Browse Projects**

3. Click the scheme name (or **Permissions** in its row) → find **Browse Projects** (may be **Browse spaces**) → **Update** ([Grant or revoke permissions in a scheme](https://support.atlassian.com/jira-cloud-administration/docs/grant-or-revoke-permissions-in-a-scheme/)).
4. **Remove every existing grant** on this row first. The default usually grants it to *Application access* / *Any logged in user* or to roles; if any of these stay, Dave sees everything.
5. Add each grant from 5.5: choose the type (Group, Space role, Reporter, Current assignee, **User custom field value**, **Group custom field value**), pick the value, **Update**. The custom field dropdown only lists fields of the matching type. If Approvers isn't there, A.6 isn't finished. In the list, the grant shows as something like "User custom field value (Approvers)".
6. The row must list **exactly** the grants in 5.5.

**Other grants**

7. Set every row in 5.5's "Other grants" table the same way: **Update** → remove grants not in the table → add the missing ones. Then go down the rest of the list and remove grants on any permission 5.5 doesn't mention (for example Manage Watchers, Work On Issues, Delete Own Comments): the seed grants those to nobody. Leaving one granted to a role from 5.2 is harmless for the demo; a grant to "Any logged in user" or "Application access" is not.

**Attach each scheme**

8. Project → **•••** → **Space settings** → **Permissions** → **Actions** → **Use a different scheme** → pick the scheme → **Associate** ([Change which permission scheme a space uses](https://support.atlassian.com/jira-cloud-administration/docs/change-which-permission-scheme-a-space-uses/)).

### A.8 Issue security **[Carol]**

1. Open **`https://<site>.atlassian.net/secure/admin/ViewIssueSecuritySchemes.jspa`** ✔ *verified* (the page is empty on a new site; that's expected, the seed creates the schemes) → **Add work item security scheme** (or "Add issue security scheme") ([Create a new work item security scheme and security levels](https://support.atlassian.com/jira-cloud-administration/docs/create-a-new-work-item-security-scheme-and-security-levels/)). Name it `SEC security` → **Add**.
2. In its row, **Security levels** → under **Add security level**, name `Security team only` → **Add security level**. **Don't** mark it Default.
3. In the level's row, **Add** → **Group: security** → **Add**; again **Group: brain-crawler** → **Add** ([Grant users access to security levels](https://support.atlassian.com/jira-cloud-administration/docs/grant-users-access-to-security-levels-in-a-work-item-security-scheme/)).
4. Repeat for `PAY security` / `Leadership only` with **Single user: Carol** and **Group: brain-crawler**, and a second level `Incident team` with **Single user: Alice**, **Single user: Carol** and **Group: brain-crawler** (5.6).
5. Attach: project → **•••** → **Space settings** → **Work item security** (older UI: **Issue security**) → **Select a scheme** / **Actions → Use a different scheme** → the scheme → **Next** → **Associate**. If asked about existing issues, choose **None**.

### A.9 Getting the keys PAY-231 and PAY-240..245 by hand **[Carol]**

The seed uses throwaway issues. By hand, use Jira's global CSV importer, which can move the counter: importing `PAY-230` makes the next new issue `PAY-231` ([Set Jira project issue key counter to a custom starting number](https://support.atlassian.com/jira/kb/set-jira-project-issue-key-counter-to-a-custom-starting-number/)). The project-level "Import from CSV" can't map Issue key.

1. Save `pay-230.csv`:
   ```
   Issue Type,Summary,Priority,Issue Key
   Task,Placeholder to move the counter,Low,PAY-230
   ```
2. ⚙ **Settings** → **System** → **Import and Export** → **External System Import** → **CSV** → the file → leave "Use an existing configuration file" unticked → **Next** → project **PAY** → **Next** → map each column to the same-named field (Issue Key → **Issue key**) → **Next** → **Begin Import**.
3. Create **PAY-231** (A.10).
4. Import `pay-239.csv` (same content, key `PAY-239`).
5. Create **PAY-240** to **PAY-245**, in order.
6. Delete the placeholders: open PAY-230 → **•••** → **Delete** → confirm; same for PAY-239. The counter stays.

The importer can't be undone, and you can't import a key below an existing issue. SEC and VEND start at 1.

### A.10 Creating issues and comments **[Carol, then each persona]**

1. **+ Create** → Space → Work type → Summary → Description (5.7) → **Create**.
2. Open it. Set **Assignee**, **Reporter** (if not Carol) and **Labels**.
3. Move the status with the status button.
4. Security level: the **lock** icon at the top right, next to Watchers ("Set security level") → the level ([View and change a work item's security level](https://support.atlassian.com/jira-software-cloud/docs/view-and-change-a-work-items-security-level/)).
5. **Approvers** / **Owning team**: click the field in the details panel (maybe under **More fields**) → pick the person or group → Enter or click away. If it isn't there, see A.6 steps 8–10.
6. Comments **as the person named**: sign in as that persona, open the issue, **Add a comment**, **Save**. Set the reporter or assignee first, or the persona can't open the issue.
7. **Restricted comment on PAY-240:** while writing it, click the **lock** / "Viewable by All Users" control under the comment box → role **Administrators** → **Save**. It shows "Restricted to Administrators". The connector skips any comment with a visibility setting (`docs.ts`), so this text must never appear in any search or answer, even for Carol.

---

## Sources

- [Permissions limitations in Free Jira sites](https://support.atlassian.com/jira-cloud-administration/docs/permissions-and-issue-level-security-in-free-plans/)
- [Explore Jira Cloud plans](https://support.atlassian.com/jira-cloud-administration/docs/explore-jira-cloud-plans/)
- [Create a new permission scheme](https://support.atlassian.com/jira-cloud-administration/docs/create-a-new-permission-scheme/)
- [Grant or revoke permissions in a scheme](https://support.atlassian.com/jira-cloud-administration/docs/grant-or-revoke-permissions-in-a-scheme/)
- [Change which permission scheme a space uses](https://support.atlassian.com/jira-cloud-administration/docs/change-which-permission-scheme-a-space-uses/)
- [Create a new work item security scheme and security levels](https://support.atlassian.com/jira-cloud-administration/docs/create-a-new-work-item-security-scheme-and-security-levels/)
- [Grant users access to security levels in a work item security scheme](https://support.atlassian.com/jira-cloud-administration/docs/grant-users-access-to-security-levels-in-a-work-item-security-scheme/)
- [View and change a work item's security level](https://support.atlassian.com/jira-software-cloud/docs/view-and-change-a-work-items-security-level/)
- [View, grant, revoke global permissions in Jira](https://support.atlassian.com/jira-cloud-administration/docs/view-grant-revoke-global-permissions-in-jira/)
- [Set Jira project issue key counter to a custom starting number](https://support.atlassian.com/jira/kb/set-jira-project-issue-key-counter-to-a-custom-starting-number/)
- [Create a custom field](https://support.atlassian.com/jira-cloud-administration/docs/create-a-custom-field/) · [User picker "not valid" error (KB)](https://support.atlassian.com/jira/kb/one-or-more-of-the-selected-users-dont-exist-or-are-not-valid-for-this-user-picker-while-creating-jira-issue/)
- [Invite a user](https://support.atlassian.com/user-management/docs/invite-a-user/) · [Create groups](https://support.atlassian.com/user-management/docs/create-groups/)
- [Manage API tokens for service accounts](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)
- [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)

### Verified on the real site (2026-10-04)

- Site sign-up flow ("Create your account", Full name), the first-sign-up-owns-the-site trap, the auto-created team-managed KAN project, and the active Premium trial.
- The ⚙ Settings → Work items sidebar (no "Work item attributes"); the classic URLs `/secure/admin/ViewPermissionSchemes.jspa` and `/secure/admin/ViewIssueSecuritySchemes.jspa`.
- A new site has only Epic and Story work types; the default roles are Administrator, atlassian-addons-project-access, jira-guest-member, Member and Viewer.
- Classic API tokens at id.atlassian.com/manage-profile/security/api-tokens, for Carol, the crawler and the personas.
- A crawler on an outside email domain shows as "External user" and works; its time zone (Asia/Singapore) needed no change.
- Administer Jira isn't offered on Jira's Global permissions page; the crawler's app roles **User** + **User access admin** gave `ADMINISTER = true`.
- Seed output headings, role detection, the unsearchable "Approvers" field error and its fix, and per-site field IDs.

### Not verified (check on the real site)

- Exact menu labels after the "spaces / work items" rename, including the name of the role page (Space roles vs Project roles). (The ⚙ Settings → Work items sidebar, the default roles and the classic permission/security scheme URLs **were** verified; see A.4, A.7, A.8 and section 3, step 3.)
- Whether starting the Standard/Premium trial asks for card details (the trial itself was verified active as Premium), and whether a downgraded site keeps answering `permissions/check` the same way.
- Whether Jira's Reporter picker needs the chosen person to have Create Issues (5.5 grants it to be safe).
- Whether the comment visibility control is a lock icon or a "Viewable by" dropdown in your UI.
- The custom field screens after the rename: "Custom fields → Create custom field" vs "Fields → Create new field", whether screen association appears right after creating the field, the exact names of the projects' screens (the seed relies on the `VEND:` / `PAY:` prefix), and where the field ID shows in the URL.
- The exact grant-type labels in the permission dialog ("User custom field value" / "Group custom field value"), taken from Atlassian's docs but not seen on a live site.
- The exact wording of some seed messages quoted in troubleshooting (the "Approvers is not indexed for searching" error and the output headings were seen on the real site; the others are taken from `seed.ts`).
- Whether "User access admin" grants Administer Jira on every site, or only on this one. It did on `hma-brain-demo`; check with `jira:doctor`.
- Whether a trashed project's key (PAY) can be reused before the project is permanently deleted.
