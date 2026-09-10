import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import type {
  CompanionScalar,
  WorkbookFlags,
  WorkbookProfile,
  WorkbookSheetProfile,
  WorkbookSheetStructure,
} from "./contracts.ts";

const MAX_ZIP_ENTRIES = 1_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_PROFILE_CELLS_PER_SHEET = 5_000;
const MAX_PROFILE_STRUCTURE_ITEMS = 250;
const ADDRESS = /^(?:[A-Z]{1,3})(?:[1-9]\d{0,6})$/;
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

type ZipFiles = Record<string, Uint8Array>;

export interface IndexedCell {
  address: string;
  value: CompanionScalar;
  /** Internal OOXML cell type; error cells are never writable. */
  cellType?: string;
  formula?: string;
  formulaKind?: string;
  /** Internal only; the browser profile never exposes style IDs. */
  style: number;
}

export interface IndexedSheet {
  name: string;
  hidden: boolean;
  xmlPath: string;
  cells: Map<string, IndexedCell>;
}

export interface IndexedWorkbook {
  files: ZipFiles;
  sheets: Map<string, IndexedSheet>;
  profile: WorkbookProfile;
}

function list(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) && typeof candidate === "object",
  );
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["#text"] === "string") return record["#text"];
    if (typeof record["#text"] === "number") return String(record["#text"]);
  }
  return "";
}

function richText(value: unknown): string {
  if (!value || typeof value !== "object") return text(value);
  const record = value as Record<string, unknown>;
  const direct = record.t;
  // `<t>001</t>` and an inline string's direct `<t>` both parse to a scalar,
  // not an object. Do not route that scalar through `list`, which deliberately
  // filters primitives for XML element collections.
  if (direct !== undefined)
    return (Array.isArray(direct) ? direct : [direct]).map(text).join("");
  return list(record.r)
    .map((run) => richText(run))
    .join("");
}

function scalar(
  value: unknown,
  type: string | undefined,
  shared: string[],
): CompanionScalar {
  const raw = text(value);
  if (type === "inlineStr") return richText(value);
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? (shared[index] ?? "") : "";
  }
  if (type === "b") return raw === "1";
  if (type === "str" || type === "e") return raw;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

function uint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length)
    throw new Error("Malformed XLSX ZIP.");
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function uint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length)
    throw new Error("Malformed XLSX ZIP.");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Reject ZIP64/bomb-shaped data before handing bytes to the decompressor. */
function assertSafeZip(bytes: Uint8Array): void {
  if (bytes.length < 22) throw new Error("The upload is not an XLSX ZIP.");
  let end = -1;
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65_557);
    index -= 1
  ) {
    if (uint32(bytes, index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error("The upload is not an XLSX ZIP.");
  const entryCount = uint16(bytes, end + 10);
  const centralSize = uint32(bytes, end + 12);
  const centralOffset = uint32(bytes, end + 16);
  if (
    entryCount > MAX_ZIP_ENTRIES ||
    centralOffset + centralSize > bytes.length ||
    centralOffset + centralSize < centralOffset
  )
    throw new Error("The XLSX ZIP exceeds the companion safety limits.");
  let cursor = centralOffset;
  let total = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (uint32(bytes, cursor) !== 0x02014b50)
      throw new Error("Malformed XLSX ZIP.");
    const uncompressed = uint32(bytes, cursor + 24);
    const nameLength = uint16(bytes, cursor + 28);
    const extraLength = uint16(bytes, cursor + 30);
    const commentLength = uint16(bytes, cursor + 32);
    if (uncompressed === 0xffffffff)
      throw new Error("ZIP64 workbooks are not supported.");
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES)
      throw new Error("The XLSX expands beyond the companion safety limit.");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > centralOffset + centralSize)
      throw new Error("Malformed XLSX ZIP.");
  }
}

function zipFiles(bytes: Uint8Array): ZipFiles {
  assertSafeZip(bytes);
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("The upload is not a readable XLSX workbook.");
  }
}

