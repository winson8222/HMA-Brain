# Google Drive setup

## 1 Prerequisites

Complete [project quick start](../../README.md#run-an-already-configured-demo). Use a dedicated Google account that can read all files under the demo folder and inspect their sharing. The supported demo scope is one My Drive folder, normally Company A.

## 2 Create accounts and source access

Use Carol's configured Drive account as the crawler. The seed shares files with the persona emails. Those emails must match the identities used in HMA Brain. See [demo data](../demo/data/slack-and-drive.md) for the intended folder access.

Bob or Dave must not be the owning crawler account in these tests: an owner can still read every file after a reader share is removed. To switch, reconnect using Carol or a dedicated crawler, seed that account's demo folder, set its folder ID if needed, and rebuild the Drive index for the new scope.

## 3 Configure credentials and settings

1. In Google Cloud, enable the Drive API for the app's project.
2. Configure the OAuth consent screen. In testing mode, add the accounts that will authorize the app as test users.
3. Configure the app's Drive scopes, `drive.readonly` and `drive.file`; the latter supports the demo seed's file creation and editing.
4. Create a web OAuth client. Register `http://localhost:8765/oauth2callback` for CLI connection and `<PUBLIC_URL>/connect/google/callback` for the web connection.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
6. Set `DRIVE_ROOT_FOLDER_NAME=Company A`, or an explicit `DRIVE_ROOT_FOLDER_ID`. Choose `DRIVE_SYNC=on` for server polling, `off` for controlled manual tests.

## 4 Link people

Connect the crawler, either with `npm run drive:connect` or through the admin controls on `/drive.html`. Authorize the same Google account that owns/reads the demo folder. Its token is saved to `.secrets/google-token.json` by default.

There is no separate per-person Drive connection in this demo. Asker access is derived from email and fresh file sharing; see [Drive design](../reference/connectors/drive.md).

## 5 Import data and enable updates

```bash
npm run seed:drive
npm run drive:backfill
npm run drive:doctor
```

For the full Slack/Drive story, use `seed:story` after both platforms and persona connections are ready. Server polling runs with `DRIVE_SYNC=on`; a manual catch-up is `npm run drive:poll`.

## 6 Verify and test

Select Drive on the main page. As Bob, ask **How do I fail over the payment database?** After reset, expect pay-db-2 and pool 200. As Dave, search for the Payment outage postmortem before revoking his share. Use `npm run drive:verify` to compare source/index state and the [Drive audit tests](../demo/audit-test-plan.md#google-drive) for the full sequence.

## 7 Troubleshoot and restore

- Token expired/revoked: reconnect the same crawler account; check the OAuth consent configuration and token lifetime.
- Missing folder: verify the folder ID/name and that it is visible to the crawler.
- Missing group-only or link-only result: check the connector's [supported sharing model](../reference/connectors/drive.md).
- Restore the seeded runbook and shares with `npm run seed:drive -- --reset`, then `npm run drive:poll`.

The seed reset changes source demo content. `drive:backfill -- --reset` instead rebuilds local Drive indexes. Neither is an audit-history reset.
