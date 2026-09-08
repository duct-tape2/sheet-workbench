# Three-team pilot protocol

This is a proposed protocol, not evidence that a pilot has happened. The pilot must use consented, non-sensitive workbooks and a deployment that already passed the launch checklist's hosting and backup gates.

## Before inviting teams

- Choose three teams with different spreadsheet shapes and a named owner for each.
- Write the public URL, data-retention rule, support contact, rollback point, and stop conditions.
- Create a fresh database backup and a synthetic rehearsal workspace.
- Verify HTTPS same-origin routing, sign-in, invitation verification, role isolation, logs, rate limits, and restore access.
- For Google teams, use only sheets the team explicitly permits and record the selected bounded range and identity field.

## Runbook

1. Team 1 starts with a redacted `.xlsx` and checks mapping, dates, formulas, export, and reopen in Excel.
2. Team 2 tests owner/editor/viewer roles, invitation acceptance, simultaneous edits, undo, browser reconnect, and report parity.
3. Team 3 tests the Google path only after OAuth/Picker gates pass: inspect, bounded import, refresh, one permitted edit, source conflict, and confirmed post-write value.
4. Each team records task time, confusing copy, rejected files, conflict recovery, support questions, and whether the original source stayed intact.
5. Operators rehearse backup, restore, and complete deletion using a copied environment after the user-facing tasks finish.

## Stop conditions

Stop the pilot and preserve evidence if any of these occurs:

- A viewer can write, a request succeeds without auth/database, or a failed/uncertain source write is reported as saved.
- A source row or formula is guessed, overwritten, or cannot be reconciled.
- An upload leaves the declared workspace, consent is bypassed, or a secret appears in logs.
- Restore cannot recover the expected workspace state, or deletion scope is uncertain.
- A live Google test needs a public sheet, shared credential, or a permission workaround.

## Exit evidence

Publish an internal pilot report containing environment commit, team/task matrix, redacted logs, defects, backup/restore result, unresolved gates, and a go/no-go decision. Do not claim "three-team pilot complete" without that report.
