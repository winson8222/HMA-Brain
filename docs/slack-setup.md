# Slack setup

[← Back to README](../README.md)

Skip this section if your workspace already has the **Internal Brain** app installed and `.env` has `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

## 1. Create a workspace

1. Go to https://slack.com/get-started#/createnew and sign up. You become the owner.
2. Stay on the **Free** plan.

## 2. Create the demo people

The demo uses four personas. Each needs its own email address (separate Gmail accounts work best). Invite them from **workspace name → Invite people**, accept each invite in its own browser profile, and set each **display name**: profile picture → Profile → Edit.

| Persona | Role in the story |
|---|---|
| **Carol** (you, the owner) | Security team, sees everything |
| **Alice** | Backend engineer on the payments incident |
| **Bob** | Junior engineer, public channels only |
| **Dave** | "Contractor", only in `#vendor-support` and no private channels |

On the Free plan Dave is a full member, so like everyone he can read all *public* channels. His restriction shows on the private channels. Real guest accounts (paid plans) are limited to their own channels, and the code already handles them.

## 3. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App → From a manifest** → choose your workspace.
2. Paste this manifest and click **Create**:

```yaml
display_information:
  name: Internal Brain
features:
  bot_user:
    display_name: brain
    always_online: true
oauth_config:
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
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

3. **Basic Information → App-Level Tokens → Generate Token and Scopes**: name it `socket`, add scope `connections:write`. Copy the `xapp-…` token into `.env` as `SLACK_APP_TOKEN`.
4. **Install App → Install to Workspace → Allow**. Copy the **Bot User OAuth Token** (`xoxb-…`) into `.env` as `SLACK_BOT_TOKEN`.
5. Put the four persona emails in `.env` (`CAROL_EMAIL`, `ALICE_EMAIL`, `BOB_EMAIL`, `DAVE_EMAIL`).

Socket Mode means Slack sends events over a websocket that the server opens, so **no public URL is needed**.

## 4. Seed the workspace

```bash
npm run seed:slack
```

This writes **only to Slack**, never to Elasticsearch, and is safe to re-run. It:

1. Finds each persona by email.
2. Creates any missing channels. The bot creates them, so it's automatically inside the private ones.
3. Adds members.
4. Posts the storyline messages (shown in Slack as e.g. "Alice APP", because the bot posts them).

| Channel | Visibility | Members |
|---|---|---|
| `#general` (may be called `#all-<workspace>`) | public | everyone |
| `#payments` | public | Carol, Alice, Bob |
| `#db-migration` | public | Carol, Alice, Bob |
| `#vendor-support` | public | Carol, Dave |
| `#payments-incident` | **private** | Carol, Alice |
| `#security` | **private** | Carol |

To read a private channel created by hand, the bot must be a member: type `/invite @brain` in it.

## 5. Giving teammates access to the existing workspace

Use this when the workspace is already set up and someone new (a teammate, a judge) needs access.

**Step 1: the workspace owner invites them.** Pick one:

- **Invite link:** click the workspace name (top left) → **Invite people to …** → **Copy invite link**. Send the link privately, e.g. by DM. On the Free plan it expires after 30 days, and you can turn it off from the same menu.
- **By email:** same menu → enter their email → **Send**.

They accept, sign in, and set a display name (profile picture → **Profile** → **Edit**).

**Step 2: give them channel access.**

| Channel type | How they get in |
|---|---|
| Public (`#payments`, `#db-migration`, `#vendor-support`) | They can already read them. To join: **Channels → Browse channels → Join**. |
| Private (`#payments-incident`, `#security`) | An existing member opens the channel → channel name → **Members** → **Add people**. |

Choose access according to the role you want them to play. For example, add someone only to `#payments-incident` to make them "another Alice". They appear in the app's person dropdown on the next page load, with access matching their real Slack memberships. **No code or `.env` change is needed.**

**Step 3 (developers only): access to the Slack app and its tokens.** Don't paste tokens into chat or commit them. Instead, the app owner adds them as a collaborator at https://api.slack.com/apps → **Internal Brain** → **Collaborators** → add their Slack account. They can then copy `SLACK_BOT_TOKEN` (OAuth & Permissions) and `SLACK_APP_TOKEN` (Basic Information → App-Level Tokens) into their own `.env`.

**Only run one server per Slack app at a time.** With Socket Mode, Slack sends each event to **one** of the open connections, not all of them. If two teammates run `npm run dev` with the same app token, each copy misses some messages. Take turns, run `npm run backfill` after switching, or have each developer create their own Slack app from the manifest in step 3.
