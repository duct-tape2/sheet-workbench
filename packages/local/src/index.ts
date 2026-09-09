import { zipSync, strToU8 } from "fflate";
import Papa from "papaparse";
import {
  exportWorkbook,
  importWorkbook,
  inspectWorkbook,
} from "../../xlsx/src/index.ts";
import { parseDate } from "../../core/src/index.ts";
import type { CellValue, Dataset } from "../../core/src/types.ts";
import type {
  Change,
  Column,
  InputFile,
  LocalRow,
  Operation,
  OperationResult,
  Origin,
  Recipe,
  Selection,
  SourceDocument,
  TableData,
} from "./types.ts";

export * from "./types.ts";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 100;
const MAX_SOURCES = 10;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(message: string): never {
  throw new Error(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      bytes.slice().buffer as ArrayBuffer,
    );
    return [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }
  // This fallback only creates a stable local identifier. It is not used as a
  // security boundary or a content-integrity claim.
  return `${stableHash(String.fromCharCode(...bytes.slice(0, 16_384)))}-${bytes.length}`;
}

function copyValue(value: CellValue): CellValue {
  return value;
}

function copyOrigin(origin: Origin): Origin {
  return { ...origin };
}

function copyRow(row: LocalRow): LocalRow {
  return {
    id: row.id,
    values: { ...row.values },
    origins: row.origins.map(copyOrigin),
    ...(row.locked?.length ? { locked: [...row.locked] } : {}),
  };
}

function cloneTable(table: TableData): TableData {
  return {
    id: table.id,
    name: table.name,
    columns: table.columns.map((column) => ({ ...column })),
    rows: table.rows.map(copyRow),
  };
}

function assertTable(table: TableData): void {
  if (!plainObject(table) || !SAFE_ID.test(table.id)) fail("Invalid table ID.");
  if (typeof table.name !== "string" || !table.name.trim() || table.name.length > 160)
    fail("Invalid table name.");
  if (!Array.isArray(table.columns) || !table.columns.length || table.columns.length > MAX_COLUMNS)
    fail("Use 1–100 columns.");
  if (!Array.isArray(table.rows) || table.rows.length > MAX_ROWS)
    fail("Use at most 10,000 rows.");
  const keys = new Set<string>();
  for (const column of table.columns) {
    if (
      !plainObject(column) ||
      typeof column.key !== "string" ||
      !SAFE_ID.test(column.key) ||
      FORBIDDEN_KEYS.has(column.key) ||
      typeof column.label !== "string" ||
      !column.label.trim() ||
      !["text", "number", "date", "boolean"].includes(column.type) ||
      keys.has(column.key)
    )
      fail("Columns must have unique safe keys, labels, and supported types.");
    keys.add(column.key);
  }
  const ids = new Set<string>();
  for (const row of table.rows) {
    if (!plainObject(row) || !SAFE_ID.test(row.id) || ids.has(row.id))
      fail("Rows need unique stable IDs.");
    ids.add(row.id);
    if (!plainObject(row.values) || !Array.isArray(row.origins))
      fail("Rows need values and origins.");
    if (Object.keys(row.values).some((key) => !keys.has(key)))
      fail("A row contains an unknown column.");
    for (const value of Object.values(row.values)) {
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      )
        fail("Cell values must be scalar values.");
      if (typeof value === "number" && !Number.isFinite(value))
        fail("Cell numbers must be finite.");
    }
    if (
      row.locked &&
      (!Array.isArray(row.locked) ||
        row.locked.some((key) => !keys.has(key)) ||
        new Set(row.locked).size !== row.locked.length)
    )
      fail("Locked fields must be imported columns.");
  }
}

function assertSources(sources: SourceDocument[]): void {
  if (!Array.isArray(sources)) fail("Sources are required.");
  if (sources.length > MAX_SOURCES) fail("Use at most 10 local sources.");
  const ids = new Set<string>();
  let bytes = 0;
  let rows = 0;
  for (const source of sources) {
    if (!plainObject(source) || !SAFE_ID.test(source.id) || ids.has(source.id))
      fail("Sources need unique stable IDs.");
    ids.add(source.id);
    if (!(source.bytes instanceof Uint8Array) || source.size !== source.bytes.length)
      fail("Source bytes are invalid.");
    bytes += source.size;
    if (source.size > MAX_BYTES || bytes > MAX_BYTES)
      fail("Imported source files together may not exceed 25 MiB.");
    assertTable(source.table);
    rows += source.table.rows.length;
    if (rows > MAX_ROWS)
      fail("Imported source rows together may not exceed 10,000.");
  }
}

function safeColumnKey(label: string, index: number, used: Set<string>): string {
  let key = label
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    // Local table IDs intentionally stay ASCII. Labels remain lossless, while
    // non-Latin labels receive a stable position-based key below.
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key || FORBIDDEN_KEYS.has(key)) key = `column_${index + 1}`;
  if (!/^[A-Za-z0-9]/.test(key)) key = `column_${key}`;
  key = key.slice(0, 120);
  const base = key;
  let count = 2;
  while (used.has(key) || !SAFE_ID.test(key)) key = `${base.slice(0, 130)}_${count++}`;
  used.add(key);
  return key;
}

function selectionIdentity(selection: Selection): string {
  return JSON.stringify({
    sheetName: selection.sheetName ?? "",
    headerRow: selection.headerRow ?? 0,
    startColumn: selection.startColumn ?? 0,
    endColumn: selection.endColumn ?? 0,
    endRow: selection.endRow ?? 0,
    encoding: (selection.encoding ?? "utf-8").toLocaleLowerCase(),
    delimiter: selection.delimiter ?? ",",
  });
}

/**
 * A recipe describes the table shape, not a fixed last data row. A later
 * monthly file may legitimately extend `endRow`; sheet/header/column changes
 * remain a hard replay boundary.
 */
