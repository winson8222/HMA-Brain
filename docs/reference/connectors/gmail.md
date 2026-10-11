# Gmail connector proposal

**Status: not implemented.** There is no Gmail registry entry, index, OAuth callback, sync job, audit producer or CLI command in this repo. The following is a proposed design, not a demo capability. [Setup status](../../setup/gmail.md)

## Permission structure

Propose treating each connected mailbox as a separate private source. A message is available only through a mailbox the asker has explicitly connected. Do not infer access from To/CC headers, email-domain membership or a message copied into another person's mailbox. Shared mailboxes and delegation remain outside the initial scope.

## Proposed access enforcement

Use per-person Google OAuth with read-only mailbox access. `gmail.readonly` reads message content; Google's metadata scope does not read bodies. Google classifies the read-only scope as restricted, so an external deployment must meet the applicable verification requirements. [Google scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes)

Index messages under a verified mailbox identity and mailbox-specific message ID. Filter by that identity, then recheck candidate availability using its token. An expired/revoked connection should withhold results. Disconnect should disable access immediately and remove that mailbox's indexed data according to the chosen retention policy.

## Proposed updates and design decisions

Start with a full import and a stored history cursor. Poll `history.list` for changes; rebuild the mailbox snapshot if Google rejects an expired history cursor with HTTP 404. This supports incremental recovery without rescanning everything each time. [Google synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync)

For a later server deployment, use Gmail `watch` through Cloud Pub/Sub to trigger history reads, with periodic history polling as recovery. Notifications can be delayed or dropped. Watches expire and need renewal; Google recommends daily renewal. A notification is a prompt to read history, not the message contents. [Google push guide](https://developers.google.com/workspace/gmail/api/guides/push)

No polling interval is configured today. Decide mailbox scope, trash/spam treatment, attachment extraction, encrypted token storage and retention before implementation.

## Proposed audit records and timing

Record mailbox connect/disconnect, indexed message additions/changes/removals, and each query's access decisions in the shared chain. Keep message bodies out of change records. Treat mailbox metadata such as subject lines as sensitive too.

Record source change time only when the API supplies a time that actually represents that change. A message's sent date is not a deletion or permission-change time. Use detection time when source time is unknown.

## Limitations

These decisions have not been implemented or tested. Gmail should not appear in the judge's source list or test results. Use the four implemented platforms in the [demo script](../../demo/script.md).
