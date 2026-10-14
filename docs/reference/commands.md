# Commands and reset effects

Run commands from the repository root. Polls update the local index from source data; seed commands change source demo data. A source restoration should append reversal audit records, not erase history.

## Run and check

| Command | Effect |
| --- | --- |
| `npm run dev` | Start server with code watching |
| `npm start` | Start server without code watching |
| `npm run typecheck` | Check TypeScript |
| `npm test` | Run unit tests |
| `npm run audit:log -- --kind permission` | Query permission-change records |
| `npm run audit:log -- --doc postmortem` | Query records mentioning that document title/ID |
| `npm run audit:log -- --user bob --kind access` | Query Bob's searches/answers |
| `npm run audit:log -- --kind account,admin` | Query account and admin records |
| `npm run audit:log -- checkpoint --trust-current-head` | One-time initialization: validate and explicitly trust the current audit history, then retain its head outside Elasticsearch |
| `npm run audit:log -- backup --file <new.json>` | Save a verified private backup of the current audit history |
| `npm run audit:log -- repair --file <backup.json>` | Dry run: check the backup matches the retained checkpoint |
| `npm run audit:log -- repair --file <backup.json> --apply --evidence <new.json>` | With writers stopped, preserve damaged records and restore the verified backup without resetting trust |
| `npm run audit:verify` | Verify the stored chain against its retained checkpoint; a successful check records the verification action |

Audit query filters include `--doc`, `--user`, `--kind`, `--denied`, `--dropped`, `--since`, `--until`, `--text` and `--limit`. Permission/content actors normally equal `system`; filtering by Bob will hide those system rows. A document filter combined with a decision must match the same document entry, including when searching by title.

## Audit trail

Initialize the checkpoint before accepting new audit writes. For an existing installation, review the history before trusting its current head: initialization cannot detect records deleted before the first checkpoint. Do not delete or reinitialize a checkpoint to bypass a failed verification. Preserve it on durable storage independent of Elasticsearch.

All server and CLI writers must share the same signing key, audit index and checkpoint path; a filesystem lock serializes them. A crashed process can leave the `<checkpoint-file>.lock` directory behind: stop every writer before removing only that directory. Recovery uses a verified backup taken with `backup --file`; `repair` checks it against the current checkpoint, and `--apply --evidence` first saves the damaged records, then restores the signed backup without changing the checkpoint. An older backup cannot roll trust backwards. Design and limits: [architecture](architecture.md#audit-trail).

## Import and update

| Platform | First import or full reconcile | Apply recent changes | Diagnose |
| --- | --- | --- | --- |
| Slack | `npm run backfill` rebuilds its index | Events with `SLACK_SYNC=on`; use backfill for missed history | `npm run verify` |
| Drive | `npm run drive:backfill` | `npm run drive:poll` | `npm run drive:doctor`, `npm run drive:verify` |
| Jira | `npm run jira:backfill` | `npm run jira:poll` | `npm run jira:doctor` |
| Confluence | `npm run confluence:backfill` | `npm run confluence:poll`; restriction-only changes: `npm run confluence:poll -- --sweep` | `npm run confluence:doctor` |

Drive/Jira/Confluence normal poll commands accept `-- --watch` for a standalone loop. Stop with Ctrl+C. Confluence's normal watcher does not schedule restriction sweeps. Its `--sweep` runs the sweep instead of the normal content poll. Use server sync for automatic poll/reconcile scheduling, or run each required operation manually.

For an isolated live-recheck demonstration, stop other local sync processes and start:

```bash
DRIVE_SYNC=off JIRA_SYNC=off CONFLUENCE_SYNC=off SLACK_SYNC=on npm run dev
```

This command changes process settings only. Restart normally afterward to restore `.env` behavior. Update intervals and design reasons are in the [connector references](../README.md).

## Seed and restore

| Command or action | Scope |
| --- | --- |
| `npm run seed:story -- --dry-run` | Preview the current Slack/Drive story |
| `npm run seed:story` | Create the story's Slack messages/channels and Drive content; personas must connect first |
| `npm run seed:slack` | Older dataset; do not mix with the current story demo |
| `npm run seed:drive` | Create missing seeded Drive files/shares |
| `npm run seed:drive -- --edit-runbook` | Change the runbook to pay-db-3/pool 400 |
| `npm run seed:drive -- --close-vendor-access` | Remove Dave's direct postmortem share |
| `npm run seed:drive -- --reset` | Restore seeded shares and original runbook; follow with `drive:poll` |
| `npm run seed:jira` | Create/fix demo configuration; existing issue content is normally skipped |
| `npm run seed:jira -- --update` | Rewrite seeded issue fields/statuses and possibly replace comments; a broad reset |
| Restore Jira fields manually, then `npm run jira:poll` | Preferred targeted test cleanup; never delete seeded issues to reset them |
| `npm run seed:confluence -- --dry-run` | Preview space/page seed operations |
| `npm run seed:confluence` | Create/restore seeded pages and restrictions; removes matching template pages |
| `npm run seed:confluence -- --restrict-drill` | Restrict the drill page to Alice, Carol and crawler |
| `npm run seed:confluence -- --unrestrict-drill` | Restore open drill page; follow with a sweep |
| `npm run seed:confluence -- --edit-rollout` | Set the signing-key rotation decision |
| `npm run seed:confluence -- --restore-rollout` | Restore the original rollout; follow with a content poll |

Slack cleanup is manual: restore membership/names and delete test messages. Exact order and expected audit evidence are in [the audit test plan](../demo/test-plan.md).

## Index resets are different

- `npm run backfill` always rebuilds the Slack index.
- `npm run drive:backfill -- --reset` rebuilds Drive content/state indexes, not Google Drive files.
- `npm run jira:backfill -- --reset` rebuilds Jira content/state indexes, including removal of stored Atlassian links. Relink personas; Confluence uses those links too.
- `npm run confluence:backfill -- --reset` rebuilds Confluence content/state indexes. Its Atlassian links live in Jira state.
- Preserve `brain-audit`, its signing key and its retained checkpoint during rehearsal. Deleting source indexes is not a normal test reset.

## Other tools

- `npm run drive:connect`: authorize the shared Drive crawler.
- `npm run drive:ask -- --as bob "question"`: Drive-only terminal query; add `--search` for Search.
- `npm run prompts:seed`: publish the app's prompt definitions to configured Langfuse.
- `npm run judge`: run the configured answer evaluation workflow; it can call models and write evaluation scores.

For credentials and first-run steps, use the [setup guides](../README.md).
