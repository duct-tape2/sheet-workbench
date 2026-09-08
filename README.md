# Sheet Workbench

**Keep your spreadsheets. Lose the busywork.**

Sheet Workbench is an open-source alpha for small team workspaces that need one confirmed view of spreadsheet work: table, calendar, board, and report. It accepts `.xlsx` working copies and is designed for private Google Sheets connections with explicit, guarded writeback.

> **Alpha / release-gate status.** This repository is a standalone project and contains synthetic demo data only. Local evidence covers Better Auth over the PGliteSocket/`pg` boundary, a real browser signup/workspace/XLSX upload-edit-download flow, and a synthetic API sample round-trip. That evidence does not prove a native PostgreSQL/Docker deployment. No public hosted service has launched; live Google OAuth/Picker/import/refresh/writeback, real source concurrency, mail delivery, native Excel round-tripping, and the three-team pilot remain unverified.

Synthetic actual-browser evidence (not a live Google demo): [table screenshot](docs/media/table.png) · [20–30 second recording](docs/media/browser-demo.webm).

## What is here

- A browser-only synthetic demo that works without an account or database.
- A Fastify/PostgreSQL server contract for authenticated workspaces, roles, uploads, datasets, history, undo, and guarded exports.
- An XLSX adapter that only patches selected, non-formula cells and preserves the rest of the OOXML package where supported.
- English and Korean UI strings plus setup documentation.
- Self-hosting scaffolding for an alpha Docker Compose app plus PostgreSQL volume.

The project does not copy or depend on company spreadsheets, production-site code, credentials, Google Sheet IDs, or private media.

The `samples/` directory contains synthetic `.xlsx`, CSV, report, and input-image fixtures for demos and integration work. They are not company assets or live-source evidence. The synthetic API sample round-trip is covered by the repository tests; import/export against native Excel and live sources remains a release check.

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

## Self-hosting alpha

This repository includes a Compose stack for an alpha self-hosting trial. It runs the built app and PostgreSQL with a named database volume; the app serves the web assets and `/api` from one origin.

```sh
copy .env.example .env       # PowerShell; use cp on macOS/Linux
# Replace every replace-me value with generated secrets.
docker compose up --build
```

Open <http://localhost:3001>. The Compose stack is not a claim that Docker or native PostgreSQL has been verified in this environment. Read [self-hosting](docs/SELF_HOSTING.md) before exposing anything beyond localhost.

Do not publish the development Vite server directly. A production deployment needs an HTTPS reverse proxy on one origin: serve the built web assets, proxy `/api` to the Fastify process and keep PostgreSQL private. `BETTER_AUTH_URL` supplies the trusted origin; `TRUSTED_ORIGINS` optionally lists exact additional origins. Native Docker/PostgreSQL and public HTTPS verification remain launch gates.

## Data and safety model

- The browser demo uses synthetic data and local browser storage only.
- Real uploads require an authenticated session, workspace role, and explicit storage consent. Uploads are stored in PostgreSQL when the server is configured.
- Viewer roles cannot edit. Dataset patches use revisions and idempotent operation IDs; Google writeback checks source identity and cell preimages before a write.
- Formula/source-ID fields are read-only in the UI. Unsupported or ambiguous workbook structures fail closed rather than being guessed.
- There is no unauthenticated public write path. Owners have an in-app workspace archive/export, restore-as-new-workspace, and exact-name workspace deletion flow. The archive excludes members, auth rows, and Google credentials/tokens; a restored Google source is disconnected and read-only until it is reconnected. Full database disaster recovery still requires the operator PostgreSQL runbook.

## Configuration

The actual server requirements are documented in [apps/server/README.md](apps/server/README.md). The most important values are:

| Variable                                        | Purpose                                           | Required for                                 |
| ----------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `DATABASE_URL`                                  | PostgreSQL connection                             | Real workspaces, auth, uploads               |
| `BETTER_AUTH_SECRET`                            | Session/auth secret, 32+ random characters        | Authenticated workspaces                     |
| `BETTER_AUTH_URL`                               | Canonical same-origin auth URL                    | Auth callbacks and deployment                |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`     | Google OAuth client                               | Google connection                            |
| `GOOGLE_TOKEN_ENCRYPTION_KEY`                   | Separate key for encrypted per-user Google tokens | Google connection                            |
| `GOOGLE_PICKER_DEVELOPER_KEY` / `GOOGLE_APP_ID` | Picker developer key and application ID           | Picker enablement after the live Google gate |

The server currently reads `GOOGLE_PICKER_DEVELOPER_KEY` and `GOOGLE_APP_ID`. The OAuth scope is limited to `drive.file`; live consent, Picker, import/refresh, and writeback are still release gates. See [integration notes](docs/INTEGRATION_NOTES.md).

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