function source(files: ZipFiles, path: string): string {
  const bytes = files[path];
  if (!bytes) throw new Error("The XLSX workbook is missing required parts.");
  return strFromU8(bytes);
}

function sharedStrings(files: ZipFiles): string[] {
  if (!files["xl/sharedStrings.xml"]) return [];
  const parsed = xml.parse(source(files, "xl/sharedStrings.xml")) as Record<
    string,
    unknown
  >;
  const sst = parsed.sst as Record<string, unknown> | undefined;
  return list(sst?.si).map(richText);
}

function workbookFlags(files: ZipFiles): WorkbookFlags {
  const paths = Object.keys(files).map((path) => path.toLocaleLowerCase("en"));
  return {
    hasVba: paths.some((path) => path.endsWith("vbaproject.bin")),
    hasExternalLinks: paths.some((path) =>
      path.startsWith("xl/externallinks/"),
    ),
    hasPowerQuery: paths.some(
      (path) =>
        path.includes("powerquery") ||
        path.startsWith("xl/querytables/") ||
        path.endsWith("connections.xml"),
    ),
    hasConnections: paths.some((path) => path.endsWith("connections.xml")),
    hasFormulaErrors: false,
  };
}

function unsupportedPackageReasons(files: ZipFiles): string[] {
  const paths = Object.keys(files).map((path) => path.toLocaleLowerCase("en"));
  const reasons: string[] = [];
  if (
    paths.some(
      (path) =>
        path.startsWith("xl/pivottables/") ||
        path.startsWith("xl/pivotcache/") ||
        path.startsWith("xl/model/"),
    )
  )
    reasons.push(
      "Workbooks containing PivotTable, data-model, or pivot-cache parts are not supported.",
    );
  if (
    paths.some(
      (path) =>
        path.startsWith("xl/activex/") ||
        path.startsWith("xl/ctrlprops/") ||
        path.startsWith("xl/embeddings/"),
    )
  )
    reasons.push(
      "Workbooks containing embedded controls or objects are not supported.",
    );
  if (
    paths.some(
      (path) =>
        path.startsWith("customxml/") ||
        path.startsWith("xl/slicers/") ||
        path.startsWith("xl/timelines/"),
    )
  )
    reasons.push(
      "Workbooks containing unsupported advanced package parts are not supported.",
    );
  return reasons;
}

function sheetPaths(
  files: ZipFiles,
): Array<{ name: string; hidden: boolean; xmlPath: string }> {
  const book = xml.parse(source(files, "xl/workbook.xml")) as Record<
    string,
    unknown
  >;
  const workbook = book.workbook as Record<string, unknown> | undefined;
  const sheets = list(
    (workbook?.sheets as Record<string, unknown> | undefined)?.sheet,
  );
  const rels = xml.parse(source(files, "xl/_rels/workbook.xml.rels")) as Record<
    string,
    unknown
  >;
  const relationships = list(
    (rels.Relationships as Record<string, unknown> | undefined)?.Relationship,
  );
  const targets = new Map(
    relationships.map((relationship) => [
      String(relationship["@Id"] ?? ""),
      String(relationship["@Target"] ?? ""),
    ]),
  );
  return sheets.map((sheet) => {
    const id = String(sheet["@r:id"] ?? "");
    const target = targets.get(id);
    const name = String(sheet["@name"] ?? "").trim();
    if (!name || !target || target.includes("..") || target.startsWith("/"))
      throw new Error("The XLSX workbook has unsupported sheet metadata.");
    const xmlPath = `xl/${target.replace(/^\/+/, "")}`;
    if (!files[xmlPath])
      throw new Error("The XLSX workbook has a missing sheet.");
    return {
      name,
      hidden: String(sheet["@state"] ?? "visible") !== "visible",
      xmlPath,
    };
  });
}

