# Integration notes and open gates

This file keeps documentation aligned with the current source. It records what local evidence covers and what still needs an intended deployment; it is not a substitute for the implementation contract.

## Google contract

- The current Picker environment variables are `GOOGLE_PICKER_DEVELOPER_KEY` and `GOOGLE_APP_ID`. Do not substitute an undocumented alternate variable name.
- The configured OAuth scope is `https://www.googleapis.com/auth/drive.file`. The server does not request broad spreadsheet access.
- Live OAuth consent/callback, Picker selection, import, refresh, writeback, post-write verification, and source-concurrency behavior have not been run against Google.
- Writes and readbacks target exact metadata IDs with DataFilters, not physical A1 row locations. Imported cells and row metadata come from the same snapshot. Column-ID-only sources are read-only until hidden metadata is previewed and explicitly consented to; new external rows require reviewed re-consent. These paths are covered by synthetic mocked tests, not live Google evidence.
- DataFilters protect row identity through sorting; they do not provide same-cell compare-and-swap. A concurrent edit between preimage check and write can still conflict. Metadata-enablement races fail closed and may leave markers requiring explicit review; the app does not silently delete uncertain markers. Atomic new-row insertion includes an operation marker for lost-response recovery. Validate all of these cases against a permitted test sheet before offering Google writeback to users.

## Deployment gaps

- `apps/server/src/index.ts` now serves the built `dist/web` shell and fingerprinted assets alongside `/api`; the shell is sent with `no-store` while fingerprinted assets may be immutable. Verify this behavior in the release image and through the HTTPS proxy.
- Trusted origins default to the configured `BETTER_AUTH_URL` origin, or use explicit comma-separated `TRUSTED_ORIGINS`. Paths and wildcards are rejected; public production origins require HTTPS. Local configuration tests exist; HTTPS reverse-proxy verification remains a release gate.
- Workspace archive export and exact-name deletion require owner permission. An authenticated archive holder can restore into a new workspace they own. Archives exclude members/auth rows/Google credentials and tokens, as well as every historical version snapshot; restored Google datasets are disconnected and read-only. Owners can manage existing members and delete a local dataset by exact name. Account deletion needs exact account confirmation plus Better Auth's current-password or fresh-session check; sole owners must transfer ownership, while shared team content is retained under the documented anonymization policy.
- A private native PostgreSQL 16.15 smoke run exercised `pg_dump`/`pg_restore` with synthetic auth/import/export data. Native Docker startup, production HTTPS proxy behavior, real mail delivery, hosted monitoring, and a deployment restore rehearsal remain unverified here.

## Evidence boundaries

Local evidence includes Better Auth through the PGliteSocket/`pg` boundary, the real browser team flow (signup, workspace creation, XLSX upload/import/edit/download), a synthetic sample API round-trip, and a separate native PostgreSQL 16.15 smoke run. These checks do not substitute for a production deployment, a real Google account/source, real mail delivery, or a three-team pilot.

Only call a release gate complete after running it against the intended environment. Keep public docs explicit about alpha status, synthetic demo data, unverified Docker/production operations, the live-Google validation gate, unverified mail delivery, and the unlaunched three-team pilot.
