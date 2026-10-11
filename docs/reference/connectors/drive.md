# Google Drive connector

**Status: implemented.** [Setup](../../setup/drive.md) · [Tests](../../demo/audit-test-plan.md#google-drive)

## Permission structure

The crawler reads files under one configured folder in an admin account's My Drive. Sharing can grant access to users, groups, a domain or anyone; file metadata includes inherited sharing. Reader, commenter, writer and owner roles all allow reading.

The app indexes user/group grants and discoverable domain/public grants. A link-only share is deliberately not treated as permission to discover a file through search.

## How access is enforced

Indexed files carry `drive:user:`, `drive:group:`, `drive:domain:` and `drive:anyone` labels. The asker's keys come from their email, eligible domain and public access. Google Group membership is not expanded, so group-only access can be missing from results.

Before returning a candidate, the connector fetches its current metadata using the **crawler's token**, compares fresh sharing labels against the asker's keys, and drops files that fail. This is a fresh sharing check, not a request made with the asker's Google token. Errors, deleted files and trashed files are withheld. Changed labels also trigger an asynchronous index relabel and permission audit write.

## Updates and design decisions

| Change | Mechanism | Why |
| --- | --- | --- |
| Files added, moved, renamed, deleted or shared differently | Changes-feed poll, default 60 seconds | A persisted feed cursor catches changes since the last successful run |
| Content edited | Feed poll, then wait for 120 seconds without edits | Avoid repeated extraction/embedding while Docs autosaves |
| Sharing changed during edits | Apply labels without waiting for content | Access removal should not wait for the content debounce |
| Missed changes or stale folder state | Full reconcile, default 60 minutes | Compare current source contents with stored state |
| Stale sharing found during search | Live metadata check and background relabel | Block the result immediately and help the index catch up |

`npm run drive:poll` is a one-off forced run that skips the edit wait. `--watch` follows the quiet period. `npm run drive:backfill` performs a full import/reconcile. Server jobs require `DRIVE_SYNC=on`.

## Audit records and timing

- Poll/reconcile writes permission records with before/after labels, plus content added/updated/deleted records. A first/reset import writes an import summary.
- Content change time uses file modification time. A content hash avoids treating a sharing-only modified-time bump as a content edit.
- Poll-detected sharing changes and removals use the available change-feed time. Several changes can be collapsed into the latest entry per file, so it is not a complete history of each sharing operation.
- Live-recheck/reconcile sharing changes have unknown source change time. The live-recheck permission record is asynchronous and can appear after the search finishes.
- Drive connection through the web UI writes an account record. Sync now writes an admin record. There is no implemented per-person Drive link/unlink flow.

The [shared chain](../architecture.md#shared-audit-chain) also contains each search's allowed, withheld and dropped decisions. A later poll need not duplicate a permission change already recorded by live recheck.

## Limitations

- Email/domain identity and the supported sharing model are demo assumptions, not a full Workspace authorization engine.
- Group-only access, link-only discoverability and unsupported source rules can hide readable files.
- Changed source content may not be indexed until the quiet period ends; current access checking does not refresh every content body.
- Newly granted access can require a poll because the old index filter may never produce that file as a candidate.
- Who changed sharing is not captured; the change record's actor is `system`.

Implementation: `src/connectors/drive/{acl,query,sync,client,store,tree}.ts`.