function readSheet(
  files: ZipFiles,
  metadata: { name: string; hidden: boolean; xmlPath: string },
  shared: string[],
): IndexedSheet {
  const parsed = xml.parse(source(files, metadata.xmlPath)) as Record<
    string,
    unknown
  >;
  const worksheet = parsed.worksheet as Record<string, unknown> | undefined;
  const sheetData = worksheet?.sheetData as Record<string, unknown> | undefined;
  const cells = new Map<string, IndexedCell>();
  for (const row of list(sheetData?.row)) {
    for (const cell of list(row.c)) {
      const address = String(cell["@r"] ?? "").toUpperCase();
      if (!ADDRESS.test(address)) continue;
      const type = typeof cell["@t"] === "string" ? cell["@t"] : undefined;
      const hasFormula = cell.f !== undefined;
      const formulaText = text(cell.f);
      const rawFormula = cell.f as Record<string, unknown> | undefined;
      const formulaKind =
        typeof rawFormula?.["@t"] === "string" ? rawFormula["@t"] : undefined;
      // A shared-formula follower has an empty <f t="shared"/>. It remains
      // formula-protected even though its text lives on the anchor cell.
      const formula = hasFormula
        ? formulaText
          ? `=${formulaText.replace(/^=/, "")}`
          : "=<protected formula>"
        : undefined;
      const value =
        type === "inlineStr"
          ? scalar(cell.is, type, shared)
          : scalar(cell.v, type, shared);
      const styleValue = Number(cell["@s"] ?? 0);
      cells.set(address, {
        address,
        value,
        ...(type ? { cellType: type } : {}),
        style: Number.isInteger(styleValue) && styleValue >= 0 ? styleValue : 0,
        ...(formula ? { formula } : {}),
        ...(formulaKind ? { formulaKind } : {}),
      });
    }
  }
  return { ...metadata, cells };
}

function isTrueAttribute(value: unknown): boolean {
  return value === "1" || String(value).toLocaleLowerCase("en") === "true";
}

function capped(items: string[]): { values: string[]; truncated: boolean } {
  return {
    values: items.slice(0, MAX_PROFILE_STRUCTURE_ITEMS),
    truncated: items.length > MAX_PROFILE_STRUCTURE_ITEMS,
  };
}

function relationshipPartPath(xmlPath: string): string {
  const index = xmlPath.lastIndexOf("/");
  if (index < 0)
    throw new Error("The XLSX workbook has unsupported sheet metadata.");
  const folder = xmlPath.slice(0, index);
  const fileName = xmlPath.slice(index + 1);
  return `${folder}/_rels/${fileName}.rels`;
}

function resolveRelativePart(xmlPath: string, target: string): string {
  if (!target || target.startsWith("/") || /^[a-z]+:/i.test(target))
    throw new Error("The XLSX workbook has unsupported table metadata.");
  const segments = [...xmlPath.split("/").slice(0, -1), ...target.split("/")];
  const output: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!output.length)
        throw new Error("The XLSX workbook has unsupported table metadata.");
      output.pop();
      continue;
    }
    output.push(segment);
  }
  const resolved = output.join("/");
  if (!resolved.startsWith("xl/"))
    throw new Error("The XLSX workbook has unsupported table metadata.");
  return resolved;
}

function tableSummaries(
  files: ZipFiles,
  metadata: { xmlPath: string },
  worksheet: Record<string, unknown>,
): string[] {
  const ids = list(
    (worksheet.tableParts as Record<string, unknown> | undefined)?.tablePart,
  ).map((part) => String(part["@r:id"] ?? ""));
  if (!ids.length) return [];
  const relPath = relationshipPartPath(metadata.xmlPath);
  if (!files[relPath])
    throw new Error("The XLSX workbook has unresolved table metadata.");
  const rels = xml.parse(source(files, relPath)) as Record<string, unknown>;
  const relationships = list(
    (rels.Relationships as Record<string, unknown> | undefined)?.Relationship,
  );
  const targets = new Map(
    relationships.map((relationship) => [
      String(relationship["@Id"] ?? ""),
      String(relationship["@Target"] ?? ""),
    ]),
  );
  return ids.map((id) => {
    const target = targets.get(id);
    if (!target)
      throw new Error("The XLSX workbook has unresolved table metadata.");
    const tablePath = resolveRelativePart(metadata.xmlPath, target);
    if (!files[tablePath])
      throw new Error("The XLSX workbook has unresolved table metadata.");
    const parsed = xml.parse(source(files, tablePath)) as Record<
      string,
      unknown
    >;
    const table = parsed.table as Record<string, unknown> | undefined;
    const name =
      typeof table?.["@name"] === "string" ? table["@name"] : "unnamed table";
    const ref =
      typeof table?.["@ref"] === "string" ? table["@ref"] : "unknown range";
    return `${name} (${ref})`;
  });
}

