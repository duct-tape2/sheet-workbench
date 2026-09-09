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

## Local team trial: upload a sample workbook

For an actual local account, database and XLSX download, run:

```sh
npm run demo:team
```

Open `http://127.0.0.1:3002` after `TEAM_TRIAL_READY` appears. This command builds the app first, so startup takes longer than the browser-only demo. Use **EN / 한국어** in the navigation if the UI opens in the other language.

1. Choose **Team workspace**, then create a synthetic account (for example an address ending in `@example.test`). Do not reuse a real password.
2. Create a workspace and select **Connect data**. Accept the local storage explanation and upload **`samples/team.xlsx`** from this repository. Confirm the suggested columns in the preview.
3. Edit a task in the table. Switch to **Report** and choose a period including that task's date to see the same confirmed title.
4. Use **Export** to download the updated XLSX. **Versions** offers JSON and XLSX copies of saved revisions; the repository's input file is never overwritten.
5. Check the browser's Downloads list (usually `Ctrl+J`) or your selected download folder. Report files end in `.md`; spreadsheet copies end in `.xlsx`. A browser may ask where to save or add a suffix such as `(1)` to an existing filename. A download-start message does not prove that the browser saved the file.

The helper listens only on this PC and retains its synthetic data in `.local/team-trial` between restarts. Stop with `Ctrl+C`. It uses embedded PostgreSQL-compatible storage, not the production PostgreSQL/Docker deployment; Google connections and real mail delivery are disabled. Do not expose it publicly or upload real company files. See [self-hosting](SELF_HOSTING.md) for deployment requirements.

## Server without a database

`npm run dev:server` can expose `/api/config` for the browser demo. Without `DATABASE_URL`, real workspace, auth, upload, and dataset routes return setup/unavailable errors. This is expected and is not a substitute for PostgreSQL.

## Alpha Compose trial

```sh
cp .env.example .env
# Replace POSTGRES_PASSWORD and BETTER_AUTH_SECRET with random values.
docker compose up --build
```

Open `http://localhost:3001`. The stack uses an app container and a named `postgres_data` volume. `docker compose down` keeps the volume; do not use `docker compose down -v` unless you intend to delete the database volume after checking backups.

This Compose path is scaffolding only. The current development environment has no Docker CLI, so Docker is not verified here. A separate private native PostgreSQL 16.15 smoke run covered synthetic auth, XLSX import/edit/export, and dump/restore, but not this Compose image or a hosted deployment. See [SELF_HOSTING.md](SELF_HOSTING.md), [BACKUP_RESTORE_DELETION.md](BACKUP_RESTORE_DELETION.md), and [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) before a hosted or team deployment.

## Real source connections

Real `.xlsx` uploads require sign-in, a workspace role, and explicit storage consent. Google Sheets requires OAuth credentials, per-user encrypted token storage, a Picker configuration, and live tests against a permitted sheet. Do not make a sheet public to work around setup. The Google integration is an unverified release gate.
