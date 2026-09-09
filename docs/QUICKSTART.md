# Quickstart

This guide starts with the current local-file renewal. It is a local alpha workflow, not a managed cloud service.

## 1. Open the local workspace

Requirements: Node.js `22.12+` and npm.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173/?mode=local>. The default current mode is local, so the query parameter is optional. No account, database, `.env` file, Google account, or server setup is required for this path.

Choose **Open files**. You can also begin with one of the synthetic samples; a sample is only a safe way to explore the interface, not proof for a real workbook.

## 2. Review each source before accepting it

Select `.csv` or a supported `.xlsx` file. Before it becomes a source, check the import review:

- XLSX: sheet, header row, first/last column, and last row.
- CSV: header row/range plus encoding and delimiter.
- The displayed rows and columns, especially when the file has title rows or a nonstandard header.

Select **Accept source** only after the range is correct. The local workflow reads source bytes into browser memory. It does not overwrite the file you selected.

The current guardrails are 25 MiB across source files and 10,000 imported rows. Unsupported, encrypted, macro-heavy, legacy, or ambiguous workbook structures can be refused. Formula and protected cells are locked.

## 3. Choose a workflow

### Clean one file

Make the file the primary source, then use the **Operations** panel to trim whitespace, remove blank rows, deduplicate, find/replace, convert one column, or create a summary. Choose **Review result** and inspect the changed rows and warnings. A blocked preview cannot be applied.

### Append incoming rows

1. Open both files and select the file that supplies the existing table as the primary source.
2. Choose **Append source**, then choose the incoming source.
3. Explicitly map each target column to an incoming column.
4. Review the added rows, then apply if they are correct.

Append does not infer a column map and does not change either original file. Unmapped target fields in appended rows are empty.

### Compare a current file with a reference file

1. Open the current and reference files, and keep the current file as primary.
2. Choose **Compare source** and choose the reference source.
3. Select at least one key/ID column; add mappings when the two files use different column names.
4. Add field mappings for the values you want to compare, then review the result.

The review reports changed, missing, and reference-only rows. It stops when either side has a blank or duplicate comparison key. Resolve that source problem rather than selecting an arbitrary match.

### Look up reference fields

Use **Look up columns** with the current file as primary and a reference file as the other source. Select key/ID columns, map differently named keys, then add the reference fields to bring in. The result adds clearly labelled reference columns. Missing matches stay empty; blank or duplicate keys block the operation.

## 4. Apply, undo, export, and optionally save

Every operation opens a review before it changes the in-memory result. **Undo** and **Redo** cover confirmed operations in this session. Source-row details in the review help trace a result value back to an imported row.

Use **Export** for:

- **Result .xlsx** — a new workbook from the current result, with values stored as text cells; original formatting and numeric cell types are not preserved.
- **Result .csv** — a CSV from the current result.
- **Original / formatted file** — only when shown; it is guarded for the selected source and may not be available for unsupported output cases.

Downloads are browser-initiated. Check the browser's download list or chosen download folder; a “download started” message is not a disk-write guarantee.

**Keep on this device** is opt-in. Turn it on, then choose **Save device copy**. To return later, choose **Load device copy**. It stores a local project copy in IndexedDB in this browser on this device. It does not share work, make a backup, or preserve data after browser storage is cleared. Saving a stale copy after another tab has saved a newer one is rejected rather than silently overwriting the newer copy. Session undo/redo history is not restored after reload.

## 5. Reuse a recipe deliberately

Choose **Save recipe** below operation history. In the naming dialog, enter a name such as `Weekly cleanup`, then choose **Save recipe** inside that dialog to download the JSON file.

The history panel can save confirmed operations as a `.sheet-recipe.json` file. It does not include an ad-hoc individual cell edit. To reuse it, open the new source files, choose **Load recipe**, match each saved source to the correct current source, and inspect the replay preview. A different sheet/range or incompatible columns should be corrected before applying; do not treat a recipe as permission to force a changed file structure through.

## Other modes

- `?mode=team` opens the existing team interface. It only works with a self-hosted server and PostgreSQL; it is not a public Pages service. For a loopback-only synthetic trial, run `npm run demo:team`, wait for `TEAM_TRIAL_READY`, then open <http://127.0.0.1:3002/?mode=team> and use `samples/team.xlsx`.
- `?mode=demo` retains the legacy synthetic demo. In a static build it accepts no real files, account details, or Google authorization.

The [public workbench](https://duct-tape2.github.io/sheet-workbench/?lang=en) uses a static browser-local build; see [deployment history](https://github.com/duct-tape2/sheet-workbench/actions/workflows/pages.yml) for its revision. Start with synthetic or redacted test copies, not company secrets or personal data.

## Validation and hosting boundaries

```sh
npm run check
npm run test:e2e:local
npm run test:e2e:static-demo
```

The local renewal has local automated and browser-test evidence. Run the checks again before publishing a new revision. Live Google OAuth/Picker/writeback, real mail delivery, Docker/public HTTPS, desktop Excel reopening, and a managed team service are not verified. See [local validation](LOCAL_VALIDATION.md), [self-hosting](SELF_HOSTING.md), and [the launch checklist](LAUNCH_CHECKLIST.md).