function sheetStructureProfile(
  files: ZipFiles,
  sheet: IndexedSheet,
): WorkbookSheetStructure {
  const parsed = xml.parse(source(files, sheet.xmlPath)) as Record<
    string,
    unknown
  >;
  const worksheet = parsed.worksheet as Record<string, unknown> | undefined;
  if (!worksheet)
    throw new Error("The XLSX workbook has an unreadable worksheet structure.");
  const rows = list(
    (worksheet.sheetData as Record<string, unknown> | undefined)?.row,
  )
    .filter((row) => isTrueAttribute(row["@hidden"]))
    .map((row) => String(row["@r"] ?? ""))
    .filter((row) => /^\d+$/.test(row));
  const columns = list(
    (worksheet.cols as Record<string, unknown> | undefined)?.col,
  )
    .filter((column) => isTrueAttribute(column["@hidden"]))
    .map((column) => {
      const first = Number(column["@min"]);
      const last = Number(column["@max"]);
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < 1 ||
        last < first
      )
        throw new Error(
          "The XLSX workbook has invalid hidden-column metadata.",
        );
      return first === last
        ? columnLabel(first)
        : `${columnLabel(first)}:${columnLabel(last)}`;
    });
  const merged = list(
    (worksheet.mergeCells as Record<string, unknown> | undefined)?.mergeCell,
  )
    .map((merge) => String(merge["@ref"] ?? ""))
    .filter((ref) =>
      /^[A-Z]{1,3}[1-9]\d{0,6}:[A-Z]{1,3}[1-9]\d{0,6}$/i.test(ref),
    );
  const hiddenRows = capped(rows);
  const hiddenColumns = capped(columns);
  const mergedRanges = capped(merged);
  const tables = capped(tableSummaries(files, sheet, worksheet));
  return {
    hiddenRows: hiddenRows.values,
    hiddenColumns: hiddenColumns.values,
    mergedRanges: mergedRanges.values,
    tables: tables.values,
    truncated:
      hiddenRows.truncated ||
      hiddenColumns.truncated ||
      mergedRanges.truncated ||
      tables.truncated,
  };
}

function definedNameLabels(files: ZipFiles): {
  values: string[];
  truncated: boolean;
} {
  const parsed = xml.parse(source(files, "xl/workbook.xml")) as Record<
    string,
    unknown
  >;
  const workbook = parsed.workbook as Record<string, unknown> | undefined;
  const labels = list(
    (workbook?.definedNames as Record<string, unknown> | undefined)
      ?.definedName,
  )
    .map((name) => String(name["@name"] ?? "").trim())
    .filter(Boolean);
  return capped(labels);
}

function profileFor(
  files: ZipFiles,
  sheets: Iterable<IndexedSheet>,
  flags: WorkbookFlags,
  unsupportedReasons: string[],
): WorkbookProfile {
  const readOnlyReasons: string[] = [...unsupportedReasons];
  if (flags.hasVba)
    readOnlyReasons.push("Workbooks containing VBA macros are not supported.");
  if (flags.hasExternalLinks)
    readOnlyReasons.push("Workbooks with external links are not supported.");
  if (flags.hasPowerQuery)
    readOnlyReasons.push(
      "Workbooks with Power Query or data connections are not supported.",
    );
  const profileSheets: WorkbookSheetProfile[] = [...sheets].map((sheet) => {
    const values = [...sheet.cells.values()];
    return {
      name: sheet.name,
      hidden: sheet.hidden,
      populatedCells: values
        .slice(0, MAX_PROFILE_CELLS_PER_SHEET)
        .map((cell) => ({
          address: cell.address,
          value: cell.value,
          ...(cell.formula ? { formula: cell.formula } : {}),
        })),
      truncated: values.length > MAX_PROFILE_CELLS_PER_SHEET,
      structure: sheetStructureProfile(files, sheet),
    };
  });
  const definedNames = definedNameLabels(files);
  return {
    sheets: profileSheets,
    definedNames: definedNames.values,
    definedNamesTruncated: definedNames.truncated,
    flags,
    readOnlyReasons,
  };
}