function recipeSelectionIdentity(selection: Selection): string {
  const requestedEncoding = (selection.encoding ?? "utf-8").toLocaleLowerCase();
  const encoding =
    requestedEncoding === "utf8"
      ? "utf-8"
      : requestedEncoding === "cp949"
        ? "euc-kr"
        : requestedEncoding;
  return JSON.stringify({
    sheetName: selection.sheetName ?? "",
    headerRow: selection.headerRow ?? 0,
    startColumn: selection.startColumn ?? 0,
    endColumn: selection.endColumn ?? 0,
    encoding,
    delimiter: selection.delimiter ?? ",",
  });
}

function validRecipeSelection(value: unknown): value is Selection {
  if (!plainObject(value)) return false;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "sheetName",
          "headerRow",
          "startColumn",
          "endColumn",
          "endRow",
          "encoding",
          "delimiter",
        ].includes(key),
    )
  )
    return false;
  if (
    (value.sheetName !== undefined &&
      (typeof value.sheetName !== "string" || !value.sheetName.trim() || value.sheetName.length > 200)) ||
    [value.headerRow, value.startColumn, value.endColumn, value.endRow].some(
      (coordinate) =>
        coordinate !== undefined &&
        (typeof coordinate !== "number" ||
          !Number.isInteger(coordinate) ||
          coordinate < 1),
    ) ||
    (value.encoding !== undefined &&
      (typeof value.encoding !== "string" ||
        !["utf-8", "utf8", "euc-kr", "windows-949", "cp949"].includes(
          value.encoding.toLocaleLowerCase(),
        ))) ||
    (value.delimiter !== undefined &&
      (typeof value.delimiter !== "string" || value.delimiter.length !== 1))
  )
    return false;
  const headerRow = value.headerRow as number | undefined;
  const startColumn = value.startColumn as number | undefined;
  const endColumn = value.endColumn as number | undefined;
  const endRow = value.endRow as number | undefined;
  const coordinates = [headerRow, startColumn, endColumn, endRow];
  const hasCoordinates = coordinates.some((coordinate) => coordinate !== undefined);
  if (
    hasCoordinates &&
    (!value.sheetName ||
      coordinates.some((coordinate) => coordinate === undefined) ||
      startColumn! > endColumn! ||
      headerRow! >= endRow! ||
      endColumn! - startColumn! + 1 > MAX_COLUMNS ||
      endRow! - headerRow! > MAX_ROWS)
  )
    return false;
  return true;
}

function csvDelimiter(selection: Selection): string {
  if (selection.delimiter === undefined) return ",";
  if (typeof selection.delimiter !== "string" || selection.delimiter.length !== 1)
    fail("CSV delimiter must be one character.");
  return selection.delimiter;
}

function decodeCsv(bytes: Uint8Array, selection: Selection): string {
  const requested = (selection.encoding ?? "utf-8").toLocaleLowerCase();
  const encoding = requested === "cp949" ? "euc-kr" : requested;
  if (!["utf-8", "utf8", "euc-kr", "windows-949", "cp949"].includes(requested))
    fail("Choose UTF-8 or CP949 explicitly for CSV input.");
  try {
    let text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch {
    fail("The CSV does not match its selected encoding.");
  }
}

/**
 * Papa Parse runs inside our existing local worker. It deliberately keeps all
 * cells as strings: no dynamic typing, date inference, or nested worker.
 */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let parseError: Papa.ParseError | undefined;
  let overLimit = false;
  Papa.parse<string[]>(text, {
    delimiter,
    download: false,
    dynamicTyping: false,
    worker: false,
    skipEmptyLines: false,
    step: (chunk, parser) => {
      if (chunk.errors.length) {
        parseError = chunk.errors[0];
        parser.abort();
        return;
      }
      rows.push(chunk.data.map((cell) => String(cell)));
      // Header plus at most 10,000 source rows. Abort before retaining an
      // unbounded result, including a CSV made only of blank lines.
      if (rows.length > MAX_ROWS + 1) {
        overLimit = true;
        parser.abort();
      }
    },
  });
  if (parseError)
    fail(`CSV parse error (${parseError.code}): ${parseError.message}`);
  if (overLimit) fail("CSV exceeds the 10,000-row local limit.");
  return rows;
}

function csvInspection(bytes: Uint8Array, selection: Selection) {
  const rows = parseCsv(decodeCsv(bytes, selection), csvDelimiter(selection));
  let maxColumn = 0;
  for (const row of rows) maxColumn = Math.max(maxColumn, row.length);
  const candidates = rows
    .map((values, index) => ({ row: index + 1, values }))
    .filter(({ values }) => values.some((value) => value !== ""))
    .sort(
      (left, right) =>
        right.values.filter(Boolean).length - left.values.filter(Boolean).length ||
        left.row - right.row,
    )
    .slice(0, 5);
  const header = candidates[0];
  return {
    rows,
    maxColumn,
    headerCandidates: candidates,
    suggestedSelection: header
      ? {
          sheetName: "CSV",
          headerRow: header.row,
          startColumn: 1,
          endColumn: Math.max(1, header.values.length),
          endRow: rows.length,
        }
      : undefined,
  };
}

function isXlsx(file: InputFile): boolean {
  return /\.xlsx$/i.test(file.name);
}

function assertInput(file: InputFile): void {
  if (!plainObject(file) || typeof file.name !== "string" || !file.name.trim())
    fail("Input file needs a name.");
  if (!(file.bytes instanceof Uint8Array)) fail("Input file bytes are required.");
  if (file.bytes.length > MAX_BYTES) fail("Input file exceeds the 25 MiB limit.");
}

