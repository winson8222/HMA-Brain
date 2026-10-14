# Slack setup

## 1 Prerequisites

Complete [project quick start](../../README.md#run-it). Use dedicated test accounts and two workspaces: Company A (`main`) for Carol, Alice and Bob; Company A Vendors (`vendors`) for Carol and Dave. Use the same email for Carol in both.

## 2 Create accounts and source access

Create the workspaces as Carol. Invite Alice/Bob to Company A and Dave to Vendors. Accept each invitation in that person's browser profile. Set persona emails in `.env`.

The story seed creates channels and memberships. A private channel that already exists must include the bot before it can be read or seeded. Dave is a full member of the vendor workspace in this demo; the workspace boundary keeps him out of Company A.

## 3 Configure credentials and settings

1. In [Slack apps](https://api.slack.com/apps), create an app **from a manifest** for each workspace using [slack-app-manifest.yaml](slack-app-manifest.yaml).
2. Set the redirect URL to `<PUBLIC_URL>/slack/oauth/callback`, then install the app in its workspace.
3. Copy the bot token, client ID and client secret. Create an app-level token with `connections:write` for Socket Mode.
4. Fill in the `main` and `vendors` entries in `slack-tokens.json` using the example file's structure. Leave user tokens to the Connect flow.
5. Set `SLACK_SYNC=on` for exactly one ingesting server per Slack app. Other instances use `off` and their own backfills.

The manifest includes write scopes needed to seed demo messages as the personas. They are not needed for a read-only production connector. Reinstall an existing app after scope changes.

## 4 Link people

Start `npm run dev`. Each person opens `/connect.html` in their own browser profile and connects their workspace. Carol connects both. This signs them into Aspire Atlas and authorizes DM ingestion. The callback address must match the Slack app configuration.

Selecting someone in Demo mode does not create their connection. Disconnect revokes the stored user token and cleans up DMs that no other connected participant supplies.

## 5 Import data and enable updates

For the current story demo, complete [Drive setup](drive.md) first: `seed:story` seeds both Drive and Slack.

```bash
npm run seed:story -- --dry-run
npm run seed:story
npm run backfill
npm run verify
```

`seed:story` reports authors who still need to connect; connect them and rerun. Do not mix in `seed:slack`, which creates the older smaller dataset. `backfill` rebuilds the Slack index, so use it for initial import or recovery rather than every live event.

## 6 Verify and test

Search `outage` as Alice and Bob, with Slack alone selected. Alice should see payments-incident evidence; Bob should not in the baseline. Post a disposable channel message and verify it arrives with live sync enabled. Follow the [Slack audit tests](../demo/audit-test-plan.md#slack) for changes and restoration.

## 7 Troubleshoot and restore

- Missing private content: invite the bot and check the person's membership.
- Missing DMs: connect at least one participant, then import their history.
- Missing events: check Socket Mode and ensure only one server consumes the app's events.
- Teammates sharing test tokens should use `SLACK_SYNC=off`; those tokens can read the connected test accounts' DMs.
- Restore test channel memberships and delete temporary messages. Account restoration requires reconnecting the same person.

See [Slack design](../reference/connectors/slack.md) for permissions, event handling and audit limitations.
