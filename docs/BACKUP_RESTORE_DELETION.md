# Backup, restore, and deletion

This runbook has two separate paths: an owner-scoped portable workspace archive, and an operator-controlled PostgreSQL backup. The portable archive is useful for moving one workspace; it is not a full database disaster-recovery backup.

## Portable workspace archive

Authenticated workspace owners can use the **Backup and restore** panel. The corresponding routes are:

- `GET /api/workspaces/:wid/export` — owner-only archive export.
- `POST /api/workspaces/restore` — restore a validated archive as a new workspace for the signed-in user.
- `DELETE /api/workspaces/:wid` — owner-only workspace deletion after the exact workspace name is supplied.

The archive contains the workspace name, current dataset snapshots, validated change history, and original XLSX uploads for which storage consent was given. It does **not** contain authentication rows, workspace members, invitations, Google credentials, Google tokens, or every historical `dataset_versions` snapshot/source-upload reference. The current limits are 25 MiB total uploaded workbook bytes and a 40 MiB restore request body. Keep the downloaded JSON private.

Restore never overwrites the source workspace. It validates the archive and re-inspects each XLSX, assigns new workspace/upload/dataset identities, and creates the signed-in user as the new owner. A restored Google dataset is deliberately disconnected and read-only; reconnect it only after the live Google gates have been verified. Restore is not a way to restore accounts, membership, or Google access.

Workspace deletion is destructive. The owner must download an archive first and type the exact workspace name. The server deletes the workspace and its workspace-scoped records through the database relationship; it does not delete Google-side files or previously downloaded Excel files.

Owners can also delete one local dataset through `DELETE /api/workspaces/:wid/datasets/:did` only after entering its exact dataset name. The server never calls Google for that operation. An XLSX source upload is removed only if no current dataset or stored version references it. Account deletion is available at `POST /api/account/delete`: it requires exact account name/email confirmation and Better Auth's current-password or fresh-session check. A sole workspace owner must transfer ownership first. For shared workspaces, the retention policy keeps team dataset content while removing the account's membership, queued source jobs, credential linkage, and identifying attribution; affected Google sources are disconnected and read-only. User-facing deletion does not remove operator backups, logs, or mail-provider records.

The repository's local PGliteSocket/browser and API evidence exercises these contracts. A separate private native PostgreSQL 16.15 smoke run covered synthetic auth, import/export, and custom-format dump/restore into a separate database. Docker and a production backup/restore rehearsal remain unverified release gates.

Account cleanup serializes with application writes and keeps a pending-erasure marker until the authentication account is deleted. A page opened earlier cannot submit new changes after cleanup begins. If authentication deletion fails after cleanup, the account remains blocked from new writes; retry account deletion after the underlying failure is resolved. Do not remove the marker to resume editing a partially erased account. A sole-owner rejection rolls the cleanup and marker back together.

## PostgreSQL backup

For a real deployment, run from an operator host with access to the same `DATABASE_URL`, while following the deployment's consistency window:

```sh
pg_dump --format=custom --file=sheet-workbench-$(date +%Y%m%d-%H%M%S).dump "$DATABASE_URL"
```

Protect the dump like production data. It can contain authentication rows, uploaded workbook bytes, workspace membership, and encrypted Google credential records. Store it outside the public web root, restrict access, record retention, and test checksum/restore access. The repository does not automate this schedule.

For the Compose trial, stop writes before backing up. The named volume is not itself a portable, tested backup. Prefer a logical `pg_dump` from a running, healthy PostgreSQL service.

## PostgreSQL restore

Restore into a separate or intentionally replaced database only after verifying the target and backup:

```sh
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" sheet-workbench-YYYYMMDD-HHMMSS.dump
```

Stop the app or otherwise prevent concurrent writes during replacement. Start the app again; its schema bootstrap is idempotent, but migrations and restore compatibility must be tested against the exact commit. Verify sign-in, workspace membership, dataset revision/history, uploads, export, and Google setup state before reopening access.

The commands above are operator examples, not a production restore certification. A private native PostgreSQL 16.15 smoke run did exercise this form of dump/restore with synthetic data; it did not validate the intended deployment's access, retention, recovery timing, or Docker environment. Never run them against an unconfirmed database.

## Complete deployment deletion

For a full self-hosted data deletion:

1. Announce downtime and confirm the exact deployment, database, and volume.
2. Take and retain the final backup if policy requires it.
3. Stop the app: `docker compose down`.
4. Remove the exact named database volume only after confirming the project and volume: `docker compose down -v` (destructive), or use an explicitly identified volume through the operator's platform.
5. Confirm that backups, object storage, logs, mail webhook records, and Google-side access/tokens are handled under the deployment's retention policy.

`docker compose down` alone does **not** delete `postgres_data`. `docker compose down -v` is irreversible for that local volume. Workspace, dataset, and account deletion are narrower than complete deployment deletion and do not remove retained operator backups, logs, or external mail-provider records.