export async function inspectInput(file: InputFile): Promise<{
  sheets: Array<{
    name: string;
    rowCount: number;
    maxColumn: number;
    headerCandidates: Array<{ row: number; values: string[] }>;
  }>;
  suggestedSelection?: Selection;
}> {
  assertInput(file);
  if (isXlsx(file)) {
    const inspected = inspectWorkbook(file.bytes);
    return {
      sheets: inspected.sheets.map((sheet) => ({
        name: sheet.name,
        rowCount: sheet.rowCount,
        maxColumn: sheet.maxColumn,
        headerCandidates: sheet.headerCandidates,
      })),
      suggestedSelection: inspected.suggestedSelection,
    };
  }
  const inspected = csvInspection(file.bytes, {});
  return {
    sheets: [
      {
        name: "CSV",
        rowCount: inspected.rows.length,
        maxColumn: inspected.maxColumn,
        headerCandidates: inspected.headerCandidates,
      },
    ],
    suggestedSelection: inspected.suggestedSelection,
  };
}

function xlsxColumnLabel(column: number): string {
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function sourceTableFromXlsx(
  sourceId: string,
  file: InputFile,
  selection: Selection,
): TableData {
  const dataset = importWorkbook(file.bytes, {
    sheetName: selection.sheetName,
    headerRow: selection.headerRow,
    startColumn: selection.startColumn,
    endColumn: selection.endColumn,
    endRow: selection.endRow,
    fileName: file.name,
  });
  const used = new Set<string>();
  const columns: Column[] = dataset.fields.map((field, index) => ({
    key: safeColumnKey(field.label, index, used),
    label: field.label,
    type:
      field.type === "number" || field.type === "date"
        ? field.type
        : "text",
  }));
  const byXlsxKey = new Map(
    dataset.fields.map((field, index) => [field.key, columns[index].key]),
  );
  const rows: LocalRow[] = dataset.records.map((record) => ({
    id: `${sourceId}:r-${record.sourceRow}`,
    values: Object.fromEntries(
      Object.entries(record.values).map(([key, value]) => [
        byXlsxKey.get(key)!,
        copyValue(value),
      ]),
    ),
    origins: [
      {
        sourceId,
        sheet: dataset.source.sheetName,
        row: record.sourceRow!,
      },
    ],
    ...(record.lockedFields?.length
      ? { locked: record.lockedFields.map((key) => byXlsxKey.get(key)!) }
      : {}),
  }));
  return { id: `table-${sourceId}`, name: dataset.name, columns, rows };
}

function sourceTableFromCsv(
  sourceId: string,
  file: InputFile,
  selection: Selection,
): TableData {
  if (selection.sheetName !== undefined && selection.sheetName !== "CSV")
    fail("CSV input has one sheet named CSV.");
  const inspected = csvInspection(file.bytes, selection);
  const headerRow = selection.headerRow ?? inspected.suggestedSelection?.headerRow;
  const startColumn = selection.startColumn ?? 1;
  const endColumn = selection.endColumn ?? inspected.maxColumn;
  const endRow = selection.endRow ?? inspected.rows.length;
  if (
    !Number.isInteger(headerRow) ||
    !headerRow ||
    !Number.isInteger(startColumn) ||
    !Number.isInteger(endColumn) ||
    !Number.isInteger(endRow) ||
    startColumn < 1 ||
    endColumn < startColumn ||
    endColumn > MAX_COLUMNS ||
    headerRow < 1 ||
    endRow <= headerRow ||
    endRow > inspected.rows.length
  )
    fail("Selected CSV range is invalid.");
  if (endRow - headerRow > MAX_ROWS) fail("CSV selection exceeds 10,000 rows.");
  const used = new Set<string>();
  const headers = inspected.rows[headerRow - 1] ?? [];
  const columns: Column[] = Array.from(
    { length: endColumn - startColumn + 1 },
    (_, index) => {
      const column = startColumn + index;
      const label = headers[column - 1]?.trim() || `Column ${column}`;
      return { key: safeColumnKey(label, index, used), label, type: "text" };
    },
  );
  const rows: LocalRow[] = [];
  for (let row = headerRow + 1; row <= endRow; row += 1) {
    const raw = inspected.rows[row - 1] ?? [];
    const values = Object.fromEntries(
      columns.map((column, index) => [column.key, raw[startColumn - 1 + index] ?? ""]),
    ) as Record<string, CellValue>;
    if (Object.values(values).every((value) => value === "")) continue;
    rows.push({
      id: `${sourceId}:CSV:${row}`,
      values,
      origins: [{ sourceId, sheet: "CSV", row }],
    });
  }
  return { id: `table-${sourceId}`, name: file.name.replace(/\.[^.]+$/, ""), columns, rows };
}

export async function importInput(
  file: InputFile,
  selection: Selection = {},
): Promise<SourceDocument> {
  assertInput(file);
  const defaults = isXlsx(file)
    ? inspectWorkbook(file.bytes).suggestedSelection
    : csvInspection(file.bytes, selection).suggestedSelection;
  const resolvedSelection: Selection = {
    ...selection,
    sheetName: selection.sheetName ?? defaults?.sheetName,
    headerRow: selection.headerRow ?? defaults?.headerRow,
    startColumn: selection.startColumn ?? defaults?.startColumn,
    endColumn: selection.endColumn ?? defaults?.endColumn,
    endRow: selection.endRow ?? defaults?.endRow,
  };
  if (
    !Number.isInteger(resolvedSelection.headerRow) ||
    !Number.isInteger(resolvedSelection.startColumn) ||
    !Number.isInteger(resolvedSelection.endColumn) ||
    !Number.isInteger(resolvedSelection.endRow) ||
    resolvedSelection.endRow! - resolvedSelection.headerRow! > MAX_ROWS ||
    resolvedSelection.endColumn! - resolvedSelection.startColumn! + 1 > MAX_COLUMNS
  )
    fail("Selected range exceeds the 10,000-row or 100-column local limit.");
  const hash = await sha256(file.bytes);
  // A source is the selected rectangle, not merely its containing bytes. This
  // lets the same workbook contribute two independently replayable sheets.
  const id = `source-${hash.slice(0, 24)}-${stableHash(`${isXlsx(file) ? "xlsx" : "csv"}|${selectionIdentity(resolvedSelection)}`)}`;
  const table = isXlsx(file)
    ? sourceTableFromXlsx(id, file, resolvedSelection)
    : sourceTableFromCsv(id, file, resolvedSelection);
  assertTable(table);
  if (table.rows.length > MAX_ROWS || table.columns.length > MAX_COLUMNS)
    fail("Imported result exceeds local limits.");
  return {
    id,
    name: file.name,
    hash,
    size: file.bytes.length,
    importedAt: new Date().toISOString(),
    selection: resolvedSelection,
    table: cloneTable(table),
    bytes: file.bytes.slice(),
    format: isXlsx(file) ? "xlsx" : "csv",
  };
}

function result(table: TableData, changes: Change[] = [], warnings: string[] = []): OperationResult {
  assertTable(table);
  return { table: cloneTable(table), changes: changes.map((change) => ({ ...change })), warnings, blocked: false };
}

function blocked(table: TableData, message: string, changes: Change[] = []): OperationResult {
  return {
    table: cloneTable(table),
    changes: [...changes, { rowId: "operation", kind: "conflict", message }],
    warnings: [],
    blocked: true,
  };
}

function findSource(sources: SourceDocument[], sourceId: string): SourceDocument {
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) fail("Selected source is unavailable.");
  return source;
}

