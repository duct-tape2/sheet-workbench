# Browser-only public demo

The static build lets visitors try the table, calendar, board and report using synthetic records, without running a server. Account entry, real file uploads and Google authorization are disabled. Edits stay in this browser's local storage; they are not shared with other visitors. Do not enter real company or personal information. Clearing browser data removes demo edits.

This is separate from a managed team service. For a local authenticated XLSX trial, use [`npm run demo:team`](QUICKSTART.md#local-team-trial-upload-a-sample-workbook). Real-source and production checks remain listed in [the launch checklist](LAUNCH_CHECKLIST.md).

## Build and test

```sh
npm ci
npx playwright install chromium webkit
npm run test:e2e:static-demo
```

This command builds to `dist/static-demo`, serves it at `/sheet-workbench/`, and tests both Chromium and WebKit. It checks an edit across all four views, CSV/report downloads, subpath links, disabled credential/file inputs, and no API or Google requests. It does not overwrite the normal `dist/web` team bundle.

For a manual preview:

```sh
npm run build:static-demo -- --base /sheet-workbench/ --outDir ../../dist/static-demo
npx vite preview --host 127.0.0.1 --port 4173 --strictPort --base /sheet-workbench/ --outDir ../../dist/static-demo
```

Open <http://127.0.0.1:4173/sheet-workbench/>. No `.env` or secrets are required. Hosting still serves page assets over the network; browser-only does not promise offline reloads or prevent the hosting provider's ordinary access logging.

## GitHub Pages publication

The prepared `.github/workflows/pages.yml` builds and tests the synthetic demo, then publishes only `dist/web` using the repository-name base path. It does not deploy the API, PostgreSQL, uploads or credentials.

An owner must first create the public repository and choose **Settings → Pages → Build and deployment → Source: GitHub Actions**. After the workflow succeeds, check the reported deployment URL and all four views on the live site. A local passing test or a prepared workflow is not proof that publication has succeeded.

Forks can use their own repository name. A custom domain or root-level Pages site needs an appropriate `--base` adjustment and a new live check.

## 한국어 요약

공개 데모는 가상 자료로 표·달력·보드·보고서를 체험하는 화면입니다. 로그인, 실제 파일 업로드, Google 연결은 받지 않습니다. 수정 내용은 현재 브라우저에만 저장되며 다른 방문자와 공유되지 않습니다. 회사 자료나 개인정보를 입력하지 마세요. 브라우저 데이터를 지우면 데모 수정 내용도 사라집니다.

실제 XLSX와 계정을 시험하려면 [로컬 팀 시험 안내](QUICKSTART.ko.md)를 따르세요. 공개 데모 배포와 실제 자료를 받는 팀 서비스 운영은 서로 다른 단계입니다.
