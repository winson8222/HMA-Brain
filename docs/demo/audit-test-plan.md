# Audit trail manual test plan

Test Google Drive, Jira, Slack and Confluence permission changes, content changes, account connections and admin actions. Each scenario includes the query, expected audit evidence, sync command and restoration steps.

**Access enforcement and permission-change logging are separate.** A search checks live access before returning results and records its own shown, withheld or dropped decisions. Connector-specific checks and limits are described in the [connector references](../README.md). The separate permission-change record can arrive later through polling, a sweep or a Slack event. Test the next search **before polling** to exercise live protection.

## Setup

1. Use the configured demo environment and seeded data. Run commands from the repository root.
2. Ensure each test person has connected the right accounts. On `/connect.html`, sign in through Slack as that person, then **Connect Atlassian** using their own Atlassian account. The same link supports Jira and Confluence. Confluence caches identity access for up to 5 minutes; after a link change, wait for refresh or restart the server before testing. Selecting Bob in Demo mode does not create his account link. Use a separate browser profile for each person.
3. Select **only the platform being tested**. Another source can legitimately contain the same information.
4. Prefer **Search** for permission tests and inspect the returned source cards. Use **Ask** to test answer logging. An answer starting with “I don't have information” is not proof of denial if its source cards still contain the document.
5. Open **Audit log** on the main page and unlock with `ADMIN_TOKEN`. Note the test start time. Use **Apply** to reload after actions; clear stale filters between scenarios.
6. Note original Jira field values, Slack membership and any source content you edit. Restore each scenario before moving on.

For a controlled test without background polls, stop the existing local server and any CLI watchers, then start one server with:

```bash
DRIVE_SYNC=off JIRA_SYNC=off CONFLUENCE_SYNC=off SLACK_SYNC=on npm run dev
```

This leaves Slack events enabled while Drive, Jira and Confluence are synced manually. Ensure no other server is polling the same demo data. At the end, stop this server and restart with `npm run dev` to use your existing `.env` settings again. Only one server per Slack app should receive its events.

If baseline data or connections are missing, check setup first:

```bash
npm run drive:doctor
npm run jira:doctor
npm run confluence:doctor
```

These are setup diagnostics, not substitutes for the tests below.

## Polling and audit commands

| Platform or task | Run now | Normal automatic behavior when enabled |
| --- | --- | --- |
| Drive changes and permissions | `npm run drive:poll` | Poll every 60 seconds by default; a live search can also detect sharing changes and relabel the file |
| Jira issue changes and permissions | `npm run jira:poll` | Poll every 60 seconds by default; rereads project permission configuration and updated issues |
| Confluence content and space permissions | `npm run confluence:poll` | Poll every 60 seconds by default |
| Confluence page restriction changes without edits | `npm run confluence:poll -- --sweep` | Reconcile every 10 minutes by default |
| Slack messages and channel membership | No poll command | Events, usually within seconds, with `SLACK_SYNC=on` |
| Slack channel privacy changes | Wait for server reconciliation | Every 5 minutes while Slack sync is enabled |
| Verify the audit chain | `npm run audit:verify` | Also available as **Verify chain** in the Audit tab |

Automatic intervals depend on `.env` and service availability; they are not guaranteed delivery deadlines. `DRIVE_SYNC`, `JIRA_SYNC` and `CONFLUENCE_SYNC` must be `on` for their automatic jobs. A reconcile interval of `0` disables that reconcile job.

Standalone watchers are available when you are not using the server's automatic polling:

```bash
npm run drive:poll -- --watch
npm run jira:poll -- --watch
npm run confluence:poll -- --watch
```

Run only the watcher you need, in a separate terminal; stop it with Ctrl+C. The Confluence normal watcher does not schedule sweeps. Its one-off `--sweep` runs the sweep instead of a content poll. If you need both, run the normal poll and the sweep separately.