function columnMap(table: TableData): Map<string, Column> {
  return new Map(table.columns.map((column) => [column.key, column]));
}

function requireColumns(table: TableData, keys: string[]): void {
  const existing = columnMap(table);
  if (!keys.length || keys.some((key) => !existing.has(key)))
    fail("Select existing columns explicitly.");
}

function lockedChanges(table: TableData, rowIds: Iterable<string>, columns: string[]): Change[] {
  const selected = new Set(rowIds);
  return table.rows.flatMap((row) =>
    selected.has(row.id)
      ? (row.locked ?? [])
          .filter((column) => columns.includes(column))
          .map((column) => ({
            rowId: row.id,
            column,
            kind: "conflict" as const,
            message: "Formula-derived cells are read-only.",
          }))
      : [],
  );
}

function typedKey(value: CellValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  return `boolean:${value}`;
}

function keyFor(row: LocalRow, keys: string[]): string {
  return keys.map((key) => typedKey(row.values[key] ?? null)).join("|");
}

function keyIsEmpty(row: LocalRow, keys: string[]): boolean {
  return keys.some((key) => row.values[key] === null || row.values[key] === "");
}

function comparisonIndex(
  table: TableData,
  keys: string[],
  side: string,
): { index?: Map<string, LocalRow>; conflicts: Change[] } {
  const index = new Map<string, LocalRow>();
  const conflicts: Change[] = [];
  for (const row of table.rows) {
    if (keyIsEmpty(row, keys)) {
      conflicts.push({ rowId: row.id, kind: "conflict", message: `${side} contains an empty comparison key.` });
      continue;
    }
    const signature = keyFor(row, keys);
    const prior = index.get(signature);
    if (prior) {
      conflicts.push(
        { rowId: prior.id, kind: "conflict", message: `${side} contains duplicate comparison keys.` },
        { rowId: row.id, kind: "conflict", message: `${side} contains duplicate comparison keys.` },
      );
    } else index.set(signature, row);
  }
  return { index: conflicts.length ? undefined : index, conflicts };
}

