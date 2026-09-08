# Backup, restore, and deletion

This runbook has two separate paths: an owner-scoped portable workspace archive, and an operator-controlled PostgreSQL backup. The portable archive is useful for moving one workspace; it is not a full database disaster-recovery backup.

## Portable workspace archive

Authenticated workspace owners can use the **Backup and restore** panel. The corresponding routes are:

- `GET /api/workspaces/:wid/export` — owner-only archive export.
- `POST /api/workspaces/restore` — restore a validated archive as a new workspace for the signed-in user.
- `DELETE /api/workspaces/:wid` — owner-only workspace deletion after the exact workspace name is supplied.

The archive contains the workspace name, dataset snapshots, validated change history, and original XLSX uploads for which storage consent was given. It does **not** contain authentication rows, workspace members, invitations, Google credentials, or Google tokens. The current limits are 25 MiB total uploaded workbook bytes and a 40 MiB restore request body. Keep the downloaded JSON private.

Restore never overwrites the source workspace. It validates the archive and re-inspects each XLSX, assigns new workspace/upload/dataset identities, and creates the signed-in user as the new owner. A restored Google dataset is deliberately disconnected and read-only; reconnect it only after the live Google gates have been verified. Restore is not a way to restore accounts, membership, or Google access.

Workspace deletion is destructive. The owner must download an archive first and type the exact workspace name. The server deletes the workspace and its workspace-scoped records through the database relationship; it does not delete Google-side files or previously downloaded Excel files. There is no supported dataset-delete or account-delete route.

The repository's local PGliteSocket/browser and API evidence exercises this contract, but native PostgreSQL, Docker, and a production backup/restore rehearsal remain unverified release gates.

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

The commands above are operator examples, not evidence that native PostgreSQL restore was tested here. Never run them against an unconfirmed database.

## Complete deployment deletion

For a full self-hosted data deletion:

1. Announce downtime and confirm the exact deployment, database, and volume.
2. Take and retain the final backup if policy requires it.
3. Stop the app: `docker compose down`.
4. Remove the exact named database volume only after confirming the project and volume: `docker compose down -v` (destructive), or use an explicitly identified volume through the operator's platform.
5. Confirm that backups, object storage, logs, mail webhook records, and Google-side access/tokens are handled under the deployment's retention policy.

`docker compose down` alone does **not** delete `postgres_data`. `docker compose down -v` is irreversible for that local volume. The UI/API workspace deletion above is narrower than complete deployment deletion and does not provide account deletion.
