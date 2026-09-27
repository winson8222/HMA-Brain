# Google Drive setup

[← Back to README](../README.md)

The Drive connector reads one folder (default: **Company A**) in an admin account's My Drive. It indexes every file with its real sharing, and keeps the index current by polling Drive's changes feed. Data goes to its own indexes, `brain-drive` (chunks) and `brain-drive-state` (sync bookkeeping), so a Slack backfill never touches it.

## 1. Google Cloud app (once, by a developer)

In https://console.cloud.google.com, for the project that holds the "HMA Brain" app:

1. **APIs & Services → Library → Google Drive API → Enable.**
2. **Google Auth Platform:**
   - **Audience:** External, **Testing**. Add the admin account and the personas as **test users**.
   - **Data access:** scopes `.../auth/drive.readonly` and `.../auth/drive.file`.
   - **Clients → Web application**, with redirect URI `http://localhost:8765/oauth2callback`.
3. Put the client's ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 2. Connect Drive (once, as the Company A admin)

```bash
npm run drive:connect
```

Sign in as the **admin** account. Google shows "Google hasn't verified this app": click **Continue**, then **Allow**. The refresh token is saved to `.secrets/google-token.json` (gitignored), and the crawler runs on it from then on.

The client ID and secret only identify our app. The token is what grants access to this admin's Drive. In **Testing** mode Google expires the token after **7 days**; if you see "Google token expired or was revoked", run `npm run drive:connect` again.

## 3. Demo data, first sync, live updates

```bash
docker compose up -d        # Elasticsearch
npm run seed:drive          # creates "Company A" in the admin's Drive and shares files with the personas
npm run drive:backfill      # index everything (re-runs skip unchanged files)
npm run drive:verify        # optional: check the index matches Drive
npm run drive:poll -- --watch   # or set DRIVE_SYNC=on and run `npm run dev`
```

`seed:drive` writes only to Drive. It shares with `BOB_EMAIL`, `CAROL_EMAIL` and `DAVE_EMAIL` (without notification emails), and skips unset emails and the admin itself.

| File | Shared with | Story |
|---|---|---|
| Engineering/Runbooks/Payment service runbook | Bob, Carol (via the Runbooks folder) | `seed:drive -- --edit-runbook` adds a failover step, which shows up after the next poll |
| Engineering/Postmortems/Payment outage postmortem | Carol | Pairs with `#payments-incident` |
| Engineering/DB migration plan, On-call rota (Sheet), README.md | Bob, Carol | Pairs with `#db-migration` |
| Security/Q3 breach report | Carol | Restricted |
| Vendors/Vendor onboarding guide | Carol, Dave | Contractor |

## How it stays current

Every change (edit, share or unshare, folder share or unshare, move, rename, trash) produces a changes-feed entry for each affected file. Each poll re-reads those files and:
- rewrites their chunks if the content, name or folder changed;
- only relabels them if just the sharing changed;
- removes them if they were trashed or moved out of the folder.

The sync position is saved after each poll, so nothing is missed while the server is off. Unlike Slack's live events, several people can poll at once.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No Google token at .secrets/google-token.json` | `npm run drive:connect` |
| `Google token expired or was revoked` | `npm run drive:connect` (Testing-mode tokens last 7 days) |
| `No folder named "Company A"` | `npm run seed:drive`, or set `DRIVE_ROOT_FOLDER_ID` |
| `redirect_uri_mismatch` on sign-in | Add `http://localhost:8765/oauth2callback` to the OAuth client's redirect URIs |
| `drive:verify` fails | `npm run drive:poll`; if still failing, `npm run drive:backfill` |
