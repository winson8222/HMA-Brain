# Gmail setup status

## 1 Prerequisites

Gmail is not implemented in this repository. This page preserves the common setup structure while making the missing capability explicit. Use the [proposed connector design](../reference/connectors/gmail.md) for planning.

## 2 Create accounts and source access

No accounts need to be provisioned for the current demo. A future implementation would use dedicated mailboxes with explicit per-person consent.

## 3 Configure credentials and settings

There are no supported Gmail environment variables, token files or callbacks here. A future connector needs Gmail API enablement, an OAuth client and the appropriate read scope before credentials can be configured.

## 4 Link people

There is no Connect Gmail button. Drive authorization and Atlassian linking do not connect a Gmail mailbox.

## 5 Import data and enable updates

There are no Gmail seed, backfill, polling or event commands. The proposed history/push design is not running.

## 6 Verify and test

Exclude Gmail from current demo acceptance claims. Implementation needs mailbox-isolation, revocation, deletion and recovery tests before it can join the demo.

## 7 Troubleshoot and restore

No Gmail data is modified by this repo, so there is no Gmail reset procedure. Use [Slack](slack.md), [Drive](drive.md), [Jira](jira.md) and [Confluence](confluence.md) for working sources.
