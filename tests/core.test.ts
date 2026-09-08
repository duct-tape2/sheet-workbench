import { describe, it, expect } from "vitest";
import {
  addDays,
  applyRecordPatch,
  categoryIndex,
  createRecord,
  csv,
  excelDate,
  filterRecords,
  issues,
  labelKey,
  parseDate,
  report,
  safeUrl,
  todayIn,
  undoChange,
  validateDataset,
  validateValues,
  weekLabel,
  weekRange,
  assertRole,
} from "../packages/core/src/index";
import { makeDemo } from "../packages/core/src/demo";
const sample = () => makeDemo("team", "en", "2026-09-08");
describe("calendar dates without local-time shifts", () => {
  it.each([
    ["2026-09-08", "ymd", "2026-09-08"],
    ["31/08/2026", "dmy", "2026-08-31"],
    ["08/31/2026", "mdy", "2026-08-31"],
    ["01/02/2026", "ymd", null],
    ["2026/09-08", "ymd", null],
    ["2026-02-29", "ymd", null],
    ["2024-02-29", "ymd", "2024-02-29"],
    ["2026-13-01", "ymd", null],
  ])("%s (%s)", (raw, order, expected) =>
    expect(parseDate(raw, order as "ymd")).toBe(expected),
  );
  it("rejects false leap day in Excel and supports 1904", () => {
    expect(excelDate(60)).toBeNull();
    expect(excelDate(60.5)).toBeNull();
    expect(excelDate(61)).toBe("1900-03-01");
    expect(excelDate(0, true)).toBe("1904-01-01");
  });
  it("retains month-majority week rule", () => {
    expect(weekLabel("2026-08-31", "ko")).toBe("2026년 9월 1주차");
    expect(weekLabel("2026-05-31", "ko")).toBe("2026년 5월 4주차");
  });
  it("supports Sundays and DST boundary without losing days", () => {
    expect(weekRange("2026-03-08", 0).start).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(todayIn("Asia/Seoul", new Date("2026-03-07T20:00Z"))).toBe(
      "2026-03-08",
    );
  });
});
describe("one canonical data projection", () => {
  it("report and filters match record IDs exactly", () => {
    const d = sample(),
      f = { start: "2026-09-07", end: "2026-09-13" };
    expect(new Set(report(d, f).rows.map((r) => r.id))).toEqual(
      new Set(filterRecords(d, f).map((r) => r.id)),
    );
  });
  it("date-less rows remain in table but not period report", () => {
    const d = sample();
    expect(filterRecords(d)).toHaveLength(12);
    expect(
      report(d, { start: "2026-09-07" }).rows.some(
        (r) => r.values.date === null,
      ),
    ).toBe(false);
  });
  it("applies edit once in returned snapshot and report", () => {
    const d = sample(),
      r = d.records[0],
      u = applyRecordPatch(
        d,
        {
          operationId: "op1",
          recordId: r.id,
          baseRevision: 0,
          changes: { title: "Updated" },
        },
        "Maya",
      );
    expect(report(u.dataset).text).toContain("Updated");
    expect(d.records[0].values.title).not.toBe("Updated");
    expect(u.dataset.revision).toBe(1);
  });
  it("rejects stale edit and unsafe undo", () => {
    const d = sample(),
      r = d.records[0],
      p = {
        operationId: "op1",
        recordId: r.id,
        baseRevision: 0,
        changes: { title: "Updated" },
      };
    const u = applyRecordPatch(d, p, "Maya");
    expect(() => applyRecordPatch(u.dataset, p, "Maya")).toThrow("changed");
    const v = applyRecordPatch(
      u.dataset,
      {
        ...p,
        operationId: "op2",
        baseRevision: 1,
        changes: { title: "Newer" },
      },
      "Alex",
    );
    expect(() => undoChange(v.dataset, u.entry, "undo", "Maya")).toThrow(
      "newer",
    );
    expect(
      undoChange(u.dataset, u.entry, "undo", "Maya").record.values.title,
    ).toBe(r.values.title);
  });
  it("does not infer done statuses", () => {
    const d = sample();
    d.completedStatuses = [];
    expect(report(d).completed).toBe(0);
  });
});
describe("input and permission safety", () => {
  it("normalizes spaces but not typos", () => {
    expect(labelKey("Naver  Clip")).toBe(labelKey("NAVERCLIP"));
    expect(labelKey("Naver Clim")).not.toBe(labelKey("Naver Clip"));
    expect(categoryIndex("NAVERCLIP")).toBe(categoryIndex("Naver Clip"));
  });
  it("rejects executable URLs and CSV formula execution", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    const d = sample();
    d.records[0].values.title = '=HYPERLINK("evil")';
    expect(csv(d)).toContain("'=HYPERLINK");
  });
  it("rejects invalid field values and unknown columns", () => {
    const d = sample();
    expect(() =>
      validateValues(d.fields, { date: "2026-02-30" }, true),
    ).toThrow();
    expect(() => validateValues(d.fields, { other: "x" }, true)).toThrow();
    expect(() => validateValues(d.fields, { title: "" }, true)).toThrow();
  });
  it("protects formula and identity fields", () => {
    const d = sample();
    d.records[0].lockedFields = ["title"];
    expect(() =>
      applyRecordPatch(
        d,
        {
          operationId: "x",
          recordId: d.records[0].id,
          baseRevision: 0,
          changes: { title: "x" },
        },
        "a",
      ),
    ).toThrow("read-only");
  });
  it("validates schemas and viewer role", () => {
    expect(validateDataset(sample()).records.length).toBe(12);
    expect(() => assertRole("viewer", true)).toThrow();
    expect(() => validateDataset({ ...sample(), timeZone: "Mars" })).toThrow();
  });
  it("flags duplicate candidates without silently merging", () => {
    const d = sample();
    d.records[1].values.title = d.records[0].values.title;
    expect(issues(d).some((x) => x.code === "DUPLICATE")).toBe(true);
    expect(d.records).toHaveLength(12);
  });
});
describe("canonical dataset hardening", () => {
  it("rejects malformed fields, values, revisions, and prototype-bearing input", () => {
    const d = sample();
    expect(() =>
      validateDataset({
        ...d,
        fields: [{ key: "title", label: "Title", type: "made-up" }] as any,
      }),
    ).toThrow("supported type");
    expect(() =>
      validateDataset({
        ...d,
        fields: [
          { key: "title", label: "Title", type: "text", options: ["x"] },
        ] as any,
      }),
    ).toThrow("options");
    expect(() => validateDataset({ ...d, revision: -1 })).toThrow("revision");
    const poisoned = structuredClone(d) as any;
    poisoned.records[0].values = Object.create({ title: "inherited" });
    poisoned.records[0].values.title = "safe";
    expect(() => validateDataset(poisoned)).toThrow("Invalid record");
    const unsafeValues = JSON.parse('{"__proto__":"polluted","title":"safe"}');
    expect(() => validateValues(d.fields, unsafeValues, true)).toThrow(
      "Unknown field",
    );
  });
  it("validates source ranges, row ownership, Google read-only metadata, and palette values", () => {
    const d = sample();
    const xlsx = {
      ...d,
      source: {
        kind: "xlsx" as const,
        fileName: "book.xlsx",
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 7,
        endRow: 20,
      },
      records: d.records.map((record, index) => ({
        ...record,
        sourceRow: index + 2,
      })),
    };
    expect(validateDataset(xlsx).source.kind).toBe("xlsx");
    expect(() =>
      validateDataset({
        ...xlsx,
        source: { ...xlsx.source, startColumn: 8, endColumn: 7 },
      }),
    ).toThrow("range");
    expect(() =>
      validateDataset({ ...xlsx, source: { ...xlsx.source, startColumn: -1 } }),
    ).toThrow("range");
    expect(() =>
      validateDataset({
        ...xlsx,
        records: [
          ...xlsx.records,
          { ...xlsx.records[0], id: "another-record" },
        ],
      }),
    ).toThrow("Source rows");
    expect(
      validateDataset({
        ...d,
        records: d.records.map((record, index) =>
          index === 0
            ? { ...record, sourceValues: { date: "09/07/2026" } }
            : record,
        ),
      }).records[0].sourceValues,
    ).toEqual({ date: "09/07/2026" });
    expect(() =>
      validateDataset({
        ...d,
        records: d.records.map((record, index) =>
          index === 0 ? { ...record, sourceValues: { unknown: "x" } } : record,
        ),
      }),
    ).toThrow("source field");
    expect(
      validateDataset({
        ...d,
        source: {
          kind: "google",
          spreadsheetId: "sheet-id",
          sheetName: "Tasks",
          sourceColumns: { title: "A" },
          sourceHeaders: { title: "Task" },
          readOnly: true,
          readOnlyReason: "No unique source ID",
        },
        categoryColors: { operations: 0 },
      }).categoryColors,
    ).toEqual({ operations: 0 });
    expect(() =>
      validateDataset({
        ...d,
        source: {
          kind: "google",
          spreadsheetId: "sheet-id",
          sheetName: "Tasks",
          sourceColumns: { title: "XFE" },
        },
      }),
    ).toThrow("columns");
    expect(() =>
      validateDataset({
        ...d,
        source: {
          kind: "google",
          spreadsheetId: "sheet-id",
          sheetName: "Tasks",
          sourceHeaders: { unknown: "Task" },
        },
      }),
    ).toThrow("headers");
    expect(() =>
      validateDataset({ ...d, categoryColors: { Operations: 8 } }),
    ).toThrow("Category colors");
  });
  it("requires stable operations and a unique explicit identity for a new record", () => {
    const d = sample();
    d.mapping = { ...d.mapping, identity: "title" };
    expect(
      createRecord(d, { title: "New source identity" }, "new-record").values
        .title,
    ).toBe("New source identity");
    expect(() =>
      createRecord(d, { title: d.records[0].values.title }, "another-record"),
    ).toThrow("unique");
    expect(() =>
      applyRecordPatch(
        d,
        {
          operationId: "not stable id",
          recordId: d.records[0].id,
          baseRevision: 0,
          changes: { status: "Done" },
        },
        "actor",
      ),
    ).toThrow("identifier");
    expect(() =>
      applyRecordPatch(
        d,
        {
          operationId: "op-safe",
          recordId: d.records[0].id,
          baseRevision: 0,
          changes: { title: "changed" },
        },
        "actor",
      ),
    ).toThrow("read-only");
  });
  it("keeps every report count tied to the same filtered rows", () => {
    const d = sample();
    const r = report(d, { start: "2026-09-07", end: "2026-09-13" });
    expect(
      r.groups.reduce((count, [, records]) => count + records.length, 0),
    ).toBe(r.total);
    expect(r.rows).toHaveLength(r.total);
    expect(r.completed).toBe(
      r.rows.filter((row) =>
        d.completedStatuses.includes(String(row.values.status)),
      ).length,
    );
  });
  it("keeps source-check telemetry separate from data updates and rejects unsafe values", () => {
    const d = sample();
    expect(
      validateDataset({
        ...d,
        lastCheckedAt: "2026-09-08T12:34:56.000Z",
        lastSyncError: "GOOGLE_REFRESH_FAILED",
      }),
    ).toMatchObject({
      lastCheckedAt: "2026-09-08T12:34:56.000Z",
      lastSyncError: "GOOGLE_REFRESH_FAILED",
      updatedAt: d.updatedAt,
    });
    expect(() => validateDataset({ ...d, lastCheckedAt: "yesterday" })).toThrow(
      "lastCheckedAt",
    );
    expect(() =>
      validateDataset({ ...d, lastSyncError: "unsafe error" }),
    ).toThrow("lastSyncError");
  });
});
