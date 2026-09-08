import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  inspectWorkbook,
  importWorkbook,
  exportWorkbook,
} from "../packages/xlsx/src/index";
import {
  applyRecordPatch,
  recordDate,
  report,
  weekRange,
} from "../packages/core/src/index";
describe("published synthetic sample files", () => {
  for (const name of ["team", "requests", "content"])
    it(`${name} imports, edits, preserves other sheet, exports and reimports`, () => {
      const original = new Uint8Array(
        readFileSync(new URL(`../samples/${name}.xlsx`, import.meta.url)),
      );
      const inspection = inspectWorkbook(original);
      expect(inspection.sheets).toHaveLength(2);
      const d = importWorkbook(original, {
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 8,
        endRow: 13,
        dateOrder: "ymd",
        locale: "en",
        timeZone: "UTC",
        weekStartsOn: 1,
      });
      expect(d.records).toHaveLength(12);
      expect(recordDate(d, d.records[0])).toBe("2026-09-07");
      const changed = applyRecordPatch(
        d,
        {
          operationId: "sample-change",
          recordId: d.records[0].id,
          baseRevision: 0,
          changes: { [d.mapping.title]: "Reviewed sample" },
        },
        "Tester",
      ).dataset;
      const bytes = exportWorkbook(original, changed);
      const imported = importWorkbook(bytes, {
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 8,
        endRow: 13,
        dateOrder: "ymd",
        locale: "en",
        timeZone: "UTC",
        weekStartsOn: 1,
      });
      expect(imported.records[0].values[imported.mapping.title]).toBe(
        "Reviewed sample",
      );
      expect(report(imported, weekRange("2026-09-08")).total).toBe(7);
      expect(
        inspectWorkbook(bytes).sheets.find((s) => s.name === "Read me"),
      ).toEqual(inspection.sheets.find((s) => s.name === "Read me"));
    });
});
