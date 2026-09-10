# Work continuation — experimental alpha

The existing browser workbench stays unchanged. **Continue work** is a separate PC workflow, not a replacement for existing recipes or a claim of universal Excel support.

## Using it

1. Follow [PC setup](COMPANION.md). Open the one-use local URL printed by the companion. The public Pages site cannot connect to your files or Excel.
2. Select a copy of an existing XLSX and add this period's TXT/CSV evidence, pasted conversation, or supported local document extraction. No messaging account is connected.
3. Enter an exact `YYYY-MM`, your request, and confirmed rules. Use stable IDs, units and approved rounding/rates. Do not use names alone as identity.
4. Prepare a proposal with local Ollama. If there is no local model, stop and install one deliberately; the app does not switch providers. A configured cloud provider is a separate selection with a list of transmitted data and a cost acknowledgment.
5. Read every before/after value and quoted source. Questions, mismatched evidence, changed preimages and formula writes block application. Correct the rules or evidence and prepare again.
6. Optionally enter independently verified expected results by sheet/cell. Confirm the review and make a working copy. Without expected results, the output remains **draft** even if native preservation checks pass.
7. Download the copy and review JSON together. Check them before any business use. The app does not pay, send, file or report to authorities.

Save version-2 rules separately for next time. These files can contain sensitive business rules: store them securely. They do not contain a cached authorization to reuse old changes, and the next run requires a new period and proposal. Version-1 recipes remain in the ordinary file workbench.

## Deliberate limits

- Literal changes to existing populated cells only. No inferred insertion, sheet cloning or formula editing.
- Preservation checks are intentionally strict: native text/shared-string or non-cell OOXML rewrites can reject an otherwise ordinary workbook. Do not bypass that rejection; broad format normalization is not yet supported.
- Native calculation requires Windows desktop Excel and OSS xlwings. Missing dependencies are a stop condition.
- Macros, external links/connections and automatic refresh are not executed. Unsupported workbooks stop before native execution.
- A source quote proves where text came from, not that an AI interpreted it correctly. Human review remains essential.
- Hidden sheets are profiled. A truncated context cannot produce an applicable change plan.
- PDF/image extraction is an optional Docling adapter. Code installation is not proof that its separate model assets are installed or that OCR is correct. Page-level extraction and complex scanned-document validation remain a separate gate.
- Browser review tests with mocked AI are not evidence of model reasoning quality. A small native Excel smoke test is not broad compatibility certification.
- No actual payroll correctness, tax compliance, payment readiness, universal formatting preservation or production service claim is made.

## Acceptance evidence

See the [dated acceptance record and open gates](WORK_CONTINUATION_STATUS.md).

`tests/workflow.test.ts` covers source evidence, protected formulas, preimages, explicit periods, duplicate targets and recipe separation. `tests/companion.test.ts` covers the local server boundary and synthetic workbooks. `tests/e2e/workflow.spec.ts` covers browser authentication, review, stable retry IDs and authenticated downloads. `npm run test:companion:excel` requires actual Windows Excel; it must not be replaced with a mocked pass.

The full proposed release gate remains broader: twelve genuinely different domain/structure workbooks, nested and dynamic formulas, full structure preservation, interruption recovery, document extraction, a real local model, and consented anonymized pilots. Record failures as failures, not as inferred successes.

## Open-source boundaries

Pinned optional packages and upstream references are listed in [companion dependencies](COMPANION_DEPENDENCIES.md).

The xlwings adapter uses only its BSD-licensed open-source API, not PRO. Docling code is MIT; model artifacts have their own licenses. Ollama is optional and a user's chosen model has its own license and hardware needs. OpenRefine review/history, SpreadsheetLLM structure-aware context, and SpreadsheetBench evaluation are design references, not code copied into this repository. Univer and HyperFormula are not integrated as the default engine.
