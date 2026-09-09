# Local alpha validation — 2026-09-09

This is a runnable alpha, not a completed public service. All test records, samples and screenshots are synthetic. No existing company website, spreadsheet, account or ownership was changed.

## Reproduce the local evidence

File-first renewal checks on 2026-09-09: build/typecheck and 137 unit/integration tests passed; 40 existing normal browser checks, 18 personal-mode Chromium/WebKit checks and 2 legacy static-demo checks passed. Personal tests cover local CSV review/apply/export without external requests, 320px Korean layout, append/compare/reference roles, duplicate-key blocking, explicit renamed/larger-file recipe replay, opt-in device loading, and paste guards in transformed views. These are synthetic automated checks, not measured customer demand or real desktop Excel compatibility.

Use Node.js 22.12+ and npm from this repository's root. No real company file or Google account is needed.

```sh
npm ci
npx playwright install chromium webkit
npm run check
npm run test:e2e
npm run test:e2e:static-demo
npm run test:e2e:local
npm audit
```

The browser suite starts its own local test services. Stop another process using its required port if Playwright reports a port collision. It creates and removes isolated synthetic databases; it does not use a production database.

| Check                       | Observed result                            | Scope                                                                                                |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| TypeScript + Vite           | Passed                                     | Production web bundle and project type checking                                                      |
| Unit/integration suite      | 112 tests, 19 files passed                 | Domain logic, auth, permissions, administration, queue/revisions, XLSX, mocked Google, portability, locale selection |
| Browser suite               | 40 tests passed                            | Chromium and WebKit; real browser interactions                                                       |
| Static demo suite           | 2 tests passed                             | Chromium and WebKit; actual project subpath, four-view edit, downloads, no API/Google requests         |
| Accessibility scans         | No violations in the configured axe checks | Table, calendar, board and report in both engines; not a complete manual accessibility certification |
| Dependency audit            | 0 reported vulnerabilities                 | Dependency database at the time of the check; not a security audit                                   |
| Synthetic browser recording | About 21 seconds                           | Actual local UI, not a simulated Google connection                                                   |

The integration database uses PGlite and PGliteSocket with the real `pg` driver. Better Auth is exercised rather than replaced with a pretend identity. A separate native PostgreSQL 16.15 smoke run covered migration, Better Auth sign-up/session, synthetic XLSX upload/import/edit/export, and custom-format `pg_dump`/`pg_restore` into a separate synthetic database; see [native validation](NATIVE_VALIDATION.md). It passed again on 2026-09-09. Neither result substitutes for Docker, a public HTTPS deployment, or production operations.

## Behaviors exercised

- Topbar language selection and the three-step bilingual usage guide are available at 320/375/414/768px. Explicit `?lang=ko` links, stored choice, English fallback and language switches are tested. Switching languages preserves the saved demo byte-for-byte; generated report headings follow the UI language without translating source cells. Fresh Korean samples work across all four views. Static demo help explicitly excludes sign-in, real file uploads and Google connectivity. These are local automated results, not a completed independent usability study.

- A confirmed edit appears in table, calendar, board and report; a second authenticated browser tab refreshes its report after the server event.
- Revisions reject stale edits. Invalid patches and unsafe undo requests are rejected before the mocked Google writer is called.
- Formula/source-ID cells remain read-only. Safe XLSX exports preserve untouched ZIP entries; supported sample files survive import/edit/export, while unsupported structures are rejected.
- A workspace backup is downloaded and restored into a separate workspace. Restored history can be undone. Deleting the restored workspace leaves the original intact.
- Owner-only member listing, role changes, and removal reject outsiders, viewers, revoked members, and concurrent last-owner changes. Exact-name local dataset deletion and account erasure are covered by server tests; account erasure requires Better Auth's current-password or fresh-session check and retains shared-team content under anonymized attribution.
- The persisted source queue covers FIFO processing, payload-bound operation IDs, retry/recovery records, and revoked-member rejection against mocked remote behavior. Dataset revisions retain snapshot metadata and original-upload references; JSON and historical XLSX working-copy downloads are API- and browser-tested.
- A real `pg.Pool` limited to one connection exercises expired OAuth refresh, metadata identity enablement, queued patch, and source refresh without nested-pool deadlock. Credentials are resolved before data transactions. Google responses are mocked; the pool test is not a live connection check.
- Account-erasure interleaving tests block already-authorized mutations between cleanup and the authentication provider's separate user deletion. The durable marker is cleared by deletion; a last-owner rejection rolls it back.
- Export, report and historical-file controls show pending/success/failure feedback. Tests cover duplicate-click prevention, a failed authenticated XLSX download followed by a successful retry, and clipboard-denied manual copying. Download initiation is explicitly distinguished from the browser saving a file to disk.
- Consented metadata row IDs, identity-safe sorting, and guarded new-row creation are adapter- and mocked-remote-tested. They are not evidence of a live Google source write.
- Navigation and detail-window buttons remain within tested widths of 320, 375, 390, 414, 768 and 1440 CSS pixels. Korean controls also pass a 320 × 260 effective-viewport stress test. The real XLSX/team flow is tested at 320px in WebKit.
- Google identity, source-header, preimage, formula and post-write checks use mocked remote responses. They are not evidence of live Google permission or concurrency behavior.

## Remaining limits and release work

1. **Live Google path:** metadata-ID DataFilter writes/readbacks and guarded row creation are tested with synthetic mocks. Cell values and row identities are read from one snapshot, and column-ID-only writes fail closed until metadata is consented to. Live OAuth, Picker, permission revocation and source concurrency remain unverified. Google has no same-cell CAS; a metadata-enablement race can fail closed and require explicit orphan-marker review. Do not enable a public Google writeback offering before these live checks.
2. **Source queue operation:** queue/retry/recovery behavior is locally tested with a mocked remote. It is not evidence that a running deployment can recover an actual Google outage, rate limit, or uncertain remote write.
3. **Delivery and scale:** password reset only becomes usable when a deployer configures and tests its own delivery callback; no real mail provider is configured here. SSE fanout is in-process, not a cross-process or horizontally scaled event system.
4. **Historical files and portability:** the UI lists the latest 100 dataset versions. Portable workspace JSON does not contain every historical revision snapshot or historical source-upload reference; a full database backup retains those records.

These limits and release gates must remain explicit in any public alpha description.

## External release gates

- A dedicated Google OAuth project, permitted synthetic test sheet, consent/Picker verification, revoked permissions, live writes and source-edit conflicts.
- Native PostgreSQL 16.15 has a private synthetic smoke result for migration, auth, import/export, and dump/restore. Docker startup, production failure recovery, and a deployment backup/restore rehearsal remain open.
- Reopening exported files in supported desktop Excel versions. ZIP/XML preservation tests do not prove every Excel feature is preserved.
- Public HTTPS, mail delivery, data region, retention, service quotas, monitoring and support ownership.
- Physical mobile/in-app browser and Windows scaling checks. Automated WebKit is not the KakaoTalk application.
- Three independent pilot teams, a measured first-use time and measured reporting-time savings.
- The baseline public source and static Pages demo at commit `22cd1ee` were published and their GitHub Actions completed successfully. This does not verify a hosted team backend or live Google connection. Later renewal changes require their own deployment checks.

See [the launch checklist](LAUNCH_CHECKLIST.md) for deployment gates and [the pilot protocol](PILOT_PROTOCOL.md) for the user study. Do not put actual company material into the public demo.
