# Slack setup

[← Back to README](../README.md)

The demo uses **two Slack workspaces** and people's **private messages (DMs)**:

| Workspace | Key | People | Channels |
|---|---|---|---|
| **Company A** | `main` | Carol (owner), Alice, Bob | `#all-company-a`, `#payments`, `#db-migration`, `#eng-auth`, `#releases`, `#social`, 🔒 `#payments-incident`, 🔒 `#security` |
| **Company A – Vendors** | `vendors` | Carol (owner), Dave | `#all-company-a-vendors`, 🔒 `#acme-escalation`, 🔒 `#vendor-contracts` |

Plus DMs: Carol → Alice and Bob, Alice ↔ Carol, Alice ↔ Bob (in `main`), and Carol ↔ Dave (in `vendors`). Both workspaces were created by Carol (`carolhmatest@gmail.com`), and only the four personas are in them. What's in them and when it was posted: [demo-data.md](demo-data.md).

**What you do by hand:** create the workspaces, people and Slack apps (steps 1–4), and have personas click Connect (step 6).
**What the script does:** channels, members and all messages (`npm run seed:story`, see [demo-data.md](demo-data.md#rebuilding)). `npm run seed:slack` is the earlier, smaller demo; don't run it against the story's workspaces.

Already set up and just joining as a teammate? Go to [step 8](#8-teammates-joining-an-existing-setup).

---

## 1. Create workspace A (skip if it exists)

1. Go to https://slack.com/get-started#/createnew and sign up with your own email. You become the owner, and you'll play **Carol**.
2. Name it `Company A`. Stay on the **Free** plan.

## 2. Create the demo people

Each persona needs its own email (separate Gmail accounts work best). Invite them from **workspace name → Invite people**, accept each invite in its **own browser profile**, and set each **display name** (profile picture → Profile → Edit).

| Persona | Email in `.env` | Role in the story |
|---|---|---|
| **Carol** (you, the owner) | `CAROL_EMAIL` | Security team, in both workspaces, sees the most |
| **Alice** | `ALICE_EMAIL` | Backend engineer on the payments incident |
| **Bob** | `BOB_EMAIL` | Junior engineer, public channels only |
| **Dave** | `DAVE_EMAIL` | "Contractor" from Acme: in workspace B only |

Put the four emails in `.env`. The seed script uses them to find each person in each workspace, so the email **must be the same** in both workspaces.

On the Free plan Dave is a full member, so like everyone he can read all *public* channels in a workspace he's in. His restriction shows on private channels and on workspace boundaries.

## 3. Create workspace B

1. Signed in as Carol, create a second workspace: https://slack.com/get-started#/createnew. Use Carol's **same email** and name it `Company A – Vendors`.
2. Invite **Dave only** (his same email), and have him accept it in his browser profile and set his display name.

## 4. Create a Slack app in each workspace

Do this **once per workspace**. Each workspace gets its own app from the same manifest.

1. Go to https://api.slack.com/apps → **Create New App → From a manifest** → pick the workspace.
2. Paste this manifest. If you'll also use a shared or hosted address, add it under `redirect_urls` (see [Where Connect returns to](#where-connect-returns-to)). Click **Create**.

```yaml
display_information:
  name: Internal Brain
features:
  bot_user:
    display_name: brain
    always_online: true
oauth_config:
  redirect_urls:
    - http://localhost:3000/slack/oauth/callback
  scopes:
    bot:
      - channels:read
      - groups:read
      - channels:history
      - groups:history
      - channels:join
      - users:read
      - users:read.email
      - channels:manage
      - groups:write
      - chat:write
      - chat:write.customize
    user:
      - im:history
      - mpim:history
      - im:read
      - mpim:read
      - im:write
      - mpim:write
      - chat:write
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - member_joined_channel
      - member_left_channel
      - channel_created
      - channel_rename
      - channel_archive
      - channel_unarchive
      - group_archive
      - group_unarchive
      - group_rename
    user_events:
      - message.im
      - message.mpim
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

3. **Install App → Install to Workspace → Allow.**
4. Collect four values for step 5:

| Value | Where in the app's settings |
|---|---|
| `botToken` (`xoxb-…`) | **OAuth & Permissions** → Bot User OAuth Token |
| `appToken` (`xapp-…`) | **Basic Information → App-Level Tokens → Generate Token and Scopes**: name `socket`, scope `connections:write` |
| `clientId` | **Basic Information → App Credentials** → Client ID |
| `clientSecret` | **Basic Information → App Credentials** → Client Secret (click Show) |

**Already have the app in workspace A from the earlier single-workspace setup?** Don't create a new one. Open it → **App Manifest** → replace it with the manifest above → **Save Changes** → **reinstall** when Slack asks. Your bot and app tokens stay the same. You only need to add `clientId` and `clientSecret`.

The `user` permissions are what personas approve when they click Connect: reading their own DMs and group DMs. `im:write`, `mpim:write` and `chat:write` are **demo-only**: they let the seed script post the demo DMs *as* each persona. Remove them for real use.

## 5. Fill in `slack-tokens.json`

```bash
cp slack-tokens.example.json slack-tokens.json
```

Fill in one entry per workspace with the values from step 4. Keep the keys `main` and `vendors`: the seed script uses them to know which workspace gets which channels.

```json
{
  "workspaces": [
    { "key": "main",    "botToken": "xoxb-…", "appToken": "xapp-…", "clientId": "…", "clientSecret": "…" },
    { "key": "vendors", "botToken": "xoxb-…", "appToken": "xapp-…", "clientId": "…", "clientSecret": "…" }
  ],
  "users": []
}
```

Leave `users` empty: Connect fills it in (step 6). The file is git-ignored. **Never commit it.**

Then seed the channels in both workspaces and start the app:

```bash
npm run seed:slack      # channels, members and channel messages in both workspaces
npm run dev
```

The seed ends by listing whose DMs couldn't be posted yet, because they haven't connected.

## 6. Connect the personas

Each persona opens **http://localhost:3000/connect** in **their own browser profile** (where Slack is signed in as them) and clicks **Connect** for each workspace they're in, then **Allow** in Slack.

| Persona | Connect |
|---|---|
| **Alice** | Company A (needed: she sends demo DMs) |
| **Carol** | Company A **and** Company A – Vendors (needed: she sends demo DMs in both) |
| Bob, Dave | Optional. Their DMs are already readable through Alice's and Carol's connections |

Connecting also **signs that browser in**, which is what the main page's **Me** mode uses.

### Where Connect returns to

After someone clicks Allow, Slack sends their browser back to **`PUBLIC_URL`/slack/oauth/callback**. `PUBLIC_URL` is set in `.env` (default `http://localhost:3000`). For security, Slack only returns people to addresses listed in the app's `redirect_urls`, so every address you use must be in **both** apps' manifests:

| Running on | `PUBLIC_URL` in `.env` | Add to `redirect_urls` |
|---|---|---|
| Your laptop | `http://localhost:3000` | `http://localhost:3000/slack/oauth/callback` (in the manifest above) |
| ngrok, to share | `https://your-name.ngrok-free.dev` | `https://your-name.ngrok-free.dev/slack/oauth/callback` |
| A hosted server | `https://brain.example.com` | `https://brain.example.com/slack/oauth/callback` |

You can list several addresses at once. Switching between them is then just a `.env` change and a restart. If Slack refuses the localhost address, use your ngrok address as `PUBLIC_URL` while connecting.

## 7. Seed the DMs and load everything

```bash
npm run seed:slack      # now also posts the DMs, as each persona
npm run backfill        # optional: rebuild the whole index from Slack
npm run verify          # check channels and DMs in both workspaces match the index
```

If the server is running with `SLACK_SYNC=on`, new channel messages **and DMs** are indexed live. Otherwise run `npm run backfill`.

**Disconnecting** (on `/connect`) revokes that person's access and removes their DMs from the index, unless another participant in the DM is still connected.

---

## 8. Teammates joining an existing setup

**Join the workspaces.** The owner invites them to each workspace (workspace name → **Invite people** → invite link or email). Public channels are readable straight away. For private channels, an existing member adds them (channel name → **Members** → **Add people**). They show up in the app's person list on the next page load, with access matching their real Slack memberships.

**Run the app with the shared setup:**

1. Get `slack-tokens.json` from the connector owner **privately** (DM or password manager), and put it in the project folder.
2. In `.env`, keep `SLACK_SYNC=off` (the default), and run `npm run backfill` whenever you want the latest messages.

| Who | `SLACK_SYNC` | Keeps their index fresh by |
|---|---|---|
| **Connector owner** (one person) | `on` | Live Slack events |
| **Everyone else** | `off` | `npm run backfill` |

Slack sends each live event to only **one** server connected with the same app, so only one person may have sync on. Backfill reads Slack's history directly, so it always gets everything, including DMs of connected personas.

`slack-tokens.json` contains the personas' **user tokens**, which can read those accounts' DMs. That's acceptable only because these are dedicated test accounts. **Never connect a real personal Slack account to a shared demo.**
