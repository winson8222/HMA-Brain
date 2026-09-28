# Google Drive setup

[← Back to README](../README.md)

The Drive connector reads one folder (default: **Company A**) in an admin account's My Drive. It indexes every file with its real sharing, and keeps the index current by polling Drive's changes feed. Data goes to its own indexes, `brain-drive` (chunks) and `brain-drive-state` (sync bookkeeping), so a Slack backfill never touches it.

**Search and Ask over Drive** run on their own page, **http://localhost:3000/drive.html**. They aren't merged into the Slack page yet. Every search and answer goes into a tamper-evident audit log (`brain-audit`).

**Quick check at any time:** `npm run drive:doctor` tests the whole setup (token, folder, index, sync, LLM, audit chain) and lists what's left to do.

## 1. Google Cloud app (once, by a developer)

In https://console.cloud.google.com, for the project that holds the "HMA Brain" app:

1. **APIs & Services → Library → Google Drive API → Enable.**
2. **Google Auth Platform:**
   - **Audience:** External, **Testing**. Add the admin account and the personas as **test users**.
   - **Data access:** scopes `.../auth/drive.readonly` and `.../auth/drive.file`.
   - **Clients → Web application**, with redirect URIs `http://localhost:8765/oauth2callback` (CLI connect) and `http://localhost:3000/connect/google/callback` (Connect button in the app).
3. Put the client's ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 2. Connect Drive (once, as the Company A admin)

Either:
- **In the app:** on `/drive.html`, open **Admin** at the bottom, enter the `ADMIN_TOKEN` from `.env`, and click **Connect / reconnect Google Drive**; or
- **From the terminal:** `npm run drive:connect`.

Sign in as the **admin** account. Google shows "Google hasn't verified this app": click **Continue**, then **Allow**. The refresh token is saved to `.secrets/google-token.json` (gitignored), and the crawler runs on it from then on.

The client ID and secret only identify our app. The token is what grants access to this admin's Drive. In **Testing** mode Google expires the token after **7 days**; if you see "Google token expired or was revoked", connect again.

## 3. Demo data, first sync, live updates

```bash
docker compose up -d        # Elasticsearch
npm run seed:drive          # creates "Company A" in the admin's Drive and shares files with the personas
npm run drive:backfill      # index everything (re-runs skip unchanged files)
npm run drive:verify        # optional: check the index matches Drive
npm run drive:poll -- --watch   # or set DRIVE_SYNC=on and run `npm run dev`
```

`seed:drive` writes only to Drive. It shares with `ALICE_EMAIL`, `BOB_EMAIL`, `CAROL_EMAIL` and `DAVE_EMAIL` (without notification emails), and skips unset emails and the admin itself.

| File | Shared with | Story |
|---|---|---|
| Engineering/Runbooks/Payment service runbook | Alice, Bob, Carol (via the Runbooks folder) | `seed:drive -- --edit-runbook` adds a failover step (S2) |
| Engineering/Runbooks/Incident response handbook | Alice, Bob, Carol (via the folder) | Long doc, split into several chunks |
| Engineering/Postmortems/Payment outage postmortem | Alice, Carol | Pairs with `#payments-incident` |
| Engineering/DB migration plan, On-call rota (Sheet), README.md | Alice, Bob, Carol | Pairs with `#db-migration` |
| Security/Q3 breach report | Carol | Restricted (S3) |
| Vendors/Vendor onboarding guide | Carol, Dave | Contractor |
| Vendors/Vendor SLA agreement.pdf | Carol, Dave | A real PDF: text is extracted |

`seed:drive -- --revoke bob` removes Bob from the Runbooks folder (S4). Run `seed:drive` again to share it back.

## 4. Search and Ask

Open **http://localhost:3000/drive.html** (the Drive API and page are on whenever `GOOGLE_CLIENT_ID` is set). Pick two people and ask the same question as both. From the terminal, `npm run drive:ask` does the same and also prints the admin view:

```bash
npm run drive:ask -- --as bob "How do we fail over the payment database?"
npm run drive:ask -- --as dave --search SLA
```

How a question is answered:
1. The person's **keys** come from their email: `drive:user:<email>`, `drive:anyone`, and their Workspace domain.
2. Elasticsearch **filters by those keys inside the query**. Files not shared with them are never scored or returned.
3. **Live re-check:** each matching file's sharing is read from Drive right now, and anything no longer shared is dropped. If Drive can't be reached, the file is withheld (fail closed). When the index was behind, its labels are fixed on the spot instead of waiting for the next poll.
4. Only chunks that pass both checks are shown, or put in the LLM prompt. The prompt says to answer only from them, cite `[n]`, and say "I don't have information on that" otherwise.
5. The **audit record is written before anything is returned**. No answer goes out unlogged.

"Nothing matched" and "everything that matched is restricted" look identical to the person asking.

Ask needs a working LLM (`LLM_*` in `.env`, see the README). Search doesn't.

## 5. Audit log

Every search and question is recorded in `brain-audit`: who, when, the question, the keywords, the answer, and per document whether it was **shown** (★ = cited), **withheld** (matched but not shared with them), or **dropped** by the live re-check (with the reason).

```bash
npm run audit:log -- --user bob                    # everything Bob asked
npm run audit:log -- --doc <Drive file ID>         # who was shown, denied or dropped this file
npm run audit:log -- --denied --since 2026-10-01   # every time something was withheld
npm run audit:verify                               # recompute the hash chain; exits 1 if tampered
```