function decimal(value: CellValue): { digits: bigint; scale: number } | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    value = String(value);
  }
  if (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const normalized = value.trim();
  const sign = normalized.startsWith("-") ? -1n : 1n;
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  return { digits: sign * BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function equalDecimal(
  left: { digits: bigint; scale: number },
  right: { digits: bigint; scale: number },
): boolean {
  const scale = Math.max(left.scale, right.scale);
  return (
    left.digits * 10n ** BigInt(scale - left.scale) ===
    right.digits * 10n ** BigInt(scale - right.scale)
  );
}

function decimalSum(values: CellValue[]): string | undefined {
  const parsed = values.map(decimal);
  if (parsed.some((value) => !value)) return undefined;
  const scale = Math.max(...parsed.map((value) => value!.scale));
  let total = 0n;
  for (const value of parsed) total += value!.digits * 10n ** BigInt(scale - value!.scale);
  const sign = total < 0n ? "-" : "";
  const raw = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  if (!scale) return `${sign}${raw}`;
  const whole = raw.slice(0, -scale);
  const fractional = raw.slice(-scale).replace(/0+$/, "");
  return fractional ? `${sign}${whole}.${fractional}` : `${sign}${whole}`;
}

function transformedRow(row: LocalRow, values: Record<string, CellValue>): LocalRow {
  return { ...copyRow(row), values };
}

function operationError(table: TableData, error: unknown): OperationResult {
  return blocked(table, error instanceof Error ? error.message : "Operation could not be completed safely.");
}

/** Apply a declarative operation without mutating the input table or sources. */
export function runOperation(
  table: TableData,
  operation: Operation,
  sources: SourceDocument[],
): OperationResult {
  try {
    assertTable(table);
    assertSources(sources);
    const current = cloneTable(table);
    if (!isOperation(operation))
      fail("Choose a supported operation.");

    if (operation.kind === "trim") {
      requireColumns(current, operation.columns);
      const matching = current.rows.filter((row) =>
        operation.columns.some((column) => typeof row.values[column] === "string" && row.values[column] !== row.values[column]!.trim()),
      );
      const locks = lockedChanges(current, matching.map((row) => row.id), operation.columns);
      if (locks.length) return blocked(current, "Formula-derived cells cannot be trimmed.", locks);
      const changes: Change[] = [];
      const rows = current.rows.map((row) => {
        const values = { ...row.values };
        for (const column of operation.columns) {
          const before = values[column];
          if (typeof before === "string") {
            const after = before.trim();
            if (before !== after) {
              values[column] = after;
              changes.push({ rowId: row.id, column, before, after, kind: "changed" });
            }
          }
        }
        return transformedRow(row, values);
      });
      return result({ ...current, rows }, changes);
    }

    if (operation.kind === "blankRows") {
      const remove = current.rows.filter((row) =>
        current.columns.every((column) => {
          const value = row.values[column.key];
          return value === null || (typeof value === "string" && value.trim() === "");
        }),
      );
      const locks = lockedChanges(
        current,
        remove.map((row) => row.id),
        current.columns.map((column) => column.key),
      );
      if (locks.length) return blocked(current, "Formula-derived rows cannot be removed.", locks);
      const removed = new Set(remove.map((row) => row.id));
      return result(
        { ...current, rows: current.rows.filter((row) => !removed.has(row.id)) },
        remove.map((row) => ({ rowId: row.id, kind: "removed", message: "Blank row removed." })),
      );
    }

    if (operation.kind === "dedupe") {
      requireColumns(current, operation.keys);
      const seen = new Set<string>();
      const remove: LocalRow[] = [];
      for (const row of current.rows) {
        const signature = keyFor(row, operation.keys);
        if (seen.has(signature)) remove.push(row);
        else seen.add(signature);
      }
      const locks = lockedChanges(
        current,
        remove.map((row) => row.id),
        current.columns.map((column) => column.key),
      );
      if (locks.length) return blocked(current, "Formula-derived rows cannot be removed.", locks);
      const removed = new Set(remove.map((row) => row.id));
      return result(
        { ...current, rows: current.rows.filter((row) => !removed.has(row.id)) },
        remove.map((row) => ({ rowId: row.id, kind: "removed", message: "Duplicate removed; first occurrence kept." })),
      );
    }

    if (operation.kind === "replace") {
      requireColumns(current, [operation.column]);
      if (typeof operation.from !== "string" || typeof operation.to !== "string" || operation.from === "")
        fail("Replacement text must be non-empty and explicit.");
      const matching = current.rows.filter((row) => {
        const value = row.values[operation.column];
        return typeof value === "string" && value.includes(operation.from);
      });
      const locks = lockedChanges(current, matching.map((row) => row.id), [operation.column]);
      if (locks.length) return blocked(current, "Formula-derived cells cannot be replaced.", locks);
      const changes: Change[] = [];
      const rows = current.rows.map((row) => {
        const before = row.values[operation.column];
        if (typeof before !== "string" || !before.includes(operation.from)) return copyRow(row);
        const after = before.split(operation.from).join(operation.to);
        changes.push({ rowId: row.id, column: operation.column, before, after, kind: "changed" });
        return transformedRow(row, { ...row.values, [operation.column]: after });
      });
      return result({ ...current, rows }, changes);
    }

    if (operation.kind === "convert") {
      requireColumns(current, [operation.column]);
      const converted = new Map<string, CellValue>();
      for (const row of current.rows) {
        const before = row.values[operation.column];
        if (before === null || before === "") {
          converted.set(row.id, before);
          continue;
        }
        let after: CellValue;
        if (operation.to === "text") after = String(before);
        else if (operation.to === "number") {
          const parsed = decimal(before);
          if (!parsed) fail(`Row ${row.id} is not an explicit decimal number.`);
          const number = Number(String(before).trim());
          if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
            fail(`Row ${row.id} cannot be converted without losing numeric precision.`);
          const roundTripped = decimal(String(number));
          if (!roundTripped || !equalDecimal(parsed, roundTripped))
            fail(`Row ${row.id} cannot be converted without losing decimal precision.`);
          after = number;
        } else {
          if (typeof before !== "string") fail(`Row ${row.id} is not a text date.`);
          const isAmbiguous = /^\d{1,2}[-./]\d{1,2}[-./]\d{4}$/.test(before.trim());
          if (isAmbiguous && !operation.dateOrder)
            fail("Ambiguous dates require an explicit date order.");
          const date = parseDate(before, operation.dateOrder ?? "ymd");
          if (!date) fail(`Row ${row.id} is not a real date in the selected format.`);
          after = date;
        }
        converted.set(row.id, after);
      }
      const changedRows = current.rows.filter((row) => converted.get(row.id) !== row.values[operation.column]);
      const locks = lockedChanges(current, changedRows.map((row) => row.id), [operation.column]);
      if (locks.length) return blocked(current, "Formula-derived cells cannot be converted.", locks);
      const changes: Change[] = [];
      const rows = current.rows.map((row) => {
        const before = row.values[operation.column];
        const after = converted.get(row.id)!;
        if (before === after) return copyRow(row);
        changes.push({ rowId: row.id, column: operation.column, before, after, kind: "changed" });
        return transformedRow(row, { ...row.values, [operation.column]: after });
      });
      const columns = current.columns.map((column) =>
        column.key === operation.column ? { ...column, type: operation.to } : { ...column },
      );
      return result({ ...current, columns, rows }, changes);
    }

    if (operation.kind === "append") {
      const other = findSource(sources, operation.sourceId);
      if (!plainObject(operation.mapping) || !Object.keys(operation.mapping).length)
        fail("Append needs at least one explicit mapping.");
      requireColumns(current, Object.keys(operation.mapping));
      requireColumns(other.table, Object.values(operation.mapping));
      const rows = [...current.rows.map(copyRow)];
      const changes: Change[] = [];
      for (const otherRow of other.table.rows) {
        const values = Object.fromEntries(current.columns.map((column) => [column.key, null])) as Record<string, CellValue>;
        const locks: string[] = [];
        for (const [target, source] of Object.entries(operation.mapping)) {
          values[target] = copyValue(otherRow.values[source] ?? null);
          if (otherRow.locked?.includes(source)) locks.push(target);
        }
        const base = `row-${stableHash(`${otherRow.id}|${JSON.stringify(operation.mapping)}`)}`;
        let id = base;
        let count = 2;
        while (rows.some((row) => row.id === id)) id = `${base}-${count++}`;
        rows.push({
          id,
          values,
          origins: otherRow.origins.map(copyOrigin),
          ...(locks.length ? { locked: [...new Set(locks)] } : {}),
        });
        changes.push({ rowId: id, kind: "added", message: `Appended from ${other.name}.` });
      }
      return result({ ...current, rows }, changes);
    }

    if (operation.kind === "lookup" || operation.kind === "compare") {
      const other = findSource(sources, operation.sourceId);
      if (!Array.isArray(operation.keys) || !operation.keys.length || !Array.isArray(operation.columns))
        fail("Comparison needs explicit key and column pairs.");
      const primaryKeys = operation.keys.map((pair) => pair[0]);
      const otherKeys = operation.keys.map((pair) => pair[1]);
      const primaryColumns = operation.columns.map((pair) => pair[0]);
      const otherColumns = operation.columns.map((pair) => pair[1]);
      if (
        operation.keys.some((pair) => !Array.isArray(pair) || pair.length !== 2) ||
        operation.columns.some((pair) => !Array.isArray(pair) || pair.length !== 2)
      )
        fail("Keys and columns must be two-column pairs.");
      const duplicatePair = (pairs: Array<[string, string]>) =>
        new Set(pairs.map(([left, right]) => `${left}\u0000${right}`)).size !==
        pairs.length;
      if (duplicatePair(operation.keys) || duplicatePair(operation.columns))
        fail("Duplicate key or column mapping pairs are not permitted.");
      requireColumns(current, [...primaryKeys, ...primaryColumns]);
      requireColumns(other.table, [...otherKeys, ...otherColumns]);
      const primaryIndex = comparisonIndex(current, primaryKeys, "Current table");
      const otherIndex = comparisonIndex(other.table, otherKeys, other.name);
      const conflicts = [...primaryIndex.conflicts, ...otherIndex.conflicts];
      if (conflicts.length || !primaryIndex.index || !otherIndex.index)
        return blocked(current, "Empty or duplicate comparison keys block this operation.", conflicts);

      if (operation.kind === "lookup") {
        const used = new Set(current.columns.map((column) => column.key));
        const addedColumns: Column[] = [];
        const mappedColumns: Array<{ otherColumn: string; target: string }> = [];
        for (const key of otherColumns) {
          const sourceColumn = columnMap(other.table).get(key)!;
          const target = safeColumnKey(`${other.name}_${sourceColumn.label}`, current.columns.length + addedColumns.length, used);
          mappedColumns.push({ otherColumn: key, target });
          addedColumns.push({ ...sourceColumn, key: target, label: `${other.name}: ${sourceColumn.label}` });
        }
        const changes: Change[] = [];
        const rows = current.rows.map((row) => {
          const match = otherIndex.index!.get(keyFor(row, primaryKeys));
          const values = { ...row.values };
          const locks = new Set(row.locked ?? []);
          for (const { otherColumn, target } of mappedColumns) {
            const after = match ? copyValue(match.values[otherColumn] ?? null) : null;
            values[target] = after;
            if (match?.locked?.includes(otherColumn)) locks.add(target);
            if (match)
              changes.push({ rowId: row.id, column: target, before: null, after, kind: "changed" });
          }
          const next = transformedRow(row, values);
          if (locks.size) next.locked = [...locks];
          return next;
        });
        return result({ ...current, columns: [...current.columns, ...addedColumns], rows }, changes);
      }

      const changes: Change[] = [];
      const matched = new Set<string>();
      for (const row of current.rows) {
        const match = otherIndex.index.get(keyFor(row, primaryKeys));
        if (!match) {
          changes.push({ rowId: row.id, kind: "removed", message: "No matching row in compared source." });
          continue;
        }
        matched.add(match.id);
        for (const [primaryColumn, otherColumn] of operation.columns) {
          const before = row.values[primaryColumn] ?? null;
          const after = match.values[otherColumn] ?? null;
          changes.push({
            rowId: row.id,
            column: primaryColumn,
            before,
            after,
            kind: typedKey(before) === typedKey(after) ? "same" : "changed",
            ...(typedKey(before) === typedKey(after) ? {} : { message: `Compared with ${other.name}.` }),
          });
        }
      }
      for (const row of other.table.rows)
        if (!matched.has(row.id))
          changes.push({ rowId: row.id, kind: "added", message: `Only in ${other.name}.` });
      return result(current, changes);
    }

    if (operation.kind === "summary") {
      requireColumns(current, [...operation.groups, ...operation.sums]);
      const groups = new Map<string, LocalRow[]>();
      for (const row of current.rows) {
        const key = keyFor(row, operation.groups);
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const used = new Set(operation.groups);
      const columns: Column[] = [
        ...operation.groups.map((key) => ({ ...columnMap(current).get(key)! })),
        ...operation.sums.map((key, index) => {
          const source = columnMap(current).get(key)!;
          return {
            key: safeColumnKey(`${source.key}_sum`, index, used),
            label: `${source.label} sum`,
            type: "number" as const,
          };
        }),
      ];
      const warnings: string[] = [];
      const rows: LocalRow[] = [];
      for (const [signature, members] of groups) {
        const values: Record<string, CellValue> = {};
        operation.groups.forEach((key) => (values[key] = copyValue(members[0].values[key] ?? null)));
        operation.sums.forEach((key, index) => {
          const target = columns[operation.groups.length + index].key;
          const sum = decimalSum(members.map((member) => member.values[key] ?? null));
          if (sum === undefined) {
            values[target] = null;
            warnings.push(`${columnMap(current).get(key)!.label}: non-decimal values were not summed for one group.`);
          } else values[target] = sum;
        });
        const base = `summary-${stableHash(`${current.id}|${signature}`)}`;
        let id = base;
        let count = 2;
        while (rows.some((row) => row.id === id)) id = `${base}-${count++}`;
        rows.push({
          id,
          values,
          origins: members.flatMap((member) => member.origins.map(copyOrigin)),
        });
      }
      return result(
        { id: `summary-${stableHash(current.id)}`, name: `${current.name} summary`, columns, rows },
        rows.map((row) => ({ rowId: row.id, kind: "added", message: "Summary row created." })),
        [...new Set(warnings)],
      );
    }

    return blocked(current, "Unsupported operation.");
  } catch (error) {
    return operationError(table, error);
  }
}

function isOperation(value: unknown): value is Operation {
  if (!plainObject(value) || typeof value.kind !== "string") return false;
  const only = (...keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const strings = (values: unknown) => Array.isArray(values) && values.every((item) => typeof item === "string" && SAFE_ID.test(item));
  const pairs = (values: unknown) =>
    Array.isArray(values) &&
    values.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === "string" && SAFE_ID.test(item)));
  switch (value.kind) {
    case "trim": return only("kind", "columns") && strings(value.columns);
    case "blankRows": return Object.keys(value).length === 1;
    case "dedupe": return only("kind", "keys") && strings(value.keys);
    case "replace": return only("kind", "column", "from", "to") && typeof value.column === "string" && SAFE_ID.test(value.column) && typeof value.from === "string" && typeof value.to === "string";
    case "convert": return only("kind", "column", "to", "dateOrder") && typeof value.column === "string" && SAFE_ID.test(value.column) && ["number", "date", "text"].includes(String(value.to)) && (value.dateOrder === undefined || ["ymd", "dmy", "mdy"].includes(String(value.dateOrder)));
    case "append": return only("kind", "sourceId", "mapping") && typeof value.sourceId === "string" && SAFE_ID.test(value.sourceId) && plainObject(value.mapping) && Object.entries(value.mapping).every(([key, target]) => SAFE_ID.test(key) && typeof target === "string" && SAFE_ID.test(target));
    case "compare":
    case "lookup": return only("kind", "sourceId", "keys", "columns") && typeof value.sourceId === "string" && SAFE_ID.test(value.sourceId) && pairs(value.keys) && pairs(value.columns);
    case "summary": return only("kind", "groups", "sums") && strings(value.groups) && strings(value.sums);
    default: return false;
  }
}

/** Rejects unknown fields and executable recipe content before anything runs. */
export function validateRecipe(input: unknown): Recipe {
  if (!plainObject(input) || Object.keys(input).some((key) => !["version", "name", "primaryId", "sources", "steps"].includes(key)))
    fail("Recipe shape is invalid.");
  if (input.version !== 1 || typeof input.name !== "string" || !input.name.trim() || input.name.length > 160 || typeof input.primaryId !== "string" || !SAFE_ID.test(input.primaryId) || !Array.isArray(input.sources) || !Array.isArray(input.steps))
    fail("Recipe fields are invalid.");
  const ids = new Set<string>();
  const sources = input.sources.map((source) => {
    if (!plainObject(source) || Object.keys(source).some((key) => !["id", "name", "columns", "selection"].includes(key)) || typeof source.id !== "string" || !SAFE_ID.test(source.id) || ids.has(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 160 || !Array.isArray(source.columns) || !source.columns.length || source.columns.length > MAX_COLUMNS || source.columns.some((column) => typeof column !== "string" || !SAFE_ID.test(column)) || new Set(source.columns).size !== source.columns.length || (source.selection !== undefined && !validRecipeSelection(source.selection)))
      fail("Recipe source schema is invalid.");
    ids.add(source.id);
    return {
      id: source.id,
      name: source.name,
      columns: [...source.columns],
      ...(source.selection === undefined ? {} : { selection: { ...source.selection } }),
    };
  });
  if (!ids.has(input.primaryId) || input.steps.length > 100 || input.steps.some((step) => !isOperation(step)))
    fail("Recipe references unsupported sources or operations.");
  return {
    version: 1,
    name: input.name,
    primaryId: input.primaryId,
    sources,
    steps: input.steps.map((step) => structuredClone(step)),
  };
}

export function replayRecipe(recipe: Recipe, sources: SourceDocument[]): OperationResult {
  try {
    const valid = validateRecipe(recipe);
    assertSources(sources);
    if (sources.length !== valid.sources.length) fail("Recipe source set changed.");
    for (const expected of valid.sources) {
      const actual = sources.find((source) => source.id === expected.id);
      if (!actual || actual.table.columns.map((column) => column.key).join("\u0000") !== expected.columns.join("\u0000") || (expected.selection !== undefined && recipeSelectionIdentity(actual.selection) !== recipeSelectionIdentity(expected.selection)))
        fail("Recipe source schema changed; review its mappings before replaying.");
    }
    const primary = findSource(sources, valid.primaryId);
    let current = cloneTable(primary.table);
    let changes: Change[] = [];
    let warnings: string[] = [];
    for (const step of valid.steps) {
      const next = runOperation(current, step, sources);
      changes = [...changes, ...next.changes];
      warnings = [...warnings, ...next.warnings];
      if (next.blocked) return { table: cloneTable(current), changes, warnings, blocked: true };
      current = next.table;
    }
    return result(current, changes, warnings);
  } catch (error) {
    return operationError(sources.find((source) => source.id === recipe?.primaryId)?.table ?? { id: "invalid", name: "Invalid", columns: [{ key: "value", label: "Value", type: "text" }], rows: [] }, error);
  }
}

function csvCell(value: CellValue): string {
  let text = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** UTF-8 CSV with BOM. CP949 is input-only and must be chosen explicitly. */
export function exportCsv(table: TableData): string {
  assertTable(table);
  return "\uFEFF" + [
    table.columns.map((column) => csvCell(column.label)).join(","),
    ...table.rows.map((row) => table.columns.map((column) => csvCell(row.values[column.key] ?? null)).join(",")),
  ].join("\r\n");
}

function xmlText(value: CellValue): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function xlsxCell(column: number, row: number, value: CellValue): string {
  const reference = `${xlsxColumnLabel(column)}${row}`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

/** Values-only OOXML export: every value is a text cell, never a formula. */
export function exportTableXlsx(table: TableData): Uint8Array {
  assertTable(table);
  const name = table.name.slice(0, 31).replace(/[\\/*?:\[\]]/g, " ") || "Sheet1";
  const rows = [
    `<row r="1">${table.columns.map((column, index) => xlsxCell(index + 1, 1, column.label)).join("")}</row>`,
    ...table.rows.map((row, rowIndex) => `<row r="${rowIndex + 2}">${table.columns.map((column, index) => {
      const value = row.values[column.key] ?? null;
      return value === null ? "" : xlsxCell(index + 1, rowIndex + 2, value);
    }).join("")}</row>`),
  ].join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`),
  };
  const output = zipSync(files, { level: 6 });
  // A generated download must be readable by the same safe import boundary.
  inspectWorkbook(output);
  return output;
}

/**
 * Patch only the same source rows and columns into a single original XLSX.
 * Structural transforms, mixed origins, reordered rows, and formula changes
 * are rejected rather than generating a look-alike workbook.
 */
export function exportOriginal(source: SourceDocument, table: TableData): Uint8Array {
  assertSources([source]);
  assertTable(table);
  if (source.format !== "xlsx") fail("Original-preserving export is available only for XLSX sources.");
  const original = source.table;
  if (
    table.id !== original.id ||
    table.columns.length !== original.columns.length ||
    table.rows.length !== original.rows.length ||
    table.columns.some((column, index) =>
      column.key !== original.columns[index].key ||
      column.label !== original.columns[index].label ||
      column.type !== original.columns[index].type,
    )
  )
    fail("Original export only permits a one-source, non-structural cell patch.");
  for (let index = 0; index < table.rows.length; index += 1) {
    const current = table.rows[index];
    const expected = original.rows[index];
    if (
      current.id !== expected.id ||
      current.origins.length !== 1 ||
      expected.origins.length !== 1 ||
      current.origins[0].sourceId !== source.id ||
      current.origins[0].sourceId !== expected.origins[0].sourceId ||
      current.origins[0].sheet !== expected.origins[0].sheet ||
      current.origins[0].row !== expected.origins[0].row
    )
      fail("Original export rejects deleted, added, mixed-origin, or reordered rows.");
  }
  const dataset = importWorkbook(source.bytes, {
    sheetName: source.selection.sheetName,
    headerRow: source.selection.headerRow,
    startColumn: source.selection.startColumn,
    endColumn: source.selection.endColumn,
    endRow: source.selection.endRow,
    fileName: source.name,
  });
  const fieldForColumn = new Map<string, string>();
  for (let index = 0; index < table.columns.length; index += 1) {
    const excelColumn = (dataset.source.startColumn ?? 1) + index;
    fieldForColumn.set(table.columns[index].key, `xlsx_col_${xlsxColumnLabel(excelColumn)}`);
  }
  const records = dataset.records.map((record, index) => ({
    ...record,
    values: Object.fromEntries(
      Object.entries(record.values).map(([field, value]) => {
        const local = [...fieldForColumn.entries()].find(([, candidate]) => candidate === field)?.[0];
        return [field, local ? copyValue(table.rows[index].values[local] ?? null) : value];
      }),
    ),
  }));
  const patched: Dataset = { ...dataset, records };
  return exportWorkbook(source.bytes, patched);
}

function csvInput(id: string, name: string, text: string): InputFile {
  return { id, name, bytes: new TextEncoder().encode(text) };
}

export async function makeSample(
  kind: "clean" | "append" | "compare",
  locale: "en" | "ko",
): Promise<SourceDocument[]> {
  const korean = locale === "ko";
  if (kind === "clean")
    return [await importInput(csvInput("sample-clean", "cleanup.csv", `${korean ? "이름,도시" : "Name,City"}\n Mina , Seoul\nMina,Seoul\n , `))];
  if (kind === "append")
    return Promise.all([
      importInput(csvInput("sample-primary", "primary.csv", `${korean ? "이름,도시" : "Name,City"}\nMina,Seoul`)),
      importInput(csvInput("sample-other", "incoming.csv", `${korean ? "이름,도시" : "Name,City"}\nJae,Busan`)),
    ]);
  return Promise.all([
    importInput(csvInput("sample-current", "current.csv", `${korean ? "번호,상태" : "ID,Status"}\n001,Open\n002,Done`)),
    importInput(csvInput("sample-compare", "updated.csv", `${korean ? "번호,상태" : "ID,Status"}\n001,Done\n003,Open`)),
  ]);
}
