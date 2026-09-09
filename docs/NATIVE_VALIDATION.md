# Native PostgreSQL smoke evidence

Observed on Windows, 2026-09-08. Synthetic local data only; this is not a Docker or public-hosting result.

`scripts/native-smoke.ts` passed against native PostgreSQL 16.15:

```text
NATIVE_PG_SMOKE_OK migration auth workspace dataset backup restore
```

The run created an isolated SCRAM-authenticated cluster on `127.0.0.1:55432`, migrated the schema, signed up through Better Auth, imported/edited/exported `samples/team.xlsx`, and used `pg_dump --format=custom` plus `pg_restore` to restore into a separate test database. Restored auth, workspace, dataset, upload and history rows were checked. The script stopped the cluster and removed its generated test data and credentials afterward; the portable runtime was retained.

## Reproduce on Windows

This optional check is not part of `npm test` and does not install PostgreSQL automatically. Obtain a trusted Windows binary distribution yourself, then place its `pgsql` directory at `.local/native-pg/pgsql`. Required executables include `initdb.exe`, `postgres.exe`, `pg_ctl.exe`, `psql.exe`, `pg_dump.exe` and `pg_restore.exe`.

```sh
npm run test:native
```

Port 55432 must be free. The script does not connect to an existing database or install a service. For a Unicode workspace path it creates a randomized temporary ASCII-named Windows junction to the resolved `.local/native-pg` directory and removes only that junction at the end. If the system temporary directory itself contains non-ASCII characters, set `SHEET_WORKBENCH_ASCII_TEMP` to an existing ASCII-named temporary directory you control. No global PATH or firewall change is required.

## Runtime provenance and limits

The test used EDB's PostgreSQL 16.15 Windows x64 binary ZIP, obtained over HTTPS from its distribution endpoint. Local SHA-256:

```text
25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e
```

This is an artifact-identification hash, not an upstream checksum comparison: the inspected download page provided no checksum, and the extracted executable did not carry a verifiable Authenticode signature. The binary archive is not included in this repository.

The result does not verify Compose images/networking, production HTTPS, live Google credentials, mail delivery, desktop Excel reopening, or a production disaster-recovery procedure. Run those checks in the intended deployment before launching a hosted team service.
