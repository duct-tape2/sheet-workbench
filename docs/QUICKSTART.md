# Quickstart

## Local synthetic demo

Requirements: Node.js `22.12+` and npm.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Pick a sample workflow, edit a synthetic row, and switch between table, calendar, board, and report. The demo stores synthetic edits in browser storage only. It does not require a database or Google account.

The UI follows your browser's initial language. Use the **EN / 한국어** control in the navigation to switch languages.

Run the repository checks:

```sh
npm run check
npm run test:e2e
```

The real team-flow test serves `dist/web`, so keep the build step before running the browser suite. Install both configured Playwright engines first if needed:

```sh
npx playwright install chromium webkit
```

## Server without a database

`npm run dev:server` can expose `/api/config` for the browser demo. Without `DATABASE_URL`, real workspace, auth, upload, and dataset routes return setup/unavailable errors. This is expected and is not a substitute for PostgreSQL.

## Alpha Compose trial

```sh
cp .env.example .env
# Replace POSTGRES_PASSWORD and BETTER_AUTH_SECRET with random values.
docker compose up --build
```

Open `http://localhost:3001`. The stack uses an app container and a named `postgres_data` volume. `docker compose down` keeps the volume; do not use `docker compose down -v` unless you intend to delete the database volume after checking backups.

This path is scaffolding only. The current development environment has no Docker CLI, so Docker and native PostgreSQL are not verified in this workspace. See [SELF_HOSTING.md](SELF_HOSTING.md), [BACKUP_RESTORE_DELETION.md](BACKUP_RESTORE_DELETION.md), and [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) before a hosted or team deployment.

## Real source connections

Real `.xlsx` uploads require sign-in, a workspace role, and explicit storage consent. Google Sheets requires OAuth credentials, per-user encrypted token storage, a Picker configuration, and live tests against a permitted sheet. Do not make a sheet public to work around setup. The Google integration is an unverified release gate.