For why page restrictions use a separate sweep, see [Confluence update decisions](../reference/connectors/confluence.md#updates-and-design-decisions). Normal polling has not been extended to check every page restriction.

Useful audit queries:

```bash
npm run audit:log -- --kind permission
npm run audit:log -- --kind content
npm run audit:log -- --kind account,admin
npm run audit:log -- --user bob --kind access
npm run audit:log -- --doc postmortem
npm run audit:verify
```

Permission and content records normally have actor `system`. Clear a Person filter such as Bob or Dave when looking for those records. The Person filter identifies who acted, not who lost access.

## Google Drive

### Live permission removal

1. Establish the baseline:

   ```bash
   npm run seed:drive -- --reset
   npm run drive:poll
   ```

2. As **Dave**, select Drive and ask: **Which merchants were affected by the outage and how much was refunded?** Expect the Payment outage postmortem, including details such as M-1043 and SGD 18,400. Alternatively, Search for `Payment outage postmortem` and confirm its source card is present.
3. In Audit log, inspect Dave's access record. The postmortem should be shown; an Ask record should include the answer and cited sources.
4. Remove Dave's share:

   ```bash
   npm run seed:drive -- --close-vendor-access
   ```

5. **Without polling**, repeat the same query as Dave. The postmortem must not be returned. With the old indexed candidate still present, expect **Dropped by live re-check**. Drive's live re-check also schedules a permission-change record; it may appear just after the search finishes.
6. Run `npm run drive:poll` to catch up any remaining changes. In Audit log, clear Person and set **Document = postmortem**, **Kind = Permission changes**. Expect Dave's label removed in the before/after access. If the live re-check already recorded it, a duplicate poll record is not required.
7. Inspect time fields: a change found by live re-check may have unknown source change time; a change found from the Drive feed can have a source change time. Detection time should be present.

**Restore:**

```bash
npm run seed:drive -- --reset
npm run drive:poll
```

Expect Dave's share restored, a corresponding permission restoration record once the index had observed the removal, and Dave able to retrieve the postmortem again. The reset also restores the runbook and other seeded shares; it preserves audit history.

### Content freshness

1. As **Bob**, select Drive and ask: **How do I fail over the payment database?** After reset, expect pay-db-2 and a pool of at least 200.
2. Apply the demo edit and sync:

   ```bash
   npm run seed:drive -- --edit-runbook
   npm run drive:poll
   ```

3. Repeat the question. Expect pay-db-3 and a pool of at least 400.
4. Filter **Kind = Content changes**, **Document = runbook**. Expect an **updated** record with changed, detected and indexed times. The one-off poll applies edits immediately; background polling normally waits for the edit debounce window.

**Restore:** run the Drive reset and poll commands above. Repeat the question and check that the original runbook answer returns.

## Jira

### Live permission removal through Approvers

1. Confirm **Bob's own Atlassian account is linked** in Aspire Atlas. As Carol in Jira, open **VEND-5** and confirm **Approvers includes Bob**. If you just restored him, run `npm run jira:poll` before the baseline query.
2. As Bob, select Jira and **Search** for `payments status dashboard`. Expect **VEND-5: Approve Acme read-only access to the payments status dashboard**.
3. To exercise Ask, use **What is VEND-5 about, and who needs to approve it?** Expect Acme's read-only dashboard request and Bob as approver. Avoid using the imperative issue title as an Ask prompt: “Approve…” can be interpreted as a request to perform an action.
4. As Carol, edit VEND-5's **Approvers** field, remove Bob, and save. The field may be under **More fields**. Change the field on the issue; the existing demo permission scheme already grants access through that field.
5. **Without polling**, repeat Bob's search. VEND-5 must disappear. If it remains an indexed candidate, its access audit decision should be **Dropped by live re-check**.
6. Record the indexed permission change:

   ```bash
   npm run jira:poll
   ```

7. Clear Person and filter **Document = VEND-5**, **Kind = Permission changes**. Expect Bob's user label removed. Jira permission-change source time should be unknown; detection time should be present.

**Restore:** add Bob back to VEND-5's Approvers field, save, then run:

```bash
npm run jira:poll
```

Confirm the restored permission record and Bob's VEND-5 search result. Poll after regranting access so the indexed candidate becomes eligible again; live re-check protects against stale grants but does not discover every newly granted document.

### Content change

1. Copy VEND-5's original description so it can be restored exactly.
2. As Carol, append a temporary sentence containing `AUDIT-TEST-JIRA` to the description and save.
3. Run `npm run jira:poll`.
4. As Carol, select Jira and search `AUDIT-TEST-JIRA`. Expect VEND-5.
5. Filter **Document = VEND-5**, **Kind = Content changes**. Expect **updated**, with the issue's updated time as source change time and detected/indexed times present.

**Restore:** restore the original description and run `npm run jira:poll`. Expect another updated record and no remaining test marker in the indexed content. If you test a status change on PAY-231 instead, note its exact original status, change it, poll, and restore that status followed by another poll.

Do not delete a seeded issue to reset it: Jira does not reuse the issue key. `npm run seed:jira -- --update` is a broad demo reset that rewrites seeded issue fields and can replace comments; use the targeted restoration above for this test.

### If Bob cannot find VEND-5 before removal

- Check that Bob is linked to his own Atlassian account; Demo mode alone is insufficient.
- Confirm Bob is still in Approvers and can open VEND-5 directly in Jira.
- If Approvers is missing, check the VEND edit screen configuration. The demo uses a multi-user picker field named Approvers.
- Run `npm run jira:poll` after restoring access to refresh indexed labels.
- If source cards contain VEND-5 but the answer begins “I don't have information,” retrieval succeeded. Use Search or the explicit question above to avoid confusing answer wording with a permission failure.

## Slack

### Channel membership

1. Keep `SLACK_SYNC=on`, with the bot present in private channel **payments-incident**. Note Bob's original membership; the seeded baseline keeps him outside it.
2. Add Bob to the channel. Wait for the event to be processed.
3. As Bob, select Slack and ask **What was the root cause of the payment outage?** Or Search `outage` and check that a result from **payments-incident** appears. Public outage messages alone do not prove private-channel access.
4. Remove Bob from payments-incident and repeat the query. Its private content must disappear. The audit can show **withheld** if membership was already refreshed, or **dropped** if the live check caught a stale candidate.
5. Clear Person and filter **Document = payments-incident**, **Kind = Permission changes**. Expect Bob's joined/gained and left/lost events. Inspect event change time and detection time. Membership records use a summary rather than a full before/after label snapshot.

**Restore:** return Bob to his original membership, normally outside payments-incident. Wait for the membership event. There is no Slack poll command for this flow.

### Message added edited and deleted

1. Use a test channel the bot can read and a test person who belongs to it.
2. Post **AUDIT-TEST-SLACK version one**. Wait for its added audit record before continuing, then search for the marker with only Slack selected.
3. Edit it to **AUDIT-TEST-SLACK version two**. Wait for an updated record and confirm the new source text.
4. Delete the message. Wait for a deleted record and confirm the result is gone.
5. Inspect **Kind = Content changes**, filtering by the channel name or copied message item ID. The audit records identify the message and channel; they do not copy the message body, so the marker itself is not a suitable Document filter.

**Restore:** deletion in step 4 removes the test content. Leave the audit history intact.

### Channel rename and privacy checks

Use a disposable channel for these checks. Note its original name and privacy.

- **Rename:** rename the channel, wait for reconciliation, and look for a content-change record. The reviewed PR has a known gap: the rename event refreshes the cache before reconciliation compares names, so a record can be missing. Restore the original name afterward.
- **Privacy:** change a disposable public channel to private and wait for the server's next channel reconcile, normally within 5 minutes. Expect a permission-change record with before/after labels. Confirm a nonmember cannot retrieve its messages. Record the actual result if platform rules prevent changing privacy back; use a disposable channel so restoration does not depend on reversing that transition. Archive it after testing.

## Confluence

### Live page restriction change

1. Confirm Bob's Atlassian link and establish the open-page baseline:

   ```bash
   npm run seed:confluence -- --unrestrict-drill
   npm run confluence:poll -- --sweep
   ```

2. As **Bob**, select Confluence and ask **How long did the last failover drill take?** Expect **6 minutes 40 seconds**, citing **Checkout failover drill results**. Search for that page title if testing only permissions.
3. Restrict the page:

   ```bash
   npm run seed:confluence -- --restrict-drill
   ```

4. **Without polling or sweeping**, repeat Bob's query. The drill page must not be returned. Expect a live-recheck drop when its old indexed candidate is still eligible. Alice and Carol should retain access; the seeded restriction also preserves crawler access.
5. Write the separate permission-change record:

   ```bash
   npm run confluence:poll -- --sweep
   ```

6. Clear Person and filter **Document = Checkout failover drill results**, **Kind = Permission changes**. Expect old/new access restrictions, unknown source change time and a detection time. The change can be expressed as “now restricted to” rather than an explicit “Bob lost” label.

**Restore:**

```bash
npm run seed:confluence -- --unrestrict-drill
npm run confluence:poll -- --sweep
```

Confirm a restriction-removal record and Bob's answer of 6 minutes 40 seconds again. A normal content poll alone is not a reliable reset for a restriction-only change.

### Content freshness

1. Establish the original rollout content:

   ```bash
   npm run seed:confluence -- --restore-rollout
   npm run confluence:poll
   ```

2. As Bob, select Confluence and ask **How often are signing keys rotated?** Expect the interval to be undecided in **Auth service tokens: rollout plan**.
3. Apply the content edit and poll:

   ```bash
   npm run seed:confluence -- --edit-rollout
   npm run confluence:poll
   ```

4. Repeat the question. Expect **every 24 hours with a 1-hour overlap**.
5. Filter **Document = Auth service tokens**, **Kind = Content changes**. Expect an updated record with source version time, detection time and indexed time. If Confluence's search has not surfaced the edit yet, retry the poll after it becomes visible.

**Restore:**

```bash
npm run seed:confluence -- --restore-rollout
npm run confluence:poll
```

Confirm the original answer and restoration content record.

## Account and admin audit tests

### Account connections

Use a test account and note its initial connections.

| Action | Expected audit record | Restore |
| --- | --- | --- |
| Disconnect and reconnect Slack through Connections | Account disconnect and connect, actor is the person; reconnect can also produce a DM backfill summary | Reconnect as the same Slack person and confirm access. Disconnect removes eligible indexed DMs until reconnection reimports them |
| Disconnect and reconnect Atlassian through Connections | Account disconnect and connect with source `atlassian`; this single link serves Jira and Confluence | Reconnect using the same person's Atlassian account; allow Confluence's identity cache to refresh or restart, then confirm both sources work |
| Reconnect Google Drive through the admin controls on `/drive.html` | Account connect for Drive | Reconnect the same configured admin account and confirm Drive works; this is a shared connection, not a per-person link |

Use **Kind = Account links** to inspect the records. Browser **Sign out** is not the Slack Disconnect action. No poll is required to create the account records.

### Admin actions and chain verification

1. Open the main Audit tab and Apply a filter. Clear filters and reload; expect an admin **audit log viewed** record. The request logs itself after querying, so that action appears on a later reload.
2. Click **Verify chain**. Expect chain intact. Reload and find the admin verify record.
3. On `/drive.html`, press **Sync now**. Expect an admin sync-now record. It may identify the signed-in person or anonymous rather than `admin`.
4. Run `npm run audit:log -- --kind admin` and `npm run audit:verify`. Confirm CLI admin actions are also recorded. Successful verification checks the chain and retained checkpoint before attempting its own best-effort audit action, so the head normally advances afterward. Failed verification writes nothing.
5. If testing the `/drive.html` audit view, expect only access records there. Use the main page for permission, content, account and admin records.

### How the audit trail detects tampering

Each record is sealed with an HMAC and linked to the previous record's hash. Verification detects edits, reordering and missing records within the chain. A durable checkpoint outside Elasticsearch remembers the latest committed sequence number and hash, so deletion of the newest records or the whole stored log is also detected while the checkpoint remains protected. For example, a checkpoint remembering record #100 exposes a log truncated to #90 even though those first 90 records still form a valid chain.

If integrity checks fail, verification reports the problem and further audit appends are blocked; it does not replace the checkpoint or silently accept the shortened history. The checkpoint advances with successful appends after its one-time initialization. This protects against tampering in Elasticsearch, not coordinated compromise of the app host and checkpoint, and does not prove every source event was captured.

For the judge walkthrough, show an existing query's document decisions and answer, then click **Verify chain** and explain the retained checkpoint. The demonstration does not require changing or deleting audit records. See [audit architecture](../reference/architecture.md#shared-audit-chain) for implementation details and [audit commands](../reference/commands.md#run-and-check) for initialization.

## Filters and review regressions

1. Generate a Search and an Ask, then verify actor, source, query, mode, decisions and citations in their audit rows.
2. Try Person, Document, Kind and From/To dates independently, then together. Use **Reset** to clear the filters; this does not clear history.
3. Leave Person empty when investigating system permission/content changes. Use the document filter to see those changes alongside people's searches.
4. Exercise the document/decision regression: find a search with document A withheld and document B shown. Filter Document to A's title and Decision to **Something was shown**. The record must be excluded. Switch to **Withheld** and confirm it appears; filtering B with **Something was shown** must also include it. Repeat using an item ID. Title/ID and decision must belong to the same document entry.
5. Verify the chain again after restoring all test data. Retained older records must still verify with the original audit key after explicit checkpoint initialization.

## Final restoration checklist

Run only the resets for scenarios you exercised:

```bash
# Drive shares and runbook
npm run seed:drive -- --reset
npm run drive:poll

# Jira: first restore Approvers, description and any status manually
npm run jira:poll

# Confluence page restrictions and rollout content
npm run seed:confluence -- --unrestrict-drill
npm run seed:confluence -- --restore-rollout
npm run confluence:poll
npm run confluence:poll -- --sweep

# Audit history must still verify
npm run audit:verify
```

- Restore Slack membership and channel names, delete the test message, and archive any disposable privacy-test channel.
- Restore any disconnected accounts to their initial state.
- Confirm Dave can retrieve the Drive postmortem, Bob can retrieve Jira VEND-5, and Bob can retrieve the Confluence drill result.
- Confirm the original runbook and signing-key rollout answers are restored.
- Stop temporary watchers and restart the server with its normal sync settings.
- Keep the audit index, `.secrets/audit-key` and `.secrets/audit-checkpoint.json` (or their configured paths). Restoration should add reversal records, not erase test history.

Record the run's date, tester, pass/fail per scenario and relevant audit sequence numbers. A passing chain check proves the stored chain is intact; it does not prove that every expected event was captured, so check both.

## Related documentation

- [Judge demo script](script.md)
- [Shared architecture and audit chain](../reference/architecture.md)
- [Slack connector](../reference/connectors/slack.md)
- [Drive connector](../reference/connectors/drive.md)
- [Jira connector](../reference/connectors/jira.md)
- [Confluence connector](../reference/connectors/confluence.md)
- [Command reference](../reference/commands.md)