The same is on `/drive.html` under **Admin** (needs `ADMIN_TOKEN`), with a **Verify audit chain** button.

**Tamper-evident:** each record stores the previous record's hash, and its own hash is an HMAC over its contents plus that link. The key is in `.secrets/audit-key` (or `AUDIT_KEY`), never in Elasticsearch. Editing, deleting or reordering any record breaks verification from that point on, and someone with write access to Elasticsearch can't forge a consistent chain without the key. Removing records from the *end* can only be caught by comparing the head (`audit:verify` prints it) with one noted earlier. For production, publish the head somewhere append-only (for example, object storage with retention lock).

Losing `.secrets/audit-key` makes old records unverifiable. To start a fresh log for a demo, delete the `brain-audit` index; the key can stay.

## 6. Switch to a dedicated admin

Right now the Drive admin may also be a persona (e.g. Alice). The admin owns every seeded file, so that persona sees everything, which breaks the demo story. `drive:doctor` warns about it. To fix:

1. Create a Google account that isn't a persona (e.g. `hma-brain-admin@gmail.com`).
2. Google Cloud → Google Auth Platform → **Audience → Test users**: add it.
3. Connect as that account (Admin panel on `/drive.html`, or `npm run drive:connect`).
4. `npm run seed:drive`: creates a fresh "Company A" in the new admin's Drive, shared with all four personas.
5. `npm run drive:backfill`: rebuilds the index from the new folder. (A poll notices the account change and does this by itself.)
6. `npm run drive:doctor`: should show no admin warning.

Also set `CAROL_EMAIL` to the email Carol uses in Slack, so Carol-only files have someone who can see them. Identities are matched across sources by email.

## 7. Demo script (Drive)

| # | Do | Expect | Scenario |
|---|---|---|---|
| 1 | Ask, Bob vs Dave: `How do we fail over the payment database?` | Bob: steps from the runbook, cited. Dave: no information. | S1, S3 |
| 2 | Ask, Bob: `What was in the Q3 breach report?` | No information; nothing reveals the report exists. Admin view: "withheld: Q3 breach report". | S3 |
| 3 | `npm run seed:drive -- --edit-runbook`, click **Sync now**, ask again | The new pay-db-2 step appears within seconds (or within a minute by polling) | S2 |
| 4 | `npm run seed:drive -- --revoke bob`, then Bob asks again **without syncing** | Runbook gone from Bob's answer. Admin view: "dropped by live re-check: access removed in Drive". Then `npm run seed:drive` to restore. | S4 |
| 5 | Admin panel: filter by Bob, then **Verify audit chain** | Every question with shown, withheld and dropped files; "All N records intact" | S5 |

## How it stays current

Every change (edit, share or unshare, folder share or unshare, move, rename, trash) produces a changes-feed entry for each affected file. Each poll re-reads those files and:
- rewrites their chunks if the content, name or folder changed;
- only relabels them if just the sharing changed;
- removes them if they were trashed or moved out of the folder.

The sync position is saved after each poll, so nothing is missed while the server is off. With `DRIVE_SYNC=on`, the server also runs a full reconcile every `DRIVE_RECONCILE_MINUTES` (default 60) in case a poll missed something. Unlike Slack's live events, several people can poll at once.

Text extraction: Google Docs as Markdown, Sheets as CSV (first sheet), Slides as text, text and Markdown files as is, **PDFs** via their text layer (scanned PDFs are indexed by title only). Everything else is indexed by title.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | The Google app. Drive features are off without them. |
| `DRIVE_SYNC` | `off` | `on`: the server polls Drive and reconciles |
| `DRIVE_POLL_SECONDS` | `60` | How often to poll the changes feed |
| `DRIVE_RECONCILE_MINUTES` | `60` | Full reconcile interval while the server runs (`0` = off) |
| `DRIVE_ROOT_FOLDER_NAME` / `DRIVE_ROOT_FOLDER_ID` | `Company A` | The folder to index |
| `ADMIN_TOKEN` | | 16+ random characters. Unlocks the Admin panel (audit log, Connect). Off when unset. |
| `GOOGLE_REDIRECT_URI` | `http://localhost:<PORT>/connect/google/callback` | For the Connect button; must be registered on the OAuth client |
| `AUDIT_INDEX` | `brain-audit` | Audit log index |
| `AUDIT_KEY` / `AUDIT_KEY_FILE` | `.secrets/audit-key` | HMAC key for the audit chain (generated if missing) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything unclear | `npm run drive:doctor` |
| `Google Drive isn't connected` | Connect (section 2) |
| `Google token expired or was revoked` | Connect again (Testing-mode tokens last 7 days) |
| `No folder named "Company A"` | `npm run seed:drive`, or set `DRIVE_ROOT_FOLDER_ID` |
| `redirect_uri_mismatch` on sign-in | Add the redirect URI from section 1 to the OAuth client (the app's port must match) |
| Ask fails with `LLM error 401` | `LLM_API_KEY` is missing or wrong for `LLM_BASE_URL`. Search still works. |
| Admin panel says "Admin features are off" | Set `ADMIN_TOKEN` in `.env` and restart |
| `drive:verify` fails | `npm run drive:poll`; if still failing, `npm run drive:backfill` |
| `audit:verify` fails | The log was changed outside the app, or `.secrets/audit-key` changed. The output names the first bad record. |
