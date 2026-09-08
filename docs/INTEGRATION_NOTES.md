# Integration notes and open gates

This file keeps documentation aligned with the current source. It records what local evidence covers and what still needs an intended deployment; it is not a substitute for the implementation contract.

## Google contract

- The current Picker environment variables are `GOOGLE_PICKER_DEVELOPER_KEY` and `GOOGLE_APP_ID`. Do not substitute an undocumented alternate variable name.
- The configured OAuth scope is `https://www.googleapis.com/auth/drive.file`. The server does not request broad spreadsheet access.
- Live OAuth consent/callback, Picker selection, import, refresh, writeback, post-write verification, and source-concurrency behavior have not been run against Google.
- Sources without a stable row identity remain read-only. Row append is unsupported, and the planned metadata fallback for an ID-less source is not implemented. Do not make a source public to work around these gates.

## Deployment gaps

- `apps/server/src/index.ts` now serves the built `dist/web` shell and fingerprinted assets alongside `/api`; the shell is sent with `no-store` while fingerprinted assets may be immutable. Verify this behavior in the release image and through the HTTPS proxy.
- Trusted origins default to the configured `BETTER_AUTH_URL` origin, or use explicit comma-separated `TRUSTED_ORIGINS`. Paths and wildcards are rejected; public production origins require HTTPS. Local configuration tests exist; HTTPS reverse-proxy verification remains a release gate.
- Workspace archive export and exact-name deletion require owner permission. An authenticated archive holder can restore into a new workspace they own. Archives exclude members/auth rows/Google credentials and tokens; restored Google datasets are disconnected and read-only. Dataset-delete and account-delete routes are not implemented.
- PostgreSQL `pg_dump`/`pg_restore`, native Docker startup, production HTTPS proxy behavior, mail delivery, and hosted monitoring remain unverified here.

## Evidence boundaries

Local evidence includes Better Auth through the PGliteSocket/`pg` boundary, the real browser team flow (signup, workspace creation, XLSX upload/import/edit/download), and a synthetic sample API round-trip. These checks do not substitute for native PostgreSQL, a real Google account/source, or a three-team pilot.

Only call a release gate complete after running it against the intended environment. Keep public docs explicit about alpha status, synthetic demo data, unverified Docker/PostgreSQL, unverified live Google behavior, and the unlaunched three-team pilot.
