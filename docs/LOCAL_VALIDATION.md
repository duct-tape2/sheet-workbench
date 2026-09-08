# Local alpha validation — 2026-09-08

This is a runnable alpha, not a completed public service. All test records, samples and screenshots are synthetic. No existing company website, spreadsheet, account or ownership was changed.

## Reproduce the local evidence

Use Node.js 22.12+ and npm from this repository's root. No real company file or Google account is needed.

```sh
npm ci
npx playwright install chromium webkit
npm run check
npm run test:e2e
npm audit
```

The browser suite starts its own local test services. Stop another process using its required port if Playwright reports a port collision. It creates and removes isolated synthetic databases; it does not use a production database.

| Check                       | Observed result                            | Scope                                                                                                |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| TypeScript + Vite           | Passed                                     | Production web bundle and project type checking                                                      |
| Unit/integration suite      | 61 tests, 10 files passed                  | Domain logic, auth, permissions, XLSX, Google mocks, portability                                     |
| Browser suite               | 22 tests passed                            | Chromium and WebKit; real browser interactions                                                       |
| Accessibility scans         | No violations in the configured axe checks | Table, calendar, board and report in both engines; not a complete manual accessibility certification |
| Dependency audit            | 0 reported vulnerabilities                 | Dependency database at the time of the check; not a security audit                                   |
| Synthetic browser recording | About 21 seconds                           | Actual local UI, not a simulated Google connection                                                   |

The integration database uses PGlite and PGliteSocket with the real `pg` driver. Better Auth is exercised rather than replaced with a pretend identity. This does **not** substitute for testing native PostgreSQL, Docker or a public HTTPS deployment.

## Behaviors exercised

- A confirmed edit appears in table, calendar, board and report; a second authenticated browser tab refreshes its report after the server event.
- Revisions reject stale edits. Invalid patches and unsafe undo requests are rejected before the mocked Google writer is called.
- Formula/source-ID cells remain read-only. Safe XLSX exports preserve untouched ZIP entries; supported sample files survive import/edit/export, while unsupported structures are rejected.
- A workspace backup is downloaded and restored into a separate workspace. Restored history can be undone. Deleting the restored workspace leaves the original intact.
- Navigation and detail-window buttons remain within tested widths of 320, 375, 390, 414, 768 and 1440 CSS pixels. Korean controls also pass a 320 × 260 effective-viewport stress test. The real XLSX/team flow is tested at 320px in WebKit.
- Google identity, source-header, preimage, formula and post-write checks use mocked remote responses. They are not evidence of live Google permission or concurrency behavior.

## Remaining implementation — not just deployment settings

1. **Google new rows and ID-less editing:** row append and consented developer-metadata identity are not implemented. Existing stable-ID rows have guarded patch support; sources without a usable ID are read-only.
2. **Autonomous remote recovery:** the durable operation log records requests and guarded retries. It is not a background retry daemon. Active Google connections refresh every 60 seconds; a closed browser is not promised continuous polling.
3. **Complete administration:** invitations and roles exist, but changing/removing existing members has no management UI. Workspace archive/restore/delete exists; individual dataset/account deletion and full password-reset UX remain.
4. **Historical files and scale:** original files and change history are retained, but there is no full browser for every historical workbook version. SSE fanout is in-process, not a multi-server message bus.

These items must be implemented or deliberately removed from the public release scope before claiming the complete product plan is delivered.

## External release gates

- A dedicated Google OAuth project, permitted synthetic test sheet, consent/Picker verification, revoked permissions, live writes and source-edit conflicts.
- Native PostgreSQL/Docker startup, migrations, failure recovery and a real backup restore.
- Reopening exported files in supported desktop Excel versions. ZIP/XML preservation tests do not prove every Excel feature is preserved.
- Public HTTPS, mail delivery, data region, retention, service quotas, monitoring and support ownership.
- Physical mobile/in-app browser and Windows scaling checks. Automated WebKit is not the KakaoTalk application.
- Three independent pilot teams, a measured first-use time and measured reporting-time savings.
- Public repository creation, deployment and release approval. No public service has been launched by this local validation.

See [the launch checklist](LAUNCH_CHECKLIST.md) for deployment gates and [the pilot protocol](PILOT_PROTOCOL.md) for the user study. Do not put actual company material into the public demo.