function formulaSafetyReasons(sheets: Iterable<IndexedSheet>): string[] {
  for (const sheet of sheets) {
    for (const cell of sheet.cells.values()) {
      if (
        cell.formulaKind === "shared" ||
        cell.formulaKind === "array" ||
        cell.formulaKind === "dataTable"
      )
        return [
          "Workbooks containing shared, array, or data-table formulas are read-only in this companion.",
        ];
      if (
        cell.formula &&
        /(?:_xlfn\.(?:SEQUENCE|FILTER|UNIQUE|SORT|RANDARRAY|TOCOL|TOROW)|#)/i.test(
          cell.formula,
        )
      )
        return [
          "Workbooks containing dynamic-array formulas are read-only in this companion.",
        ];
    }
  }
  return [];
}

const FORMULA_ERROR =
  /^(?:#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!))$/i;

/** Error caches are dangerous in a write workflow even when they are outside requested checks. */
export function formulaErrorCells(
  indexed: Pick<IndexedWorkbook, "sheets">,
): string[] {
  const errors: string[] = [];
  for (const sheet of indexed.sheets.values()) {
    for (const cell of sheet.cells.values()) {
      if (
        cell.cellType === "e" ||
        (Boolean(cell.formula) &&
          typeof cell.value === "string" &&
          FORMULA_ERROR.test(cell.value))
      )
        errors.push(`${sheet.name}!${cell.address}`);
    }
  }
  return errors;
}

export function indexWorkbook(bytes: Uint8Array): IndexedWorkbook {
  const files = zipFiles(bytes);
  const flags = workbookFlags(files);
  const shared = sharedStrings(files);
  const sheets = new Map<string, IndexedSheet>();
  for (const metadata of sheetPaths(files)) {
    if (sheets.has(metadata.name))
      throw new Error("The XLSX workbook has duplicate sheet names.");
    sheets.set(metadata.name, readSheet(files, metadata, shared));
  }
  if (!sheets.size)
    throw new Error("The XLSX workbook contains no worksheets.");
  const parsedBook = xml.parse(source(files, "xl/workbook.xml")) as Record<
    string,
    unknown
  >;
  const book = parsedBook.workbook as Record<string, unknown> | undefined;
  const namedExpressions = list(
    (book?.definedNames as Record<string, unknown> | undefined)?.definedName,
  ).map(text);
  const expressions = [
    ...namedExpressions,
    ...[...sheets.values()].flatMap((sheet) =>
      [...sheet.cells.values()].flatMap((cell) =>
        cell.formula ? [cell.formula] : [],
      ),
    ),
  ];
  // A URL can be stored in another cell: looking for literal URLs alone does
  // not prevent WEBSERVICE(A1), RTD, Python or legacy execution functions.
  const externalCalculation = expressions.some((formula) =>
    /(?:\b(?:WEBSERVICE|RTD|IMAGE|STOCKHISTORY|PY|CALL|EXEC|REGISTER|REGISTER\.ID|RUN|CUBEVALUE|CUBEMEMBER|CUBESET)\s*\(|\|[^!]*!)/i.test(
      formula,
    ),
  );
  if (
    !flags.hasExternalLinks &&
    [...sheets.values()].some((sheet) =>
      [...sheet.cells.values()].some((cell) =>
        Boolean(
          cell.formula && /(?:\[[^\]]+\]|https?:\/\/|\\\\)/i.test(cell.formula),
        ),
      ),
    )
  )
    flags.hasExternalLinks = true;
  flags.hasFormulaErrors = formulaErrorCells({ sheets }).length > 0;
  return {
    files,
    sheets,
    profile: profileFor(files, sheets.values(), flags, [
      ...unsupportedPackageReasons(files),
      ...formulaSafetyReasons(sheets.values()),
      ...(externalCalculation
        ? [
            "External-data or code-executing calculation functions are not supported.",
          ]
        : []),
      ...(flags.hasFormulaErrors
        ? ["Workbooks containing cached formula errors are not supported."]
        : []),
    ]),
  };
}

export function profileWorkbook(bytes: Uint8Array): WorkbookProfile {
  return indexWorkbook(bytes).profile;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cellXml(
  existing: string,
  address: string,
  value: CompanionScalar,
): string {
  const opening = /^<c\b([^>]*)/i.exec(existing);
  if (!opening) throw new Error("Unable to update the requested cell.");
  const attributes = opening[1]
    .replace(/\s+t=(?:\"[^\"]*\"|'[^']*')/gi, "")
    .replace(/\s+r=(?:\"[^\"]*\"|'[^']*')/gi, "");
  const base = `<c r=\"${address}\"${attributes}`;
  if (value === null) return `${base}/>`;
  if (typeof value === "boolean")
    return `${base} t=\"b\"><v>${value ? "1" : "0"}</v></c>`;
  if (typeof value === "number") return `${base}><v>${value}</v></c>`;
  const preserve = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
  return `${base} t=\"inlineStr\"><is><t${preserve}>${escapeXml(value)}</t></is></c>`;
}

export interface WorkbookCellChange {
  sheet: string;
  address: string;
  before: CompanionScalar;
  after: CompanionScalar;
}

/**
 * Applies literal-only updates to a copy of an XLSX ZIP. Formula cells and
 * absent cells are deliberately rejected; Excel performs later recalculation.
 */
export function patchWorkbook(
  bytes: Uint8Array,
  changes: WorkbookCellChange[],
): Uint8Array {
  const indexed = indexWorkbook(bytes);
  if (indexed.profile.readOnlyReasons.length)
    throw new Error(indexed.profile.readOnlyReasons[0]);
  const files: ZipFiles = Object.fromEntries(
    Object.entries(indexed.files).map(([name, value]) => [name, value.slice()]),
  );
  for (const change of changes) {
    const address = change.address.toUpperCase();
    if (!ADDRESS.test(address)) throw new Error("A change address is invalid.");
    if (typeof change.after === "string" && change.after.startsWith("="))
      throw new Error(
        "Formula writes require a separate workflow and are not supported.",
      );
    const sheet = indexed.sheets.get(change.sheet);
    const current = sheet?.cells.get(address);
    if (!sheet || !current)
      throw new Error("Changes must target an existing populated cell.");
    if (current.formula)
      throw new Error("Formula cells cannot be overwritten.");
    if (!Object.is(current.value, change.before))
      throw new Error(
        "A change preimage no longer matches the source workbook.",
      );
    const escapedAddress = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `<c\\b(?=[^>]*\\br=(?:\"${escapedAddress}\"|'${escapedAddress}'))[^>]*(?:/>|>[\\s\\S]*?</c>)`,
      "i",
    );
    const original = strFromU8(files[sheet.xmlPath]);
    if (!pattern.test(original))
      throw new Error("The requested cell could not be located for patching.");
    files[sheet.xmlPath] = strToU8(
      original.replace(pattern, (match) =>
        cellXml(match, address, change.after),
      ),
    );
  }
  return zipSync(files, { level: 6 });
}

export function cellAt(
  indexed: IndexedWorkbook,
  sheet: string,
  address: string,
): IndexedCell | undefined {
  return indexed.sheets.get(sheet)?.cells.get(address.toUpperCase());
}

export function immutableWorkbookSnapshot(
  indexed: IndexedWorkbook,
): Map<string, IndexedCell> {
  const snapshot = new Map<string, IndexedCell>();
  for (const sheet of indexed.sheets.values()) {
    for (const cell of sheet.cells.values())
      snapshot.set(`${sheet.name}!${cell.address}`, { ...cell });
  }
  return snapshot;
}

export function assertNonTargetIntegrity(
  before: Map<string, IndexedCell>,
  after: IndexedWorkbook,
  targets: Set<string>,
): void {
  const observed = immutableWorkbookSnapshot(after);
  for (const [key, original] of before) {
    const next = observed.get(key);
    if (!next)
      throw new Error("A non-target cell disappeared during recalculation.");
    if (original.style !== next.style)
      throw new Error("Cell style integrity changed during recalculation.");
    if (original.formula !== next.formula)
      throw new Error("Formula integrity changed outside the approved patch.");
    if (original.formulaKind !== next.formulaKind)
      throw new Error("Formula kind integrity changed during recalculation.");
    if (targets.has(key)) continue;
    if (!original.formula && !Object.is(original.value, next.value))
      throw new Error("A non-target value changed during recalculation.");
  }
  for (const [key, next] of observed) {
    if (!before.has(key) && !targets.has(key))
      throw new Error(
        "An unapproved non-target cell was added during recalculation.",
      );
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sheetStructure(files: ZipFiles, xmlPath: string): string {
  const parsed = xml.parse(source(files, xmlPath)) as Record<string, unknown>;
  const worksheet = parsed.worksheet as Record<string, unknown> | undefined;
  if (!worksheet)
    throw new Error("The XLSX workbook has an unreadable worksheet structure.");
  const copy = { ...worksheet };
  delete copy.sheetData;
  return canonical(copy);
}

function definedNamesStructure(files: ZipFiles): string {
  const parsed = xml.parse(source(files, "xl/workbook.xml")) as Record<
    string,
    unknown
  >;
  const workbook = parsed.workbook as Record<string, unknown> | undefined;
  return canonical(workbook?.definedNames ?? null);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function preservedPartPaths(files: ZipFiles): string[] {
  return Object.keys(files)
    .filter(
      (part) =>
        part !== "xl/workbook.xml" &&
        part !== "xl/calcChain.xml" &&
        !part.startsWith("xl/worksheets/") &&
        !part.startsWith("docProps/"),
    )
    .sort();
}

/**
 * Native Excel is allowed to refresh formula caches and document timestamps,
 * nothing else. All non-cell worksheet structures and package parts are
 * compared fail-closed after the isolated reopen.
 */
export function assertWorkbookStructureIntegrity(
  before: IndexedWorkbook,
  after: IndexedWorkbook,
): void {
  if (
    definedNamesStructure(before.files) !== definedNamesStructure(after.files)
  )
    throw new Error("Defined-name integrity changed during recalculation.");
  if (before.sheets.size !== after.sheets.size)
    throw new Error("Worksheet structure changed during recalculation.");
  for (const [name, initial] of before.sheets) {
    const next = after.sheets.get(name);
    if (
      !next ||
      initial.hidden !== next.hidden ||
      initial.xmlPath !== next.xmlPath
    )
      throw new Error(
        "Worksheet visibility or identity changed during recalculation.",
      );
    if (
      sheetStructure(before.files, initial.xmlPath) !==
      sheetStructure(after.files, next.xmlPath)
    )
      throw new Error(
        "Worksheet structural integrity changed during recalculation.",
      );
  }
  const initialParts = preservedPartPaths(before.files);
  const nextParts = preservedPartPaths(after.files);
  if (initialParts.join("\u0000") !== nextParts.join("\u0000"))
    throw new Error("Workbook package structure changed during recalculation.");
  for (const part of initialParts) {
    if (!bytesEqual(before.files[part]!, after.files[part]!))
      throw new Error(
        "A workbook style, table, or unsupported package part changed during recalculation.",
      );
  }
}

function columnLabel(index: number): string {
  let value = index;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function literalCell(address: string, value: CompanionScalar): string {
  if (value === null) return `<c r=\"${address}\"/>`;
  if (typeof value === "number")
    return `<c r=\"${address}\"><v>${value}</v></c>`;
  if (typeof value === "boolean")
    return `<c r=\"${address}\" t=\"b\"><v>${value ? "1" : "0"}</v></c>`;
  return `<c r=\"${address}\" t=\"inlineStr\"><is><t>${escapeXml(value)}</t></is></c>`;
}

export interface SyntheticWorkbookInput {
  sheetName: string;
  rows: Array<{ label: string; amount: number }>;
  hidden?: boolean;
  shape?: "plain" | "hidden-crossref" | "nested-names" | "shared-formula";
  flags?: Partial<WorkbookFlags>;
}

/** Minimal deterministic XLSX fixture generator used only by companion tests/smoke. */
export function createSyntheticWorkbook(
  input: SyntheticWorkbookInput,
): Uint8Array {
  const shape = input.shape ?? "plain";
  const total = input.rows.reduce((sum, row) => sum + row.amount, 0);
  const totalRow = input.rows.length + 2;
  const suffix =
    shape === "hidden-crossref"
      ? "+__Controls!B1"
      : shape === "nested-names"
        ? "+Carry"
        : "";
  const rows = [
    `<row r=\"1\">${literalCell("A1", "Item")}${literalCell("B1", "Amount")}</row>`,
    ...input.rows.map((row, index) => {
      const number = index + 2;
      return `<row r=\"${number}\">${literalCell(`A${number}`, row.label)}${literalCell(`B${number}`, row.amount)}</row>`;
    }),
  ];
  const totalFormula = `SUM(B2:B${totalRow - 1})${suffix}`;
  rows.push(
    `<row r=\"${totalRow}\">${literalCell(`A${totalRow}`, "Total")}<c r=\"B${totalRow}\"><f${shape === "shared-formula" ? ' t=\"shared\" si=\"0\" ref=\"B' + totalRow + ":B" + (totalRow + 1) + '\"' : ""}>${totalFormula}</f><v>${total}</v></c></row>`,
  );
  if (shape === "shared-formula")
    rows.push(
      `<row r=\"${totalRow + 1}\">${literalCell(`A${totalRow + 1}`, "Follower")}<c r=\"B${totalRow + 1}\"><f t=\"shared\" si=\"0\"/><v>${total}</v></c></row>`,
    );
  const flags = input.flags ?? {};
  const files: ZipFiles = {
    "[Content_Types].xml": strToU8(
      `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>${shape === "hidden-crossref" ? '<Override PartName=\"/xl/worksheets/sheet2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>' : ""}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"${escapeXml(input.sheetName)}\" sheetId=\"1\"${input.hidden ? ' state=\"hidden\"' : ""} r:id=\"rId1\"/>${shape === "hidden-crossref" ? '<sheet name=\"__Controls\" sheetId=\"2\" state=\"hidden\" r:id=\"rId2\"/>' : ""}</sheets>${shape === "nested-names" ? '<definedNames><definedName name=\"BaseAmount\">0</definedName><definedName name=\"Carry\">BaseAmount</definedName></definedNames>' : ""}</workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>${shape === "hidden-crossref" ? '<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/>' : ""}</Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>${rows.join("")}</sheetData></worksheet>`,
    ),
  };
  if (shape === "hidden-crossref")
    files["xl/worksheets/sheet2.xml"] = strToU8(
      `<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\">${literalCell("A1", "Adjustment")}${literalCell("B1", 0)}</row></sheetData></worksheet>`,
    );
  if (flags.hasVba) files["xl/vbaProject.bin"] = new Uint8Array([0]);
  if (flags.hasExternalLinks)
    files["xl/externalLinks/externalLink1.xml"] = strToU8("<externalLink/>");
  if (flags.hasPowerQuery || flags.hasConnections)
    files["xl/connections.xml"] = strToU8("<connections/>");
  return zipSync(files, { level: 6 });
}

export const companionWorkbookLimits = {
  profileCellsPerSheet: MAX_PROFILE_CELLS_PER_SHEET,
};
