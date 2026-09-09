# Sheet Workbench

**Keep your spreadsheets. Lose the busywork.**

Sheet Workbench is an open-source alpha for small team workspaces that need one confirmed view of spreadsheet work: table, calendar, board, and report. It accepts `.xlsx` working copies and is designed for private Google Sheets connections with explicit, guarded writeback.

> **Alpha / local release evidence — 0.1.0-alpha.2.** This repository is standalone and contains synthetic demo data only. Local tests cover browser signup, workspaces, XLSX upload/edit/download, source jobs, permissions and revision history. A native PostgreSQL 16.15 run also verified backup and restore into a separate test database. **No public hosted service has launched.** Live Google OAuth/Picker/writeback, Docker/HTTPS deployment, real mail delivery, desktop Excel reopening and the three-team pilot remain unverified. See [validation evidence and limits](docs/LOCAL_VALIDATION.md).

Synthetic actual-browser evidence (not a live Google demo): [table screenshot](docs/media/table.png) · [20–30 second recording](docs/media/browser-demo.webm).

## What is here

- A browser-only synthetic demo that works without an account or database.
- A Fastify/PostgreSQL server contract for authenticated workspaces, owner-managed roles, uploads, datasets, revisions, undo, guarded exports, and exact-confirmation deletion.
- A persisted source-job queue with retry/recovery records for guarded source writes. Its Google remote behavior is covered by mocks, not a live Google account.
- Dataset revision metadata and JSON/XLSX working-copy downloads for saved revisions, using each version's original workbook as the preservation base.
- An XLSX adapter that only patches selected, non-formula cells and preserves the rest of the OOXML package where supported.
- English and Korean UI strings plus setup documentation.
- Self-hosting scaffolding for an alpha Docker Compose app plus PostgreSQL volume.

The project does not copy or depend on company spreadsheets, production-site code, credentials, Google Sheet IDs, or private media.

The `samples/` directory contains synthetic `.xlsx`, CSV, report, and input-image fixtures for demos and integration work. They are not company assets or live-source evidence. Synthetic import/export is covered locally, including a native PostgreSQL 16.15 smoke run; reopening in supported desktop Excel versions and live-source behavior remain release checks.

## Quick start: synthetic demo

Requires Node.js `22.12+` and npm.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The demo data is synthetic and edits stay in this browser's local storage. No `.env` file, Google account, database, or outbound service is required for this path.

Useful checks:

```sh
npm run check       # TypeScript build plus unit/integration tests
npm run test:e2e    # Responsive browser tests; run npm run build first if standalone
```

`npm run dev:server` without `DATABASE_URL` is intentionally browser-demo-only. It exposes configuration, but workspace, upload, dataset, and auth routes fail closed.

The same quick start is available in [English](docs/QUICKSTART.md) and [한국어](docs/QUICKSTART.ko.md).

## Local team trial without Docker

Run `npm run demo:team`, then open <http://127.0.0.1:3002> after `TEAM_TRIAL_READY`. This loopback-only helper supports local signup, workspaces and the XLSX/storage flow, keeping synthetic trial data under `.local/team-trial`. Start with **`samples/team.xlsx`** and follow the [five-step team trial](docs/QUICKSTART.md#local-team-trial-upload-a-sample-workbook). Real Google connections are explicitly disabled. Stop with `Ctrl+C`. The command has been exercised locally; it is not a Docker, public-hosting or production replacement.

## Self-hosting alpha

This repository includes a Compose stack for an alpha self-hosting trial. It runs the built app and PostgreSQL with a named database volume; the app serves the web assets and `/api` from one origin.

```sh
copy .env.example .env       # PowerShell; use cp on macOS/Linux
# Replace every replace-me value with generated secrets.
docker compose up --build
```

Open <http://localhost:3001>. Native PostgreSQL 16.15 has a separate synthetic smoke result, but this Compose stack itself has not been run or verified here. Read [self-hosting](docs/SELF_HOSTING.md) before exposing anything beyond localhost.

Do not publish the development Vite server directly. A production deployment needs an HTTPS reverse proxy on one origin: serve the built web assets, proxy `/api` to the Fastify process and keep PostgreSQL private. `BETTER_AUTH_URL` supplies the trusted origin; `TRUSTED_ORIGINS` optionally lists exact additional origins. Docker and public HTTPS verification remain launch gates.

## Data and safety model

