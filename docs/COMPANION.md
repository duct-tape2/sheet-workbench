# Windows PC connection — experimental

This developer alpha uses your installed desktop Excel to calculate **a temporary working copy**. It does not replace Excel, alter your open workbooks, or make the public website a remote-control agent. It is not a one-click Windows installer yet.

## What you need

- Windows, desktop Microsoft Excel with a valid license, Node.js 22.12 or newer, Python 3.12, and Git.
- A terminal opened in this repository. If you have not downloaded the source, clone `https://github.com/duct-tape2/sheet-workbench.git` and enter the `sheet-workbench` folder first.
- For local AI: Ollama and an explicitly installed local model. Model download and running-memory requirements are additional to the application.
- Start with synthetic files. No company source or real payroll is included.

## Start the local app (PowerShell)

```powershell
npm ci
npm run build
py -3.12 -m venv .local/companion-venv
.local/companion-venv/Scripts/python.exe -m pip install -r packages/companion/requirements-excel.txt
npm run companion
```

If `py` is not available, install Python 3.12 with its Windows launcher or use the full path to your Python 3.12 executable for the venv command. Do not replace or remove your existing Excel installation. Only the BSD open-source xlwings API is used; PRO is not required.

The terminal prints a **one-use `http://127.0.0.1:.../?bootstrap=...` link**. Copy that complete link into your browser once. It signs in to this local companion and removes the token from the URL. Keep the terminal running. Do not share the link. Restart `npm run companion` to obtain a new link if the session is lost.

The GitHub Pages website cannot connect to this local service. Use the new local window, not the public browser tab, for PC work. Click **Continue work / 업무 이어하기** if you land in the ordinary file workbench.

## Local AI setup is a deliberate download

Install Ollama from its official site, then choose a model suitable for your machine. As an optional starting model, [Qwen3.5 4B](https://ollama.com/library/qwen3.5:4b) is a roughly 3.4 GB download (the model page lists its license). Running it needs additional free memory; download size is not the RAM requirement. CPU-only generation can be slow. Do not use this model size as a promise of complex-business reasoning quality.

If you choose that download, run:

```powershell
ollama pull qwen3.5:4b
ollama list
```

Keep Ollama running, then reopen or refresh the companion window. No available local model means no AI proposal. Cloud-backed Ollama models must not be treated as local processing. There is no silent fallback to a paid provider.

Cloud configuration is optional and server-side. The app must show the configured provider and the selected workbook/evidence/rules being transmitted, and require a separate cost acknowledgment for that run. Do not put API keys into a browser URL, recipe, workbook or Git commit. No real paid-provider validation is claimed by this alpha.

## Files, review and output

Follow [the work-continuation guide](WORK_CONTINUATION.md): select an existing XLSX, add evidence, enter an explicit month and confirmed rules, review source quotes and changes, then create a copy. TXT/CSV and pasted conversation need no OCR model. PDF/images use an optional Docling adapter and remain unavailable if its dependencies/models are not prepared.

### Optional PDF/image adapter

This installation may download large Python packages; first use may additionally download Docling model artifacts. Check available disk space and each model's license before opting in. No OCR correctness or completed model installation is implied by installing the package.

```powershell
.local/companion-venv/Scripts/python.exe -m pip install -r packages/companion/requirements-docling.txt
$env:COMPANION_DOCLING_ENABLED = "1"
npm run companion
```

Without that explicit environment setting, PDF/image extraction remains blocked, even if Docling is installed. Do not enable it on a restricted company PC without your organization's permission. TXT/CSV still work without it.

Files are uploaded **to the loopback process on this PC**, not to Pages. Service-owned uploads and results are stored under the OS temporary directory's `sheet-workbench-companion` folder. The browser's review state is temporary. Download outputs and review JSON to a safe location; temporary storage is not a backup. Files may remain on disk after the terminal closes. On a shared PC, do not use sensitive files. Close the companion before removing its explicitly named data folder when you no longer need its results.

Only existing literal cells can be changed. Formula cells, unsupported workbook features, ambiguous evidence and failed native preservation checks stop application. A failed run is not a valid deliverable. Without independent expected-result checks, a successfully preserved output is labeled **draft**.

## Verify your installation

```powershell
npm run test:companion:excel
```

This uses synthetic workbooks and dedicated invisible Excel instances. A successful terminal result is native-test evidence, not a certification of all your company workbooks. If it fails, preserve your originals and report the error; do not disable safety checks. The installed Excel version may not support every formula or feature.

No macro execution, external-link refresh, Power Query refresh, generated shell/VBA/Python execution, payments, filings or outbound business messages are supported. PDF/OCR accuracy, real-model interpretation and consented anonymized pilot work require separate verification.

## 한국어 요약

이 기능은 기존 웹 작업대와 별개인 **실험용 PC 연결**입니다. 위 명령은 PowerShell에서 저장소 폴더를 연 뒤 순서대로 실행하세요. Excel은 미리 설치되어 있어야 합니다. 실행하면 나오는 일회용 로컬 링크를 새 창에서 열면 됩니다. 공개 사이트 링크로 PC 파일에 접근하는 방식이 아닙니다.

Ollama에 모델이 없으면 AI 해석은 작동하지 않습니다. 모델 다운로드를 직접 선택해야 하며, 클라우드로 자동 전환하지 않습니다. 처음에는 가상 파일로 확인하세요. 대상 기간·회사 규칙·근거·변경안을 검토한 뒤 복사본을 다운로드하고, 검토가 끝나지 않은 초안을 지급이나 신고에 사용하지 마세요.
