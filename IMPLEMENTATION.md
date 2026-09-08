# Implementation contract

New standalone project, no reuse of company code/data, no production-site or company-sheet mutations.

Confirmed target: free hosted + self-hosted team workspaces; XLSX import/edit/download; private Google Sheets writeback; shared table/calendar/board/report projection; English/Korean; MIT newly authored source.

Module boundaries:

- `packages/core`: shared schema, validation, dates, filters, reports and revisions.
- `packages/xlsx`: conservative workbook inspection and value-only OOXML patching.
- `apps/server`: authentication, authorization, persistence, source adapters and portability.
- `apps/web`: shared data state and table/calendar/board/report projections.
- `tests`: domain, source, server and real-browser regression checks.

The shared schema is packages/core/src/types.ts. All dataset updates must pass canonical validation; server authorization is authoritative. Demo data is synthetic and stays in browser. Real uploads require a session, workspace role, and explicit storage consent.

Server API contract (same origin /api):
- GET /api/config => {teamMode:boolean,googleEnabled:boolean,storageLabel:string}
- Better Auth /api/auth/*
- GET/POST /api/workspaces => list/create {name}; workspace list {id,name,role}
- GET/POST /api/workspaces/:wid/invitations => create {email,role}; accept POST /api/invitations/:token/accept
- GET/POST /api/workspaces/:wid/datasets => list/create dataset
- GET /api/workspaces/:wid/datasets/:did => Dataset
- POST .../:did/patch => RecordPatch, returns {record,entry,datasetRevision}
- GET .../:did/history => ChangeEntry[]
- POST .../:did/undo => {entryId,operationId}, revision-guarded inverse
- GET .../:did/events => SSE revision event after committed writes
- POST .../:wid/uploads => multipart xlsx; returns {uploadId,inspection}
- POST .../:wid/import => {uploadId,sheetName,headerRow,startColumn,endColumn,endRow,mapping,name,dateOrder,locale,timeZone,weekStartsOn}; creates Dataset (server derives records from original, not trusting client)
- GET .../:did/export => verified xlsx attachment

Google source writes require per-editor OAuth permission, queued operations, before/after source checks, fail closed on uncertain row identity. Missing OAuth credentials must produce explicit setup-needed state, never a fake success.

Acceptance: typecheck/build; domain date/report/validation tests; server isolation/viewer/operation retry/concurrency tests; xlsx byte-preservation/unsupported files/formula protection tests; responsive browser tests. Public hosting, live Google OAuth/writeback, native Excel roundtrip, and 3-team pilot remain release gates until actually verified.
