# Audit trail, tamper detection and recovery

## How each part works today

| Part | How it works |
| --- | --- |
| Record searches and answers | Records the asker, question, selected sources and document access decisions. Answers also retain the generated response and citations. The audit write must succeed before the response is returned. |
| Record other activity | Supported content changes, permission changes, account connections/disconnections and admin actions are recorded in the same audit trail. |
| Track time | Each audit record has a timestamp. Change events also distinguish source-change time, when available, from the time the app detected or indexed the change. |
| Detect edited records | The app calculates an HMAC-SHA256 value from each record using a secret key kept outside Elasticsearch. Verification recalculates that value; changed contents produce a mismatch. Records also link to the previous hash, and a separate checkpoint remembers the latest trusted record to detect missing history. |
| Block writes after tampering | Before appending a record, the app verifies the stored history against the retained checkpoint. If verification fails, it blocks audit writes. Search and Ask also fail because their responses require a successful audit write. |

## Gaps

| Gap | Current limitation |
| --- | --- |
| Scaling | The full audit history is verified before every append. Time and memory use grow with the number of records, making the current approach better suited to demo-scale history. |
| Backup freshness | Each new record advances the checkpoint. Recovery requires a backup matching that latest trusted head; an older backup cannot restore later missing records. |
| Completeness | Some sync, account and admin audit writes are best effort and can fail. Connectors record supported events rather than every source-platform action. An intact chain proves stored records have not changed, not that every event was captured. |

## To be implemented: automatic backup files for recovery

The next improvement is to automatically create and retain verified backup files containing the original signed audit records. These files would be kept separately from Elasticsearch and used to restore damaged or deleted history. Backup capture must keep pace with the trusted checkpoint; periodic copies alone can leave later records unrecoverable.

Manual local backup-file creation and repair already exist in the code. Automatic backup creation, freshness monitoring and remote storage are not implemented.

Recovery uses a backup matching the retained checkpoint, preserves the damaged records as evidence, restores the original records and verifies them again. It does not reset the checkpoint or re-sign modified records to make them appear valid. Without a matching backup, detection alone cannot reconstruct missing history.
