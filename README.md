# Sheet Workbench

**Keep your spreadsheet files. Make the repeat work reviewable.**

Sheet Workbench is an open-source alpha for working with your own CSV and supported XLSX files. Its current renewal is file-first: open files, review the selected sheet or CSV range, preview a change, then choose whether to apply it. The default local path needs no account, database, or signup.

> **File-first alpha, 2026-09-09.** This source includes the browser-local renewal. Try the [public workbench](https://duct-tape2.github.io/sheet-workbench/?lang=en); check [deployment runs](https://github.com/duct-tape2/sheet-workbench/actions/workflows/pages.yml) for the deployed revision. A successful Pages deployment does not establish a managed team service, live Google connection, or universal workbook compatibility. Start with the synthetic samples or redacted test copies.

## Turn your repo into a buyer-ready page

This repository is also public build evidence for the fixed **$99 Repo Launch** service: one existing public GitHub repo gets a focused landing page, README polish, a usable sample, a buyer path, and a handoff. Worldwide inquiries are welcome in English, with pricing in USD.

[See the service](https://duct-tape2.github.io/repo-launch/) | [Review shipped work](https://duct-tape2.github.io/work/) | [Read the case study](https://duct-tape2.github.io/examples/storefront-starter-case-study/) | [Start a paid inquiry](https://github.com/duct-tape2/duct-tape2/issues/new?template=paid-inquiry.yml)

## Start with local files

Run the local development server with Node.js `22.12+` and npm:

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173/>. The current default is the personal local-file workspace; `?mode=local` makes that choice explicit.

1. Choose **Open files** and select `.csv` or a supported `.xlsx` file.
2. Review the proposed sheet, header row, range, and (for CSV) encoding and delimiter before accepting the source.
3. Choose an operation, inspect its preview and warnings, and select **Apply changes** only if the result is right.
4. Download a result CSV or new XLSX. Choose **Original / formatted file** only when the app offers it for that source.

Files are processed in browser memory for this local workflow. **Keep on this device** is off by default; when you turn it on and save, the project is stored in this browser's IndexedDB on this device. That is a convenience copy, not a backup or a shared workspace. Clearing browser data, using another browser/device, or losing browser storage can remove it.

See the detailed [English quickstart](docs/QUICKSTART.md) or [한국어 빠른 시작](docs/QUICKSTART.ko.md).

## Free local workflows

The local workflow is intended to be fully useful without a paid tier or connected service:

- Clean a table: trim whitespace, remove blank rows, deduplicate, replace values, convert a selected column, or summarize.
- **Append:** open the current and incoming files, choose the current file as primary, and explicitly map its columns to the incoming columns. The original files are not edited.
- **Compare:** select the current and reference files, map one or more ID/key columns and the fields to compare. Blank or duplicate keys block the review instead of guessing.
- **Reference lookup:** use the same key mapping to bring selected reference fields into new result columns. Rows without a match stay empty in those result fields.
- Save a recipe containing confirmed declarative steps, open new local files, deliberately match its sources, and preview the replay. Individual cell edits are kept in the current result but are not put in a recipe.

Every operation is previewed before it is applied. Undo/redo and source-row provenance help review the result, but they do not replace checking the output before sending it on.

Current local guardrails are 25 MiB across selected source files and 10,000 imported rows. This is not universal Excel compatibility: encrypted, macro-heavy, legacy, or unsupported workbook structures may be refused. Formula and protected cells remain locked. Do not use the alpha as the only copy of an important file.

## Modes and boundaries

### Experimental: continue existing work on your PC

The separate **Continue work** screen (`?mode=work`) introduces evidence-backed, reviewed literal-cell changes to an existing workbook. The public website does not connect to your PC. Start the optional authenticated Windows companion locally; see [setup and limitations](docs/COMPANION.md).

This is not an autonomous payroll service or universal Excel engine. It requires desktop Excel for calculation, keeps formulas protected, asks for an explicit period and approved rules, and does not execute macros, external refreshes or generated code. Local Ollama is the default; missing models never trigger a silent cloud fallback. Existing browser tools and version-1 recipes remain separate and usable.

The 30-second bilingual landing film illustrates the existing append/review/export workflow using synthetic rows. It does not claim that complex payroll automation has passed real-world validation.

| Route                    | Purpose                                     | Data boundary                                                                                                   |
| ------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Default or `?mode=local` | Personal file tools in the current renewal. | Local browser processing; optional explicit device save.                                                        |
| `?mode=team`             | The existing team-workspace interface.      | Requires a self-hosted server and PostgreSQL; it is not a hosted Pages service.                                 |
| `?mode=demo`             | Legacy static synthetic demonstration.      | Synthetic rows only. In a static build it does not accept real files, account details, or Google authorization. |

The public Pages site is not a place to enter company files, credentials, or personal data. The Pages build does not provide the Fastify API, PostgreSQL, uploads, accounts, or a real Google connection.

## Team/self-hosted alpha

The existing team path remains available for local evaluation. It has locally tested contracts for accounts, workspaces, synthetic XLSX upload/edit/download, revisions, guarded exports, and role controls. Start the loopback-only synthetic trial with:

```sh
npm run demo:team
```

After `TEAM_TRIAL_READY`, open <http://127.0.0.1:3002/?mode=team> and start with `samples/team.xlsx`. It keeps synthetic trial data under `.local/team-trial`; stop it with `Ctrl+C`. It is not a production deployment and real Google connections and mail delivery are disabled.

The Compose and server documentation is retained for self-hosting evaluation, not as a claim that a hosted team service is ready. Review [self-hosting requirements](docs/SELF_HOSTING.md), [backup/restore/deletion limits](docs/BACKUP_RESTORE_DELETION.md), and the [launch checklist](docs/LAUNCH_CHECKLIST.md) before exposing any server. Live Google OAuth/Picker/writeback, Docker/public HTTPS, real mail delivery, desktop Excel reopening, and a multi-team pilot remain unverified.

## Checks and evidence

```sh
npm run check
npm run test:e2e:local
npm run test:e2e:static-demo
```

The renewal has local automated and browser-test evidence. CI reruns the checks on publication; use the deployment runs above to distinguish source availability from a successful Pages deployment. See [local validation and remaining limits](docs/LOCAL_VALIDATION.md).

## Future work, not a product promise

Managed team hosting, schedules, organization administration, optional AI assistance, PWA/desktop/mobile apps, and any paid plan are roadmap candidates only. The free local file workflow is not an expiring trial, and no pricing or paid app is available today.

Never commit `.env` files, database dumps, uploaded workbooks, tokens, or real company data. This project does not copy or depend on company spreadsheets, production-site code, private media, or Google Sheet IDs.

## License

Newly authored source is MIT-licensed. Third-party npm packages retain their own licenses; review their notices before redistribution. See [LICENSE](LICENSE).
