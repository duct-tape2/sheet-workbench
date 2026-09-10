# Optional companion dependencies

These tools are installed separately, not copied from a company project. This repository does not bundle Microsoft Excel, Python model weights, xlwings PRO, or a hosted AI subscription.

| Dependency | Pin / boundary                                                                      | Upstream license and source                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| xlwings    | 0.33.22; `App`, `books.open`, calculation and save through the open-source API only | [BSD-3-Clause, excluding the PRO subpackage](https://github.com/xlwings/xlwings/blob/0.33.22/LICENSE.txt)                              |
| pywin32    | 312; Windows COM dependency                                                         | [Upstream project and license](https://github.com/mhammond/pywin32)                                                                    |
| Docling    | 2.126.0; optional local extraction, explicitly enabled                              | [MIT code license](https://github.com/docling-project/docling/blob/v2.126.0/LICENSE); separately downloaded models have separate terms |
| Ollama     | User-managed local service; model locality checked before proposals                 | [Structured-output API](https://docs.ollama.com/capabilities/structured-outputs); each selected model has its own license              |

OpenRefine, SpreadsheetLLM and SpreadsheetBench inform the review/context/evaluation design. Their code or datasets are not redistributed by this implementation. Univer and HyperFormula are not included as the companion calculation engine.

Keep upstream notices with any future binary redistribution. A package's open-source license does not establish a model's license, an Excel license, OCR accuracy, or business-rule correctness.
