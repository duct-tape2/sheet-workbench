# Launch checklist

This checklist is intentionally unfinished for the alpha. A checkbox is evidence-backed only when the named test has been run against the intended deployment; local PGlite/browser evidence below is not native-production proof.

## Observed local evidence (not launch approval)

- [x] `tests/auth-wire.test.ts` exercises Better Auth through the `pg` driver and PGliteSocket.
- [x] `tests/e2e/team.spec.ts` exercises browser signup, workspace creation, XLSX upload/import/edit/download, and workspace portability actions against an isolated synthetic database.
- [x] `tests/fullstack.test.ts` exercises a synthetic sample API round-trip.
- [ ] Native PostgreSQL and Docker startup/migration/backup/restore/deletion have been run.

## Product and hosting

- [ ] Decide and record the deployment owner, public URL, support channel, retention policy, and data region.
- [ ] Serve the built web assets behind HTTPS on one origin; proxy `/api` same-origin.
- [ ] Add/test production trusted origins without weakening CSRF checks.
- [ ] Keep PostgreSQL private; confirm the app fails closed when the database or auth secret is unavailable.
- [ ] Replace every placeholder secret; verify secrets are absent from images, logs, CI output, and backups stored in public locations.

## Auth and collaboration

- [ ] Test sign-up/sign-in/sign-out, session expiry, password reset policy, and cookie behavior through the public HTTPS origin.
- [ ] Test owner/editor/viewer isolation, invitation binding to a verified email, rate limits, and concurrent revision conflicts.
- [ ] Decide whether mail delivery is required; test `EMAIL_VERIFICATION_WEBHOOK_URL` with a deployer-controlled endpoint.

## Sources and file safety

- [ ] Run the supported-file matrix against redacted `.xlsx` fixtures, formulas, dates, appended rows, unsupported files, and export/reopen in the target Excel version.
- [ ] Test explicit upload/storage consent and retention/deletion handling.
- [ ] Complete Google OAuth consent/callback, narrow `drive.file` scope, Picker configuration (`GOOGLE_PICKER_DEVELOPER_KEY`/`GOOGLE_APP_ID`), import, refresh, writeback, post-write verification, and source-concurrency conflict tests.
- [ ] Confirm that ID-less Google sources stay read-only; do not claim the unimplemented metadata fallback or row append.

## Operations

- [ ] Run `npm run check` and `npm run test:e2e` on the release commit; install every configured Playwright engine.
- [ ] Run Docker/native PostgreSQL build, startup, migration, backup, restore, and deletion rehearsal.
- [ ] Establish monitored `pg_dump` backups and perform a documented restore.
- [ ] Verify owner-only archive export, restore-as-new-workspace, exact-name workspace deletion, archive limits, and disconnected restored Google sources in the target deployment.
- [ ] Record that dataset-delete and account-delete routes are not available, or ship a reviewed replacement before launch.
- [ ] Run a real three-team pilot using consented, non-sensitive data; record findings and rollback decisions.
- [ ] Do not announce or open a public hosted service until every unchecked release gate is closed with evidence.
