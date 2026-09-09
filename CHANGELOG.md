# Changelog

This changelog records local alpha evidence. It is not an announcement of a
hosted service or production readiness.

## 0.1.0-alpha.2 — 2026-09-09 (local candidate)

### File-first renewal (same alpha line)

- Default browser-local CSV/XLSX workbench with preview-before-apply cleanup,
  append, previous/current comparison, reference lookup and summaries.
- Original-source tracking, guarded exports, undo/redo and reusable recipes
  with explicit next-file mapping. Incompatible or ambiguous matches stop.
- Optional browser saving with stale-tab protection; no automatic file upload.
- English/Korean starter guidance and optional calendar, board and report views
  derived from the same confirmed result table. Existing team mode is retained.
- Papa Parse CSV parser integrated with its MIT notice. No competitor source
  code other than declared dependencies is incorporated.
- Real-user repeat use, native Excel reopening and live Google integration are
  still unverified. This renewal does not establish market or time-saving claims.

### Implemented and locally tested

- Owner member-role changes/removal with last-owner protection; exact-name
  local dataset deletion; and account erasure using Better Auth's current
  password or fresh-session protection. Shared-team content follows the
  documented retention/anonymization boundary.
- An optional deployer-operated password-reset callback. Reset is explicitly
  unavailable when the callback is absent; the application does not send mail
  itself.
- Persisted source jobs with retry/recovery records and revoked-member checks,
  exercised against mocked remote behavior.
- Dataset revision snapshots, revision metadata, and saved JSON/XLSX working-copy
  downloads. Portable workspace JSON intentionally does not include every
  historical revision; complete database backups do.
- Consented metadata identities, metadata-ID DataFilter writes/readbacks,
  same-snapshot value/row identities, and guarded new-row creation in the
  Google adapter, covered only with mocked remote behavior. Column-ID-only
  writes are disabled until metadata is explicitly previewed and consented to.
- An actual local signup/XLSX team trial via `npm run demo:team` and clearer
  English/Korean sample-file/download instructions.
- Visible download/copy progress and error recovery, including authenticated
  historical XLSX downloads and duplicate-click protection.
- Operation-local Google credentials resolved before database transactions,
  with a real one-connection `pg` pool regression using mocked Google responses.
- Durable account-erasure/write guards and atomic, single-use OAuth state
  consumption; no extra Google profile scope or unused UserInfo request.

### Local evidence

- Private native PostgreSQL 16.15 smoke: migration, Better Auth,
  synthetic XLSX import/edit/export, and `pg_dump`/`pg_restore` into a separate
  synthetic database. See [native validation](docs/NATIVE_VALIDATION.md).
- Local PGlite/PGliteSocket, browser, and mocked-source tests. Browser evidence
  is synthetic and does not exercise a live Google account.
- Build/type checking, 104 unit/integration tests and 28 Chromium/WebKit
  checks passed. Dependency audit reported no vulnerabilities at validation.

### Still unverified or incomplete for release

- Docker/Compose and public HTTPS deployment, real mail delivery, native
  desktop Excel reopening, monitoring/retention operations, and the three-team
  pilot.
- Live Google OAuth, Picker, import/refresh/writeback and source concurrency.
  Google Values APIs have no same-cell CAS, and a metadata-enablement race
  may need manual marker repair. Do not describe Google as live-verified.

## 0.1.0-alpha.1 — 2026-09-08

Initial standalone local alpha: shared views, synthetic demo, guarded XLSX
adapter, authenticated workspaces and source scaffolding. The original
local source archive and Git bundle are preserved separately.