- The browser demo uses synthetic data and local browser storage only.
- Real uploads require an authenticated session, workspace role, and explicit storage consent. Uploads are stored in PostgreSQL when the server is configured.
- Viewer roles cannot edit. Dataset patches use revisions and idempotent operation IDs; Google writeback checks source identity and cell preimages before a write.
- Formula/source-ID fields are read-only in the UI. Unsupported or ambiguous workbook structures fail closed rather than being guessed.
- There is no unauthenticated public write path. Owners can manage members, change roles, remove members, delete one local dataset after its exact name is supplied, and archive/restore/delete a workspace. Deleting a dataset never changes a connected Google Sheet; an unused local XLSX source upload is removed only when no current dataset or stored revision still references it.
- Account deletion requires the exact account name and email plus a Better Auth current-password or fresh-session check. A sole owner must transfer the workspace first. Shared-team datasets stay with the workspace, while the deleted account's membership, queued source jobs, credential linkage, and author attribution are removed or anonymized. A Google dataset tied to that account becomes disconnected and read-only. This is a local, server-tested retention policy; deployment backup/log/mail retention remains the operator's responsibility.
- The portable workspace archive excludes members, auth rows, Google credentials/tokens, and every historical revision snapshot. A restored Google source is disconnected and read-only. A full PostgreSQL backup retains the complete database history; follow the operator runbook for disaster recovery.

## Configuration

The actual server requirements are documented in [apps/server/README.md](apps/server/README.md). The most important values are:

| Variable                                        | Purpose                                           | Required for                                 |
| ----------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `DATABASE_URL`                                  | PostgreSQL connection                             | Real workspaces, auth, uploads               |
| `BETTER_AUTH_SECRET`                            | Session/auth secret, 32+ random characters        | Authenticated workspaces                     |
| `BETTER_AUTH_URL`                               | Canonical same-origin auth URL                    | Auth callbacks and deployment                |
| `EMAIL_VERIFICATION_WEBHOOK_URL`                | Deployer mail-delivery callback                   | Deliverable invitation verification          |
| `PASSWORD_RESET_WEBHOOK_URL`                    | Deployer reset-link delivery callback             | Enabled password-reset flow                  |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`     | Google OAuth client                               | Google connection                            |
| `GOOGLE_TOKEN_ENCRYPTION_KEY`                   | Separate key for encrypted per-user Google tokens | Google connection                            |
| `GOOGLE_PICKER_DEVELOPER_KEY` / `GOOGLE_APP_ID` | Picker developer key and application ID           | Picker enablement after the live Google gate |

The server currently reads `GOOGLE_PICKER_DEVELOPER_KEY` and `GOOGLE_APP_ID`. The OAuth scope is limited to `drive.file`; live consent, Picker, import/refresh, and writeback are still release gates. See [integration notes](docs/INTEGRATION_NOTES.md).

Password sign-in can run without mail delivery. Invitation verification remains undeliverable without `EMAIL_VERIFICATION_WEBHOOK_URL`. Password reset stays disabled, with an explanation in the UI, unless `PASSWORD_RESET_WEBHOOK_URL` is configured. For a reset request the server POSTs `{ type: "sheet-workbench.reset-password", user, resetUrl }` to that deployer-operated endpoint; the endpoint must send the link and return a successful HTTP response. The application does not send mail itself and does not report reset delivery as successful when no callback is configured.

Never commit `.env`, database dumps, uploaded workbooks, Google tokens, or real company data.

## Documentation

- [Quickstart — English](docs/QUICKSTART.md) / [한국어](docs/QUICKSTART.ko.md)
- [Self-hosting and reverse-proxy requirements](docs/SELF_HOSTING.md)
- [Supported-file matrix](docs/SUPPORTED_FILES.md)
- [Backup, restore, and deletion](docs/BACKUP_RESTORE_DELETION.md)
- [Local validation and remaining implementation](docs/LOCAL_VALIDATION.md)
- [Launch checklist](docs/LAUNCH_CHECKLIST.md)
- [Three-team pilot protocol](docs/PILOT_PROTOCOL.md)
- [20–30 second demo script](docs/DEMO_SCRIPT.md)
- [Integration notes and open gates](docs/INTEGRATION_NOTES.md)
- [Contribution guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Newly authored project source is MIT-licensed. Third-party npm packages retain their own licenses; review their notices before redistribution. See [LICENSE](LICENSE).
