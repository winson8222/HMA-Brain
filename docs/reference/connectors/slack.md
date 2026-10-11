# Slack connector

**Status: implemented.** [Setup](../../setup/slack.md) · [Tests](../../demo/audit-test-plan.md#slack)

## Permission structure

| Content | Who can read it in the demo |
| --- | --- |
| Public channel | Full members of that workspace; guests are limited to their channels |
| Private channel | Its members |
| DM or group DM | The conversation's participants |
| Another workspace | Only people with membership there |

People are joined across workspaces by email. Accounts without an email use a workspace-scoped identity. Bot access determines what channels can be indexed; connected participant tokens supply DMs that the bot cannot read.

## How access is enforced

Messages carry workspace and channel labels such as `slack:<team>:channel:<id>`. DMs carry `person:<email>` labels for participants. The query uses the person's combined access keys across workspaces.

Channel candidates are checked using fresh Slack membership/channel information before returning. DMs use participant labels rather than a separate channel live check. A DM remains indexed while at least one connected participant supplies access; disconnect cleanup removes conversations when no connected participant remains.

## Updates and design decisions

| Change | Mechanism | Why |
| --- | --- | --- |
| Message created, edited or deleted | Socket Mode events | Slack can push these changes without repeated full scans |
| Member joins or leaves | Event invalidates the person's cached access | Membership changes affect the person, not every message's labels |
| Channel privacy changes | Reconcile every 5 minutes | This implementation does not rely on a privacy-change event |
| Channel renamed | Event updates indexed labels/title; reconciliation is a fallback | Apply visible names quickly |
| Missed history | `npm run backfill` | Reads source history after downtime; it rebuilds the Slack index |

Only one server per Slack app should use `SLACK_SYNC=on`: Socket Mode can distribute events between connected instances. A second laptop should use `off` and backfill its own index. Events are normally fast, but there is no guaranteed delivery deadline.

## Audit records and timing

- Message events write added, updated and deleted content records. Source time comes from the message/edit/delete event; detection time is when the handler receives it.
- Human channel join/leave events write permission summaries such as “Bob left (lost access).” They do not include a full before/after membership list. Bot joins produce backfill summaries.
- Privacy reconciliation writes before/after labels; source change time is unknown.
- Slack Connect and Disconnect write account records. Connecting and backfilling DMs can write a content summary.
- DM change titles are anonymized as a DM or group DM. Source message bodies are not copied into change records.

Search/Ask decisions are logged separately in the [shared chain](../architecture.md#shared-audit-chain). A processed membership event may turn a subsequent search into withheld rather than dropped; both should prevent private content being returned.

## Limitations

- A rename event updates the cache before reconciliation compares it, so the current version can miss the rename audit record. Test this as a known gap.
- Disconnect logs the account action but does not list every DM conversation removed.
- A restart loses the in-memory channel comparison baseline. Reconcile is not a complete historical account of privacy changes.
- Backfill summaries do not provide per-message change history for the initial import.

Implementation: `src/slack.ts`, `src/people.ts`, `src/search.ts`, `src/events.ts`, `src/sync.ts`, `src/dms.ts` and `src/connectors/slack/`.
