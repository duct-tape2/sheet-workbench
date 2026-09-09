import { describe, expect, it } from "vitest";
import { describeChange } from "../apps/web/src/local/change-description";
import type {
  Change,
  SourceDocument,
  TableData,
} from "../packages/local/src/types";

const resultTable: TableData = {
  id: "result",
  name: "Combined",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "city", label: "City", type: "text" },
  ],
  rows: [{ id: "jae", values: { name: "Jae", city: "Busan" }, origins: [] }],
};

const sources = [{ id: "incoming", name: "incoming.csv" }] as SourceDocument[];

const describePreview = (
  change: Change,
  table = resultTable,
  operation?: { kind: "compare" },
) =>
  describeChange({
    change,
    resultTable: table,
    sources,
    locale: "ko",
    operation,
  });

describe("preview change descriptions", () => {
  it("shows labelled, quoted values for an appended result row", () => {
    expect(
      describePreview({
        rowId: "jae",
        kind: "added",
        message: "Appended from incoming.csv.",
      }),
    ).toBe('새 행: Name: "Jae" · City: "Busan"');
  });

  it("keeps the existing quoted before-to-after format for changed cells", () => {
    expect(
      describePreview({
        rowId: "mina",
        column: "name",
        before: " Mina ",
        after: "Mina",
        kind: "changed",
      }),
    ).toBe('" Mina " → "Mina"');
  });

  it("uses an explicit removed-row fallback when the row is absent from the result", () => {
    expect(describePreview({ rowId: "old", kind: "removed" })).toBe(
      "삭제된 행",
    );
  });

  it("marks a compare-only row without presenting it as an added result row", () => {
    const emptyResult: TableData = { ...resultTable, rows: [] };
    const description = describePreview(
      { rowId: "other-only", kind: "added", message: "Only in incoming.csv." },
      emptyResult,
      { kind: "compare" },
    );
    expect(description).toBe("비교 파일에만 있는 행");
    expect(description).not.toContain("새 행");
  });
});
