import { describe, expect, it } from "vitest";
import { importWorkbook } from "../packages/xlsx/src/index.ts";
import {
  exportCsv,
  exportOriginal,
  exportTableXlsx,
  importInput,
  replayRecipe,
  runOperation,
  validateRecipe,
} from "../packages/local/src/index.ts";
import type { InputFile, TableData } from "../packages/local/src/types.ts";

function csv(name: string, text: string): InputFile {
  return { id: name, name, bytes: new TextEncoder().encode(text) };
}

describe("local spreadsheet engine", () => {
  it("imports quoted CSV values as text and never mutates its input", async () => {
    const file = csv("people.csv", 'ID,Note\r\n001,"first\nsecond"\r\n');
    const original = file.bytes.slice();
    const source = await importInput(file);
    expect(source.table.rows[0].values).toEqual({ id: "001", note: "first\nsecond" });
    expect(source.table.columns.map((column) => column.type)).toEqual(["text", "text"]);
    expect(file.bytes).toEqual(original);
  });

  it("uses Papa Parse for CRLF, quoted multiline/escaped text, and leading-zero strings", async () => {
    const source = await importInput(
      csv("papa.csv", 'ID,Note\r\n001,"first\r\nsecond ""quote"""\r\n007,plain\r\n'),
    );
    expect(source.table.rows.map((row) => row.values)).toEqual([
      { id: "001", note: 'first\r\nsecond "quote"' },
      { id: "007", note: "plain" },
    ]);
    await expect(importInput(csv("bad.csv", 'ID,Note\r\n001,"unterminated'))).rejects.toThrow(
      /CSV parse error \(MissingQuotes\)/,
    );
  });

  it("uses ASCII-safe stable keys for Korean headers without changing labels", async () => {
    const source = await importInput(csv("korean.csv", "이름,도시\n민아,서울"));
    expect(source.table.columns).toMatchObject([
      { key: "column_1", label: "이름" },
      { key: "column_2", label: "도시" },
    ]);
    expect(source.table.rows[0].values).toEqual({ column_1: "민아", column_2: "서울" });
  });

  it("is immutable and fails closed before trimming a formula-derived value", () => {
    const table: TableData = {
      id: "table-1",
      name: "Formula",
      columns: [{ key: "name", label: "Name", type: "text" }],
      rows: [{ id: "row-1", values: { name: " padded " }, origins: [], locked: ["name"] }],
    };
    const before = structuredClone(table);
    const output = runOperation(table, { kind: "trim", columns: ["name"] }, []);
    expect(output.blocked).toBe(true);
    expect(output.changes.some((change) => change.kind === "conflict")).toBe(true);
    expect(table).toEqual(before);
  });

  it("keeps the first dedupe occurrence and reports each removal", async () => {
    const source = await importInput(csv("dup.csv", "ID,Name\n1,First\n1,Second\n2,Third"));
    const output = runOperation(source.table, { kind: "dedupe", keys: ["id"] }, [source]);
    expect(output.blocked).toBe(false);
    expect(output.table.rows.map((row) => row.values.name)).toEqual(["First", "Third"]);
    expect(output.changes.filter((change) => change.kind === "removed")).toHaveLength(1);
  });

  it("blocks lookup entirely when either side contains duplicate exact typed keys", async () => {
    const current = await importInput(csv("current.csv", "ID,Name\n001,Mina\n001,Jae"));
    const other = await importInput(csv("other.csv", "ID,City\n001,Seoul"));
    const output = runOperation(
      current.table,
      { kind: "lookup", sourceId: other.id, keys: [["id", "id"]], columns: [["name", "city"]] },
      [current, other],
    );
    expect(output.blocked).toBe(true);
    expect(output.table).toEqual(current.table);
    expect(output.changes.filter((change) => change.kind === "conflict").length).toBeGreaterThan(1);
  });

  it("compares without changing the current table and returns cell before/after values", async () => {
    const current = await importInput(csv("current.csv", "ID,Status\n001,Open\n002,Done"));
    const other = await importInput(csv("other.csv", "ID,Status\n001,Done\n003,Open"));
    const output = runOperation(
      current.table,
      { kind: "compare", sourceId: other.id, keys: [["id", "id"]], columns: [["status", "status"]] },
      [current, other],
    );
    expect(output.blocked).toBe(false);
    expect(output.table).toEqual(current.table);
    expect(output.changes).toContainEqual(expect.objectContaining({ column: "status", before: "Open", after: "Done", kind: "changed" }));
    expect(output.changes.some((change) => change.kind === "removed")).toBe(true);
    expect(output.changes.some((change) => change.kind === "added")).toBe(true);
  });

  it("appends explicit mappings and lookup adds collision-safe columns without overwriting", async () => {
    const current = await importInput(csv("current.csv", "ID,City\n001,Busan"));
    const other = await importInput(csv("other.csv", "ID,City\n001,Seoul\n002,Incheon"));
    const appended = runOperation(
      current.table,
      { kind: "append", sourceId: other.id, mapping: { id: "id", city: "city" } },
      [current, other],
    );
    expect(appended.table.rows).toHaveLength(3);
    const lookup = runOperation(
      current.table,
      { kind: "lookup", sourceId: other.id, keys: [["id", "id"]], columns: [["city", "city"]] },
      [current, other],
    );
    expect(lookup.blocked).toBe(false);
    expect(lookup.table.rows[0].values.city).toBe("Busan");
    const added = lookup.table.columns.find((column) => column.key !== "city" && /city/.test(column.key));
    expect(added).toBeDefined();
    expect(lookup.table.rows[0].values[added!.key]).toBe("Seoul");
  });

  it("propagates lookup formula locks and rejects duplicate mapping pairs", async () => {
    const current = await importInput(csv("current.csv", "ID\n001"));
    const source = await importInput(csv("source.csv", "ID,Formula Result\n001,computed"));
    const formulaSource = {
      ...source,
      table: {
        ...source.table,
        rows: source.table.rows.map((row) => ({ ...row, locked: ["formula_result"] })),
      },
    };
    const lookup = runOperation(
      current.table,
      { kind: "lookup", sourceId: formulaSource.id, keys: [["id", "id"]], columns: [["id", "formula_result"]] },
      [current, formulaSource],
    );
    const added = lookup.table.columns.find((column) => column.key !== "id");
    expect(added).toBeDefined();
    expect(lookup.table.rows[0].locked).toContain(added!.key);
    expect(runOperation(lookup.table, { kind: "replace", column: added!.key, from: "computed", to: "changed" }, [current, formulaSource]).blocked).toBe(true);
    const duplicate = runOperation(
      current.table,
      { kind: "lookup", sourceId: formulaSource.id, keys: [["id", "id"]], columns: [["id", "formula_result"], ["id", "formula_result"]] },
      [current, formulaSource],
    );
    expect(duplicate.blocked).toBe(true);
    expect(duplicate.changes.some((change) => /Duplicate key or column mapping pairs/.test(change.message ?? ""))).toBe(true);
  });

  it("uses decimal-safe summary totals rather than binary floating-point addition", async () => {
    const source = await importInput(csv("amounts.csv", "Team,Amount\nA,0.1\nA,0.2\nB,1.005"));
    const output = runOperation(source.table, { kind: "summary", groups: ["team"], sums: ["amount"] }, [source]);
    expect(output.blocked).toBe(false);
    const sumColumn = output.table.columns.find((column) => /amount_sum/.test(column.key));
    expect(sumColumn).toBeDefined();
    expect(output.table.rows.find((row) => row.values.team === "A")!.values[sumColumn!.key]).toBe("0.3");
  });

  it("rejects number conversion that would discard a fractional decimal", async () => {
    const source = await importInput(csv("precise.csv", "Amount\n0.123456789012345678901"));
    const output = runOperation(source.table, { kind: "convert", column: "amount", to: "number" }, [source]);
    expect(output.blocked).toBe(true);
    expect(output.table.rows[0].values.amount).toBe("0.123456789012345678901");
    expect(output.changes.some((change) => /decimal precision/.test(change.message ?? ""))).toBe(true);
  });

  it("writes injection-safe UTF-8/BOM CSV and a values-only XLSX that reopens", async () => {
    const source = await importInput(csv("unsafe.csv", "Name,Note\nMina,=HYPERLINK(\"bad\")"));
    const csvOutput = exportCsv(source.table);
    expect(csvOutput.startsWith("\uFEFF")).toBe(true);
    expect(csvOutput).toContain("'=HYPERLINK");
    const xlsx = exportTableXlsx(source.table);
    const reopened = importWorkbook(xlsx);
    expect(reopened.records[0].values.xlsx_col_B).toBe('=HYPERLINK("bad")');
  });

  it("only patches eligible original XLSX cells and keeps the original input immutable", async () => {
    const generated = exportTableXlsx({
      id: "table-x",
      name: "Source",
      columns: [{ key: "name", label: "Name", type: "text" }],
      rows: [{ id: "row-x", values: { name: "Before" }, origins: [] }],
    });
    const source = await importInput({ id: "source.xlsx", name: "source.xlsx", bytes: generated });
    const original = source.bytes.slice();
    const changed = runOperation(source.table, { kind: "replace", column: "name", from: "Before", to: "After" }, [source]);
    expect(changed.blocked).toBe(false);
    const output = exportOriginal(source, changed.table);
    expect(source.bytes).toEqual(original);
    expect(importWorkbook(output).records[0].values.xlsx_col_A).toBe("After");
    expect(() => exportOriginal(source, { ...changed.table, rows: [] })).toThrow(/non-structural/);
  });

  it("refuses recipe replay after a source schema changes", async () => {
    const source = await importInput(csv("recipe.csv", "ID,Name\n1,Mina"));
    const recipe = validateRecipe({
      version: 1,
      name: "Trim names",
      primaryId: source.id,
      sources: [{ id: source.id, name: source.name, columns: ["id", "name"] }],
      steps: [{ kind: "trim", columns: ["name"] }],
    });
    const changedSchema = {
      ...source,
      table: {
        ...source.table,
        columns: source.table.columns.slice(0, 1),
        rows: source.table.rows.map((row) => ({ ...row, values: { id: row.values.id } })),
      },
    };
    const output = replayRecipe(recipe, [changedSchema]);
    expect(output.blocked).toBe(true);
    expect(output.changes.some((change) => /schema changed/.test(change.message ?? ""))).toBe(true);
  });

  it("binds source IDs and recipes to the resolved selection", async () => {
    const file = csv("repeated.csv", "ID,Name\n1,Mina\nID,Name\n2,Jae");
    const first = await importInput(file, { headerRow: 1, startColumn: 1, endColumn: 2, endRow: 2 });
    const second = await importInput(file, { headerRow: 3, startColumn: 1, endColumn: 2, endRow: 4 });
    expect(second.id).not.toBe(first.id);
    const recipe = validateRecipe({
      version: 1,
      name: "Selection-bound",
      primaryId: first.id,
      sources: [{ id: first.id, name: first.name, columns: ["id", "name"], selection: first.selection }],
      steps: [{ kind: "trim", columns: ["name"] }],
    });
    const wrongSelection = { ...second, id: first.id, table: { ...second.table, id: first.table.id } };
    const output = replayRecipe(recipe, [wrongSelection]);
    expect(output.blocked).toBe(true);
    expect(output.changes.some((change) => /schema changed/.test(change.message ?? ""))).toBe(true);

    // The replay guard deliberately permits a new final row, but never a
    // different sheet or selected column range under a remapped source ID.
    const wrongSheet = {
      ...first,
      selection: { ...first.selection, sheetName: "Archive" },
    };
    const wrongColumns = {
      ...first,
      selection: { ...first.selection, endColumn: 1 },
    };
    expect(replayRecipe(recipe, [wrongSheet]).blocked).toBe(true);
    expect(replayRecipe(recipe, [wrongColumns]).blocked).toBe(true);
  });

  it("allows an explicitly remapped next-week source with a later end row", async () => {
    const first = await importInput(csv("week-1.csv", "ID,Name\n001,Mina"));
    const nextWeek = await importInput(csv("week-2.csv", "ID,Name\n001,Mina\n002,Jae"));
    const recipe = validateRecipe({
      version: 1,
      name: "Weekly names",
      primaryId: first.id,
      sources: [{ id: first.id, name: first.name, columns: ["id", "name"], selection: first.selection }],
      steps: [{ kind: "trim", columns: ["name"] }],
    });
    const remapped = validateRecipe({
      ...recipe,
      primaryId: nextWeek.id,
      sources: recipe.sources.map((source) => ({ ...source, id: nextWeek.id })),
    });
    const output = replayRecipe(remapped, [nextWeek]);
    expect(first.selection.endRow).not.toBe(nextWeek.selection.endRow);
    expect(first.name).not.toBe(nextWeek.name);
    expect(output.blocked).toBe(false);
    expect(output.table.rows).toHaveLength(2);
  });

  it("keeps monthly append, previous/current comparison, and duplicate reference lookup explicit", async () => {
    const january = await importInput(csv("january.csv", "Invoice,Amount\n0001,0.10\n0002,0.20"));
    const february = await importInput(csv("february.csv", "Invoice,Amount\n0003,0.30"));
    const appended = runOperation(
      january.table,
      { kind: "append", sourceId: february.id, mapping: { invoice: "invoice", amount: "amount" } },
      [january, february],
    );
    expect(appended.blocked).toBe(false);
    expect(appended.table.rows.map((row) => row.values.invoice)).toEqual(["0001", "0002", "0003"]);
    expect(january.table.rows.map((row) => row.values.invoice)).toEqual(["0001", "0002"]);

    const previous = await importInput(csv("previous.csv", "ID,Status\n001,Open\n002,Done"));
    const current = await importInput(csv("current.csv", "ID,Status\n001,Done\n003,Open"));
    const compared = runOperation(
      current.table,
      { kind: "compare", sourceId: previous.id, keys: [["id", "id"]], columns: [["status", "status"]] },
      [current, previous],
    );
    expect(compared.table).toEqual(current.table);
    expect(compared.changes).toContainEqual(expect.objectContaining({ column: "status", before: "Done", after: "Open", kind: "changed" }));

    const duplicateReference = await importInput(csv("reference.csv", "ID,Rate\n001,A\n001,B"));
    const lookup = runOperation(
      current.table,
      { kind: "lookup", sourceId: duplicateReference.id, keys: [["id", "id"]], columns: [["status", "rate"]] },
      [current, duplicateReference],
    );
    expect(lookup.blocked).toBe(true);
    expect(lookup.table).toEqual(current.table);
  });

  it("enforces aggregate source-count and row limits before operations", async () => {
    const small = await importInput(csv("small.csv", "ID\n1"));
    const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...small, id: `source-${index}` }));
    expect(runOperation(small.table, { kind: "trim", columns: ["id"] }, tooMany).blocked).toBe(true);
    const manyRows = (value: string) => `ID\n${Array.from({ length: 5_001 }, () => value).join("\n")}`;
    const left = await importInput(csv("left.csv", manyRows("a")));
    const right = await importInput(csv("right.csv", manyRows("b")));
    const output = runOperation(left.table, { kind: "trim", columns: ["id"] }, [left, right]);
    expect(output.blocked).toBe(true);
    expect(output.changes.some((change) => /together may not exceed 10,000/.test(change.message ?? ""))).toBe(true);
  });
});
