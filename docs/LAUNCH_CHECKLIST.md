# Launch checklist

This checklist is intentionally unfinished for a managed team service. A source/self-hosted alpha or synthetic static demo may be published with these limitations explicit. A checkbox is evidence-backed only when the named test has been run against the intended deployment; local PGlite/browser evidence below is not native-production proof. See [static demo publication](STATIC_DEMO.md) for its narrower checks.

## Observed local evidence (not launch approval)

- [x] `tests/auth-wire.test.ts` exercises Better Auth through the `pg` driver and PGliteSocket.
- [x] `tests/e2e/team.spec.ts` exercises browser signup, workspace creation, XLSX upload/import/edit/download, and workspace portability actions against an isolated synthetic database.
- [x] `tests/fullstack.test.ts` exercises a synthetic sample API round-trip.
- [x] Administration and source-queue tests cover owner authorization, last-owner protection, data/account deletion boundaries, retries/recovery records, revisions, and mocked source behavior.
- [x] Account-erasure interleaving guards, single-connection Google credential/transaction flow, and authenticated download failure/retry have local regression coverage.
- [x] A private native PostgreSQL 16.15 smoke run covered migration, Better Auth, synthetic XLSX import/edit/export, and `pg_dump`/`pg_restore` into a separate database.
- [ ] Docker/Compose startup, image behavior, production failure recovery, and a deployment backup/restore rehearsal have been run.

## Product and hosting

- [ ] Decide and record the deployment owner, public URL, support channel, retention policy, and data region.
- [ ] Serve the built web assets behind HTTPS on one origin; proxy `/api` same-origin.
- [ ] Add/test production trusted origins without weakening CSRF checks.
- [ ] Keep PostgreSQL private; confirm the app fails closed when the database or auth secret is unavailable.
- [ ] Replace every placeholder secret; verify secrets are absent from images, logs, CI output, and backups stored in public locations.

## Auth and collaboration

- [ ] Test sign-up/sign-in/sign-out, session expiry, configured password-reset delivery, account deletion, and cookie behavior through the public HTTPS origin.
- [ ] Test owner/editor/viewer isolation, invitation binding to a verified email, rate limits, and concurrent revision conflicts.
- [ ] Decide whether mail delivery is required; test both `EMAIL_VERIFICATION_WEBHOOK_URL` and `PASSWORD_RESET_WEBHOOK_URL` with deployer-controlled endpoints. Confirm that reset stays unavailable, rather than claiming delivery, when its callback is absent or fails.

## Sources and file safety

- [ ] Run the supported-file matrix against redacted `.xlsx` fixtures, formulas, dates, appended rows, unsupported files, and export/reopen in the target Excel version.
- [ ] Test explicit upload/storage consent and retention/deletion handling.
- [ ] Complete Google OAuth consent/callback, narrow `drive.file` scope, Picker configuration (`GOOGLE_PICKER_DEVELOPER_KEY`/`GOOGLE_APP_ID`), import, refresh, writeback, post-write verification, and source-concurrency conflict tests.
- [ ] Exercise consented metadata identity, metadata-ID DataFilter writes, sorting during reads/writes, and guarded row creation against a permitted live Google sheet. Test same-cell conflicts and fail-closed metadata-enablement recovery before enabling Google writeback; mocked coverage is not enough.

## Operations

- [ ] Run `npm run check` and `npm run test:e2e` on the release commit; install every configured Playwright engine.
- [ ] Run Docker build/startup, migration, failure recovery, backup, restore, and deletion rehearsal in the intended deployment. Native PostgreSQL 16.15 local smoke evidence does not close this Docker/operations gate.
- [ ] Establish monitored `pg_dump` backups and perform a documented restore.
- [ ] Verify owner-only member changes, archive export, restore-as-new-workspace, exact-name workspace/dataset deletion, account-erasure ownership transfer, archive limits, and disconnected restored Google sources in the target deployment.
- [ ] Verify revision metadata/download retention. Portable workspace JSON intentionally lacks every historical revision/source-upload reference; full database backup must be the recovery path for that history.
- [ ] Run a real three-team pilot using consented, non-sensitive data; record findings and rollback decisions.
- [ ] Do not announce or open a managed team service accepting real user data until every unchecked release gate is closed with evidence.
