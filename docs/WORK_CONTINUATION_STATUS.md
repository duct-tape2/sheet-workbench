# Work continuation alpha — acceptance record

Date: 2026-09-10. This is a scoped engineering record, not a claim that the complete product plan has passed.

## Available in this increment

- Separate English/Korean work-continuation screen; existing browser tools and version-1 recipes remain available.
- Explicit period/rules, version-2 rule files, workbook structure summary, evidence quotes, before/after review and approval.
- Authenticated loopback-only PC service, opaque selected-file IDs, CSRF protection, one-use bootstrap, no public-page PC probes.
- Local Ollama structured-proposal adapter and separately consented configured-cloud adapter. Neither is a certified business reasoning engine.
- Original hash/preimage validation, formula protection, literal-cell copy edits, dedicated Excel calculation/reopen, target/non-target and structure verification, independent expected-result checks, draft labeling and authenticated downloads.
- Serialized native runs and durable request-ID ledger commits. This is not a distributed or crash-recovery certification.
- Optional Docling extraction code with explicit download opt-in. It is not installed or OCR-validated in this release environment.
- Four real continuous 30-second H.264 videos: English/Korean, desktop/mobile. They illustrate existing tested browser operations with synthetic data, not future payroll automation.

## Local evidence

| Check                                   | Evidence / scope                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build and unit/integration tests        | `npm run check`: 175 tests in 27 files passed                                                                                                                                                                                                                                                        |
| Existing browser regression             | `npm run test:e2e`: 66 Chromium/WebKit checks passed                                                                                                                                                                                                                                                 |
| Local browser workbench                 | `npm run test:e2e:local`: 26 checks passed, including actual MP4 playback                                                                                                                                                                                                                            |
| Static deployment mode                  | `npm run test:e2e:static-demo`: 2 checks passed                                                                                                                                                                                                                                                      |
| New work UI / real local authentication | `npm run test:e2e:workflow`: 6 checks passed; proposal execution uses a controlled mock, not a real AI model                                                                                                                                                                                         |
| Native Excel                            | Final full 12-fixture native-normalized run passed; a targeted fixture passed twice. Earlier independent repeats had a runner failure and an HTTP 409. Those intermittent failures did not reproduce after redacted diagnostic instrumentation; their cause remains unclassified, not fixed by proof |
| Setup rehearsal                         | Fresh isolated browser reached authenticated local UI with Excel available; stopped at the documented missing-model boundary                                                                                                                                                                         |

The browser counts overlap where the normal suite includes local tests; do not add them together as independent coverage. The four business-domain labels on native fixtures do not establish domain-specific tax, payroll or accounting correctness.

## Gates still open

- Real local-model proposal quality, corrections/cancellations, duplicated identities, malicious-document instructions and missing-evidence scenarios.
- Installed Docling models, image/PDF OCR quality and reliable page-level evidence locations.
- Broad advanced Excel compatibility: dynamic arrays, unknown add-ins, arbitrary formatting/shared-string rewrites, varied real-world structures, business rounding and reconciliation. Unsupported files currently fail closed.
- Full calculation dependency graph, structural row/sheet changes, one-click Windows packaging, cancellation/crash recovery and portable run-history restore.
- Consented anonymized company pilots. No actual payroll or other high-stakes output is approved for use by synthetic tests.

Do not use an alpha output for payment, filing or external delivery without an independent review. Download the original, working copy and review information to your own secure backup location; PC temporary storage is not backup storage.
