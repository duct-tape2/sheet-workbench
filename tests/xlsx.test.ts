import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  XlsxSafetyError,
  exportWorkbook,
  importWorkbook,
  inspectWorkbook,
  reimportWorkbook,
} from "../packages/xlsx/src/index.ts";

type FixtureOptions = {
  date1904?: boolean;
  macro?: boolean;
  pivot?: boolean;
  external?: boolean;
  merged?: boolean;
  rows?: Array<{ id: number; title: string; date?: number }>;
};

function workbookFixture(options: FixtureOptions = {}): Uint8Array {
  const rows = options.rows ?? [
    { id: 1, title: "Before", date: options.date1904 ? 0 : 45292 },
  ];
  const shared = [
    "ID",
    "Title",
    "Due",
    "Formula",
    "Outside selection",
    ...rows.map((row) => row.title),
  ];
  const dataRows = rows
    .map((row, index) => {
      const rowNumber = index + 2;
      const titleIndex = index + 5;
      const formula =
        index === 0
          ? `<c r="D${rowNumber}" s="3"><f>1+1</f><v>2</v></c>`
          : `<c r="D${rowNumber}"><v>2</v></c>`;
      const outside =
        index === 0
          ? `<c r="E${rowNumber}" t="inlineStr"><is><t>do not touch</t></is></c>`
          : "";
      return `<row r="${rowNumber}"><c r="A${rowNumber}"><v>${row.id}</v></c><c r="B${rowNumber}" s="2" t="s"><v>${titleIndex}</v></c><c r="C${rowNumber}" s="1"><v>${row.date ?? 45292}</v></c>${formula}${outside}</row>`;
    })
    .join("");
  const contentType = options.macro
    ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="${contentType}"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    ),
    "docProps/core.xml": strToU8(
      '<?xml version="1.0"?><cp:coreProperties xmlns:cp="urn:test"><cp:title>unchanged member</cp:title></cp:coreProperties>',
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${options.date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Tasks" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${options.external ? '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://example.invalid" TargetMode="External"/>' : ""}</Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="0"/><xf numFmtId="0"/></cellXfs></styleSheet>',
    ),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>${dataRows}</sheetData>${options.merged ? '<mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>' : ""}</worksheet>`,
    ),
  };
  if (options.pivot)
    files["xl/pivotTables/pivotTable1.xml"] = strToU8(
      "<pivotTableDefinition/>",
    );
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01") });
}

function prefixedSpreadsheetMl(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes);
  for (const path of [
    "xl/workbook.xml",
    "xl/styles.xml",
    "xl/sharedStrings.xml",
    "xl/worksheets/sheet1.xml",
  ]) {
    let xml = new TextDecoder().decode(files[path]);
    xml = xml
      .replace(/(<\/?)(?![?!])([A-Za-z_][\w.-]*)(?=[\s/>])/g, "$1x:$2")
      .replace(
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      );
    files[path] = strToU8(xml);
  }
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01") });
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function rawLocalMember(bytes: Uint8Array, wanted: string): Uint8Array {
  let eocd = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset -= 1
  )
    if (readU32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  if (eocd < 0) throw new Error("missing eocd");
  const count = readU16(bytes, eocd + 10);
  const central = readU32(bytes, eocd + 16);
  let cursor = central;
  const locations: Array<{ name: string; offset: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    locations.push({
      name: new TextDecoder().decode(
        bytes.slice(cursor + 46, cursor + 46 + nameLength),
      ),
      offset: readU32(bytes, cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const entry = locations.find((location) => location.name === wanted);
  if (!entry) throw new Error(`missing ${wanted}`);
  const next =
    locations
      .filter((location) => location.offset > entry.offset)
      .map((location) => location.offset)
      .sort((left, right) => left - right)[0] ?? central;
  return bytes.slice(entry.offset, next);
}

function encryptedVariant(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  let eocd = -1;
  for (
    let offset = result.length - 22;
    offset >= Math.max(0, result.length - 65557);
    offset -= 1
  )
    if (readU32(result, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  if (eocd < 0) throw new Error("missing eocd");
  const central = readU32(result, eocd + 16);
  const local = readU32(result, central + 42);
  result[central + 8] |= 1;
  result[local + 6] |= 1;
  return result;
}

function selection(bytes: Uint8Array) {
  return importWorkbook(bytes, {
    sheetName: "Tasks",
    headerRow: 1,
    startColumn: 1,
    endColumn: 4,
    endRow: 2,
    fileName: "synthetic.xlsx",
  });
}

describe("safe XLSX adapter", () => {
  it("inspects choices, imports typed values, formula locks, date1904, and suggestions", () => {
    const normal = workbookFixture();
    const inspected = inspectWorkbook(normal);
    expect(inspected.suggestedSelection).toEqual({
      sheetName: "Tasks",
      headerRow: 1,
      startColumn: 1,
      endColumn: 5,
      endRow: 2,
    });
    const dataset = selection(normal);
    expect(dataset.mapping).toMatchObject({
      title: "xlsx_col_B",
      date: "xlsx_col_C",
      identity: "xlsx_col_A",
    });
    expect(dataset.records[0].values).toMatchObject({
      xlsx_col_A: 1,
      xlsx_col_B: "Before",
      xlsx_col_C: "2024-01-01",
      xlsx_col_D: 2,
    });
    expect(dataset.records[0].lockedFields).toEqual(["xlsx_col_D"]);
    const modern = selection(workbookFixture({ date1904: true }));
    expect(modern.source.date1904).toBe(true);
    expect(modern.records[0].values.xlsx_col_C).toBe("1904-01-01");
    modern.records[0].values.xlsx_col_C = "1904-01-02";
    const modernXml = new TextDecoder().decode(
      unzipSync(exportWorkbook(workbookFixture({ date1904: true }), modern))[
        "xl/worksheets/sheet1.xml"
      ],
    );
    expect(modernXml).toContain('<c r="C2" s="1"><v>1</v></c>');
  });

  it("patches only changed cells, preserves style/formula/unselected XML and raw untouched ZIP members", () => {
    const original = workbookFixture();
    const before = original.slice();
    const dataset = selection(original);
    dataset.records[0].values.xlsx_col_B = "Changed";
    dataset.records[0].values.xlsx_col_C = "2024-01-02";
    const output = exportWorkbook(original, dataset);
    expect(original).toEqual(before);
    expect(rawLocalMember(output, "xl/styles.xml")).toEqual(
      rawLocalMember(original, "xl/styles.xml"),
    );
    expect(rawLocalMember(output, "docProps/core.xml")).toEqual(
      rawLocalMember(original, "docProps/core.xml"),
    );
    const xml = new TextDecoder().decode(
      unzipSync(output)["xl/worksheets/sheet1.xml"],
    );
    expect(xml).toContain(
      '<c r="B2" s="2" t="inlineStr"><is><t>Changed</t></is></c>',
    );
    expect(xml).toContain('<c r="C2" s="1"><v>45293</v></c>');
    expect(xml).toContain('<c r="D2" s="3"><f>1+1</f><v>2</v></c>');
    expect(xml).toContain(
      '<c r="E2" t="inlineStr"><is><t>do not touch</t></is></c>',
    );
    expect(selection(output).records[0].values.xlsx_col_C).toBe("2024-01-02");
  });

  it("reads and patches namespace-prefixed SpreadsheetML without changing its element namespace", () => {
    const original = prefixedSpreadsheetMl(workbookFixture());
    const dataset = selection(original);
    dataset.records[0].values.xlsx_col_B = "Prefixed";
    const output = exportWorkbook(original, dataset);
    const xml = new TextDecoder().decode(
      unzipSync(output)["xl/worksheets/sheet1.xml"],
    );
    expect(xml).toContain(
      '<x:c r="B2" s="2" t="inlineStr"><x:is><x:t>Prefixed</x:t></x:is></x:c>',
    );
    expect(selection(output).records[0].values.xlsx_col_B).toBe("Prefixed");
  });

  it("returns an exact copy when no cells changed and rejects formula writes", () => {
    const original = workbookFixture();
    const unchanged = selection(original);
    expect(exportWorkbook(original, unchanged)).toEqual(original);
    const changed = selection(original);
    changed.records[0].values.xlsx_col_D = 3;
    expect(() => exportWorkbook(original, changed)).toThrow(/read-only/);
  });

  it("appends sourceRow-less records only after a safe rectangular source without mutating the Dataset", () => {
    const original = workbookFixture();
    const dataset = selection(original);
    dataset.records.push({
      id: "new-record",
      revision: 0,
      values: {
        xlsx_col_A: 2,
        xlsx_col_B: "Appended",
        xlsx_col_C: "2024-01-03",
        xlsx_col_D: null,
      },
    });
    const output = exportWorkbook(original, dataset);
    expect(dataset.records[1].sourceRow).toBeUndefined();
    expect(dataset.source.endRow).toBe(2);
    const xml = new TextDecoder().decode(
      unzipSync(output)["xl/worksheets/sheet1.xml"],
    );
    expect(xml).toContain(
      '<row r="3"><c r="A3"><v>2</v></c><c r="B3" t="inlineStr"><is><t>Appended</t></is></c><c r="C3" s="1"><v>45294</v></c></row>',
    );
    expect(
      importWorkbook(output, {
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 4,
        endRow: 3,
      }).records,
    ).toHaveLength(2);
    const merged = selection(workbookFixture({ merged: true }));
    merged.records.push({
      id: "blocked",
      revision: 0,
      values: {
        xlsx_col_A: 2,
        xlsx_col_B: "Blocked",
        xlsx_col_C: "2024-01-03",
        xlsx_col_D: null,
      },
    });
    expect(() =>
      exportWorkbook(workbookFixture({ merged: true }), merged),
    ).toThrow(/merged cells/);
  });

  it("reimports only through a unique explicit identity and never source row position", () => {
    const first = workbookFixture({
      rows: [
        { id: 1, title: "One" },
        { id: 2, title: "Two" },
      ],
    });
    const existing = importWorkbook(first, {
      sheetName: "Tasks",
      headerRow: 1,
      startColumn: 1,
      endColumn: 4,
      endRow: 3,
    });
    const ids = new Map(
      existing.records.map((record) => [record.values.xlsx_col_A, record.id]),
    );
    const refreshed = workbookFixture({
      rows: [
        { id: 2, title: "Two" },
        { id: 1, title: "One" },
      ],
    });
    const result = reimportWorkbook(existing, refreshed, { endRow: 3 });
    expect(result.conflicts).toEqual([]);
    expect(result.dataset?.records.map((record) => record.id)).toEqual([
      ids.get(2),
      ids.get(1),
    ]);
  });

  it("reports ambiguous re-import exact matches instead of guessing rows", () => {
    const duplicate = workbookFixture({
      rows: [
        { id: 1, title: "Same" },
        { id: 1, title: "Same" },
      ],
    });
    const mapping = { title: "xlsx_col_B", identity: undefined };
    const existing = importWorkbook(duplicate, {
      sheetName: "Tasks",
      headerRow: 1,
      startColumn: 1,
      endColumn: 4,
      endRow: 3,
      mapping,
    });
    const result = reimportWorkbook(existing, duplicate, { mapping });
    expect(result.dataset).toBeUndefined();
    expect(
      result.conflicts.some(
        (conflict) => conflict.kind === "ambiguous_exact_match",
      ),
    ).toBe(true);
  });

  it("rejects macros, encryption, legacy XLS, pivots, external relationships, unsafe paths, and ZIP-bomb expansion", () => {
    for (const bytes of [
      workbookFixture({ macro: true }),
      workbookFixture({ pivot: true }),
      workbookFixture({ external: true }),
    ]) {
      expect(() => inspectWorkbook(bytes)).toThrow(XlsxSafetyError);
    }
    expect(() => inspectWorkbook(encryptedVariant(workbookFixture()))).toThrow(
      /Encrypted/,
    );
    expect(() =>
      inspectWorkbook(
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      ),
    ).toThrow(/Legacy/);
    expect(() =>
      inspectWorkbook(zipSync({ "../escape.xml": strToU8("x") })),
    ).toThrow(/Unsafe ZIP path/);
    const bomb = zipSync(
      {
        "[Content_Types].xml": strToU8("<Types/>"),
        "_rels/.rels": strToU8("<Relationships/>"),
        "xl/workbook.xml": strToU8("x".repeat(200_000)),
        "xl/_rels/workbook.xml.rels": strToU8("<Relationships/>"),
      },
      { level: 9 },
    );
    try {
      inspectWorkbook(bomb);
      throw new Error("expected ZIP bomb rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(XlsxSafetyError);
      expect((error as XlsxSafetyError).code).toBe("ZIP_BOMB");
    }
  });
});
