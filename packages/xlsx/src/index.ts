import { deflateSync, unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { validateDataset } from "../../core/src/index.ts";
import type {
  CellValue,
  Dataset,
  Field,
  FieldType,
  Locale,
  Mapping,
  WorkRecord,
} from "../../core/src/types.ts";

/**
 * This adapter deliberately does not use a workbook object model.  It reads
 * only the OOXML parts it understands and patches only changed cell XML.  The
 * rest of the ZIP's local members are copied from the original byte-for-byte.
 */

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_MEMBER_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const XLSX_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export type XlsxSafetyCode =
  | "INVALID_ZIP"
  | "ZIP_BOMB"
  | "UNSAFE_ZIP_PATH"
  | "UNSUPPORTED_XLS"
  | "ENCRYPTED_WORKBOOK"
  | "UNSUPPORTED_CONTENT"
  | "INVALID_XML"
  | "INVALID_SELECTION"
  | "FORMULA_LOCKED"
  | "SOURCE_MISMATCH"
  | "INVALID_VALUE"
  | "REIMPORT_CONFLICT";

export class XlsxSafetyError extends Error {
  constructor(
    public readonly code: XlsxSafetyCode,
    message: string,
  ) {
    super(message);
    this.name = "XlsxSafetyError";
  }
}

export interface WorkbookSheetInspection {
  name: string;
  hidden: boolean;
  rowCount: number;
  maxRow: number;
  maxColumn: number;
  headerCandidates: Array<{ row: number; values: string[] }>;
}

export interface WorkbookInspection {
  date1904: boolean;
  sheets: WorkbookSheetInspection[];
  suggestedSelection?: {
    sheetName: string;
    headerRow: number;
    startColumn: number;
    endColumn: number;
    endRow: number;
  };
}

export interface ImportWorkbookOptions {
  sheetName?: string;
  headerRow?: number;
  startColumn?: number;
  endColumn?: number;
  endRow?: number;
  mapping?: Mapping;
  name?: string;
  fileName?: string;
  dateOrder?: "ymd" | "dmy" | "mdy";
  locale?: Locale;
  timeZone?: string;
  weekStartsOn?: 0 | 1;
}

export interface ReimportConflict {
  kind: "ambiguous_identity" | "ambiguous_exact_match" | "unmatched_record";
  recordId?: string;
  incomingRecordId?: string;
  field?: string;
  message: string;
}

export interface ReimportResult {
  dataset?: Dataset;
  conflicts: ReimportConflict[];
}

interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  modifiedTime: number;
  modifiedDate: number;
  localOffset: number;
  rawCentral: Uint8Array;
  rawLocal: Uint8Array;
}

interface ZipArchive {
  entries: ZipEntry[];
  files: Record<string, Uint8Array>;
  comment: Uint8Array;
}

interface ParsedCell {
  value: CellValue;
  hasFormula: boolean;
  style: number;
  type?: string;
}

interface ParsedSheet {
  name: string;
  path: string;
  hidden: boolean;
  cells: Map<string, ParsedCell>;
  rows: Set<number>;
  maxRow: number;
  maxColumn: number;
}

interface ParsedWorkbook {
  archive: ZipArchive;
  date1904: boolean;
  sharedStrings: string[];
  dateStyles: Set<number>;
  sheets: ParsedSheet[];
}

const xmlParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  // OOXML permits a namespace prefix on every SpreadsheetML element.  Parsing
  // semantic reads without its prefix keeps default-namespace and prefixed
  // workbooks equivalent; export still patches the original XML text.
  removeNSPrefix: true,
};

function safety(code: XlsxSafetyCode, message: string): never {
  throw new XlsxSafetyError(code, message);
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length)
    safety("INVALID_ZIP", "Truncated ZIP record.");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length)
    safety("INVALID_ZIP", "Truncated ZIP record.");
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function hasSignature(
  bytes: Uint8Array,
  offset: number,
  signature: number,
): boolean {
  return (
    offset >= 0 &&
    offset + 4 <= bytes.length &&
    readU32(bytes, offset) === signature
  );
}

function decodePartName(bytes: Uint8Array): string {
  // OOXML package part names are ASCII by specification. Rejecting other
  // names avoids CP437/UTF-8 ambiguity and makes path checks deterministic.
  for (const byte of bytes)
    if (byte < 0x21 || byte > 0x7e)
      safety(
        "UNSAFE_ZIP_PATH",
        "ZIP entry name is not a safe OOXML part name.",
      );
  return textDecoder.decode(bytes);
}

function assertSafePartName(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[A-Za-z]:/.test(name)
  ) {
    safety("UNSAFE_ZIP_PATH", `Unsafe ZIP path: ${name}`);
  }
  const pieces = name.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === ".."))
    safety("UNSAFE_ZIP_PATH", `Unsafe ZIP path: ${name}`);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = 22;
  const earliest = Math.max(0, bytes.length - minimum - 0xffff);
  for (let offset = bytes.length - minimum; offset >= earliest; offset -= 1) {
    if (
      hasSignature(bytes, offset, 0x06054b50) &&
      offset + minimum + readU16(bytes, offset + 20) === bytes.length
    )
      return offset;
  }
  safety("INVALID_ZIP", "ZIP end-of-central-directory record was not found.");
}

function inspectZip(bytes: Uint8Array): ZipArchive {
  if (bytes.length > MAX_ARCHIVE_BYTES)
    safety("ZIP_BOMB", "Workbook exceeds the 50 MiB import limit.");
  if (XLSX_MAGIC.every((byte, index) => bytes[index] === byte))
    safety(
      "UNSUPPORTED_XLS",
      "Legacy .xls files are not supported; save as .xlsx first.",
    );
  if (bytes.length < 4 || !hasSignature(bytes, 0, 0x04034b50))
    safety("INVALID_ZIP", "Expected a normal .xlsx ZIP package.");

  const eocd = findEndOfCentralDirectory(bytes);
  const disk = readU16(bytes, eocd + 4);
  const centralDisk = readU16(bytes, eocd + 6);
  const countOnDisk = readU16(bytes, eocd + 8);
  const count = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  const commentLength = readU16(bytes, eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    countOnDisk !== count ||
    count > MAX_ENTRIES
  )
    safety(
      "UNSUPPORTED_CONTENT",
      "Multi-disk or oversized ZIP archives are not supported.",
    );
  if (centralOffset + centralSize !== eocd || centralOffset > bytes.length)
    safety("INVALID_ZIP", "ZIP central-directory bounds are invalid.");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    if (!hasSignature(bytes, cursor, 0x02014b50))
      safety("INVALID_ZIP", "Invalid central-directory entry.");
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const modifiedTime = readU16(bytes, cursor + 12);
    const modifiedDate = readU16(bytes, cursor + 14);
    const crc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const entryCommentLength = readU16(bytes, cursor + 32);
    const diskStart = readU16(bytes, cursor + 34);
    const localOffset = readU32(bytes, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (
      end > centralOffset + centralSize ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      safety(
        "UNSUPPORTED_CONTENT",
        "ZIP64 or multi-disk package members are not supported.",
      );
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0)
      safety("ENCRYPTED_WORKBOOK", "Encrypted workbooks are not supported.");
    if (method !== 0 && method !== 8)
      safety(
        "UNSUPPORTED_CONTENT",
        `ZIP compression method ${method} is not supported.`,
      );
    if (
      uncompressedSize > MAX_MEMBER_BYTES ||
      (compressedSize > 0 &&
        uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      safety("ZIP_BOMB", "A workbook member exceeds safe expansion limits.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_EXPANDED_BYTES)
      safety(
        "ZIP_BOMB",
        "Workbook expanded size exceeds the 100 MiB import limit.",
      );

    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = decodePartName(nameBytes);
    assertSafePartName(name);
    if (seen.has(name)) safety("INVALID_ZIP", `Duplicate ZIP entry: ${name}`);
    seen.add(name);
    if (
      localOffset >= centralOffset ||
      !hasSignature(bytes, localOffset, 0x04034b50)
    )
      safety("INVALID_ZIP", `Invalid local ZIP entry for ${name}.`);

    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      modifiedTime,
      modifiedDate,
      localOffset,
      rawCentral: bytes.slice(start, end),
      rawLocal: new Uint8Array(),
    });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize)
    safety("INVALID_ZIP", "ZIP central directory has trailing data.");

  const byOffset = [...entries].sort(
    (left, right) => left.localOffset - right.localOffset,
  );
  for (let index = 0; index < byOffset.length; index += 1) {
    const entry = byOffset[index];
    const nextOffset =
      index + 1 < byOffset.length
        ? byOffset[index + 1].localOffset
        : centralOffset;
    const localNameLength = readU16(bytes, entry.localOffset + 26);
    const localExtraLength = readU16(bytes, entry.localOffset + 28);
    const dataStart =
      entry.localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataStart + entry.compressedSize > nextOffset ||
      nextOffset > centralOffset
    )
      safety("INVALID_ZIP", `ZIP member bounds are invalid for ${entry.name}.`);
    const localName = bytes.slice(
      entry.localOffset + 30,
      entry.localOffset + 30 + localNameLength,
    );
    if (
      !bytesEqual(localName, entry.nameBytes) ||
      readU16(bytes, entry.localOffset + 6) !== entry.flags ||
      readU16(bytes, entry.localOffset + 8) !== entry.method
    ) {
      safety(
        "INVALID_ZIP",
        `Local ZIP header does not match central directory for ${entry.name}.`,
      );
    }
    entry.rawLocal = bytes.slice(entry.localOffset, nextOffset);
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    safety("INVALID_ZIP", "Workbook ZIP payload could not be decompressed.");
  }
  for (const entry of entries) {
    const file = files[entry.name];
    if (!file || file.length !== entry.uncompressedSize)
      safety(
        "INVALID_ZIP",
        `Workbook member could not be safely read: ${entry.name}`,
      );
  }
  return { entries, files, comment: bytes.slice(eocd + 22) };
}

function readXml(archive: Pick<ZipArchive, "files">, path: string): string {
  const bytes = archive.files[path];
  if (!bytes)
    safety("UNSUPPORTED_CONTENT", `Required OOXML part is missing: ${path}`);
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  )
    safety(
      "UNSUPPORTED_CONTENT",
      `UTF-16 XML is not supported safely: ${path}`,
    );
  let xml: string;
  try {
    xml = textDecoder.decode(bytes);
  } catch {
    safety("INVALID_XML", `OOXML part is not valid UTF-8: ${path}`);
  }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    safety("INVALID_XML", `Unsafe XML declaration in ${path}.`);
  const valid = XMLValidator.validate(xml);
  if (valid !== true) safety("INVALID_XML", `Invalid XML in ${path}.`);
  return xml;
}

function parseXml(archive: Pick<ZipArchive, "files">, path: string): any {
  const xml = readXml(archive, path);
  try {
    return new XMLParser(xmlParserOptions).parse(xml);
  } catch {
    safety("INVALID_XML", `Unable to parse XML in ${path}.`);
  }
}

function collectText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("#text" in object) return collectText(object["#text"]);
    // Rich shared strings may contain r/t fragments. Attributes are not text.
    return Object.entries(object)
      .filter(([key]) => !key.startsWith("@"))
      .map(([, child]) => collectText(child))
      .join("");
  }
  return "";
}

function normalizePartPath(target: string): string {
  if (/^[A-Za-z]+:/.test(target) || target.includes("\\"))
    safety("UNSUPPORTED_CONTENT", "Workbook relationship target is unsafe.");
  const absolute = target.startsWith("/");
  const parts = absolute ? [] : ["xl"];
  for (const piece of target.split("/")) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (parts.length <= (absolute ? 0 : 1))
        safety(
          "UNSUPPORTED_CONTENT",
          "Workbook relationship escapes the package.",
        );
      parts.pop();
    } else parts.push(piece);
  }
  const path = parts.join("/");
  if (!path.startsWith("xl/"))
    safety(
      "UNSUPPORTED_CONTENT",
      "Workbook relationship is outside the xl package.",
    );
  return path;
}

function assertSupportedContent(archive: ZipArchive): void {
  const names = new Set(archive.entries.map((entry) => entry.name));
  const required = [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
  ];
  for (const path of required)
    if (!names.has(path))
      safety(
        "UNSUPPORTED_CONTENT",
        `Not a complete .xlsx package: missing ${path}.`,
      );
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === "encryptioninfo" || lower === "encryptedpackage")
      safety("ENCRYPTED_WORKBOOK", "Encrypted workbooks are not supported.");
    if (
      lower.includes("vbaproject") ||
      lower.includes("vbadata") ||
      lower.includes("macrosheet")
    )
      safety(
        "UNSUPPORTED_CONTENT",
        "Macro-enabled workbooks are not supported.",
      );
    if (
      lower.startsWith("xl/pivottables/") ||
      lower.startsWith("xl/pivotcache/") ||
      lower.startsWith("xl/externallinks/") ||
      lower === "xl/connections.xml"
    ) {
      safety(
        "UNSUPPORTED_CONTENT",
        "Pivot tables, external links, and workbook connections are not supported.",
      );
    }
    if (
      lower.startsWith("xl/model/") ||
      lower.startsWith("xl/slicers/") ||
      lower.startsWith("xl/timelines/") ||
      lower.startsWith("xl/querytables/")
    ) {
      safety(
        "UNSUPPORTED_CONTENT",
        "This workbook contains an unsupported interactive data feature.",
      );
    }
  }
  const contentTypes = readXml(archive, "[Content_Types].xml");
  if (
    /macroenabled|vbaProject|application\/vnd\.ms-excel\.sheet\.binary/i.test(
      contentTypes,
    )
  )
    safety(
      "UNSUPPORTED_CONTENT",
      "Macro or binary workbook content is not supported.",
    );
  for (const relationPath of ["_rels/.rels", "xl/_rels/workbook.xml.rels"]) {
    const relationXml = readXml(archive, relationPath);
    if (
      /TargetMode\s*=\s*["']External["']|externalLink|connections/i.test(
        relationXml,
      )
    )
      safety(
        "UNSUPPORTED_CONTENT",
        "External workbook relationships are not supported.",
      );
  }
  const workbookXml = readXml(archive, "xl/workbook.xml");
  if (/<(?:\w+:)?(?:externalReferences|pivotCaches)\b/i.test(workbookXml))
    safety(
      "UNSUPPORTED_CONTENT",
      "External references or pivot caches are not supported.",
    );
}

function parseDateStyles(archive: ZipArchive): Set<number> {
  if (!archive.files["xl/styles.xml"]) return new Set();
  const styles = parseXml(archive, "xl/styles.xml").styleSheet ?? {};
  const customFormats = new Map<number, string>();
  for (const numFmt of asArray<any>(styles.numFmts?.numFmt)) {
    const id = Number(numFmt["@numFmtId"]);
    if (Number.isInteger(id) && typeof numFmt["@formatCode"] === "string")
      customFormats.set(id, numFmt["@formatCode"]);
  }
  const result = new Set<number>();
  const xfs = asArray<any>(styles.cellXfs?.xf);
  xfs.forEach((xf, index) => {
    const formatId = Number(xf?.["@numFmtId"] ?? 0);
    if (isDateFormat(formatId, customFormats.get(formatId))) result.add(index);
  });
  return result;
}

function isDateFormat(formatId: number, customFormat?: string): boolean {
  if (
    [
      14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35,
      36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
    ].includes(formatId)
  )
    return true;
  if (!customFormat) return false;
  const normalized = customFormat
    .replace(/\\./g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .split(";")[0]
    .toLowerCase();
  return (
    /[yd]/.test(normalized) ||
    /h/.test(normalized) ||
    (/m/.test(normalized) && /s/.test(normalized))
  );
}

function excelSerialToDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial))
    safety("INVALID_VALUE", "A date cell has a non-finite Excel serial.");
  const day = Math.floor(serial);
  if (!date1904 && day === 60)
    safety(
      "INVALID_VALUE",
      "Excel serial 60 is the fictitious date 1900-02-29 and cannot be imported as a real date.",
    );
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const adjusted = date1904 ? day : day >= 60 ? day - 1 : day;
  return new Date(epoch + adjusted * 86_400_000).toISOString().slice(0, 10);
}

function dateToExcelSerial(value: string, date1904: boolean): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    safety("INVALID_VALUE", "Date fields must use YYYY-MM-DD.");
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const check = new Date(timestamp);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    safety("INVALID_VALUE", "Date fields must contain a real calendar date.");
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  let serial = Math.round((timestamp - epoch) / 86_400_000);
  if (!date1904 && timestamp >= Date.UTC(1900, 2, 1)) serial += 1;
  return serial;
}

function cellRef(column: number, row: number): string {
  return `${columnLabel(column)}${row}`;
}

function columnLabel(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > 16_384)
    safety("INVALID_SELECTION", "Column is outside Excel worksheet bounds.");
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function columnNumber(label: string): number {
  if (!/^[A-Z]{1,3}$/.test(label))
    safety("INVALID_XML", `Invalid cell column ${label}.`);
  let value = 0;
  for (const character of label)
    value = value * 26 + character.charCodeAt(0) - 64;
  if (value > 16_384)
    safety("INVALID_XML", `Cell column ${label} is outside Excel bounds.`);
  return value;
}

function parseCellRef(reference: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(reference);
  if (!match) safety("INVALID_XML", `Invalid cell reference ${reference}.`);
  return { column: columnNumber(match[1]), row: Number(match[2]) };
}

function parseSharedStrings(archive: ZipArchive): string[] {
  if (!archive.files["xl/sharedStrings.xml"]) return [];
  const root = parseXml(archive, "xl/sharedStrings.xml").sst ?? {};
  return asArray<any>(root.si).map((item) => collectText(item));
}

function readCellValue(
  cell: any,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): CellValue {
  const type = cell?.["@t"];
  const rawValue = cell?.v;
  const raw =
    rawValue === undefined || rawValue === null ? "" : collectText(rawValue);
  if (type === "s") {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length)
      safety("INVALID_XML", "Shared-string cell has an invalid index.");
    return sharedStrings[index];
  }
  if (type === "inlineStr") return collectText(cell.is);
  if (type === "b") {
    if (raw === "1" || raw.toLowerCase() === "true") return true;
    if (raw === "0" || raw.toLowerCase() === "false") return false;
    safety("INVALID_XML", "Boolean cell has an invalid value.");
  }
  if (type === "str" || type === "e") return raw;
  if (type === "d") return raw;
  if (raw === "") return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  const style = Number(cell?.["@s"] ?? 0);
  return dateStyles.has(style) ? excelSerialToDate(numeric, date1904) : numeric;
}

function parseSheet(
  archive: Pick<ZipArchive, "files">,
  name: string,
  path: string,
  hidden: boolean,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): ParsedSheet {
  const root = parseXml(archive, path).worksheet;
  if (!root) safety("INVALID_XML", `Worksheet root is missing in ${path}.`);
  const cells = new Map<string, ParsedCell>();
  const rows = new Set<number>();
  let maxRow = 0;
  let maxColumn = 0;
  for (const row of asArray<any>(root.sheetData?.row)) {
    const rowNumber = Number(row?.["@r"]);
    if (Number.isInteger(rowNumber) && rowNumber > 0) rows.add(rowNumber);
    for (const cell of asArray<any>(row?.c)) {
      const reference = cell?.["@r"];
      if (typeof reference !== "string")
        safety("INVALID_XML", `A worksheet cell has no reference in ${path}.`);
      const coordinate = parseCellRef(reference);
      if (cells.has(reference))
        safety("INVALID_XML", `Duplicate worksheet cell ${reference}.`);
      rows.add(coordinate.row);
      maxRow = Math.max(maxRow, coordinate.row);
      maxColumn = Math.max(maxColumn, coordinate.column);
      cells.set(reference, {
        value: readCellValue(cell, sharedStrings, dateStyles, date1904),
        hasFormula: Object.prototype.hasOwnProperty.call(cell, "f"),
        style: Number(cell?.["@s"] ?? 0),
        type: cell?.["@t"],
      });
    }
  }
  return { name, path, hidden, cells, rows, maxRow, maxColumn };
}

function parseWorkbook(bytes: Uint8Array): ParsedWorkbook {
  const archive = inspectZip(bytes);
  assertSupportedContent(archive);
  const workbook = parseXml(archive, "xl/workbook.xml").workbook;
  if (!workbook) safety("INVALID_XML", "Workbook root is missing.");
  const date1904Value = workbook.workbookPr?.["@date1904"];
  const date1904 = date1904Value === "1" || date1904Value === "true";
  const relations = parseXml(
    archive,
    "xl/_rels/workbook.xml.rels",
  ).Relationships;
  const targets = new Map<string, string>();
  for (const relation of asArray<any>(relations?.Relationship)) {
    const id = relation?.["@Id"];
    const target = relation?.["@Target"];
    if (typeof id !== "string" || typeof target !== "string")
      safety("INVALID_XML", "Workbook relationship is incomplete.");
    if (relation?.["@TargetMode"] === "External")
      safety(
        "UNSUPPORTED_CONTENT",
        "External workbook relationships are not supported.",
      );
    targets.set(id, normalizePartPath(target));
  }
  const sharedStrings = parseSharedStrings(archive);
  const dateStyles = parseDateStyles(archive);
  const sheets: ParsedSheet[] = [];
  for (const sheet of asArray<any>(workbook.sheets?.sheet)) {
    const name = sheet?.["@name"];
    const relationId = sheet?.["@id"];
    if (typeof name !== "string" || typeof relationId !== "string")
      safety("INVALID_XML", "Workbook sheet metadata is incomplete.");
    const path = targets.get(relationId);
    if (
      !path ||
      !/^xl\/worksheets\/[^/]+\.xml$/i.test(path) ||
      !archive.files[path]
    )
      safety(
        "UNSUPPORTED_CONTENT",
        `Worksheet relationship is unsupported for ${name}.`,
      );
    sheets.push(
      parseSheet(
        archive,
        name,
        path,
        sheet?.["@state"] === "hidden" || sheet?.["@state"] === "veryHidden",
        sharedStrings,
        dateStyles,
        date1904,
      ),
    );
  }
  if (!sheets.length)
    safety("INVALID_SELECTION", "Workbook has no worksheets.");
  return { archive, date1904, sharedStrings, dateStyles, sheets };
}

function valueAsHeader(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value).trim();
}

function headerCandidates(
  sheet: ParsedSheet,
): Array<{ row: number; values: string[] }> {
  const candidates: Array<{ row: number; values: string[]; count: number }> =
    [];
  for (const row of [...sheet.rows]
    .sort((left, right) => left - right)
    .slice(0, 100)) {
    const values: string[] = [];
    let count = 0;
    for (let column = 1; column <= sheet.maxColumn; column += 1) {
      const value = valueAsHeader(
        sheet.cells.get(cellRef(column, row))?.value ?? null,
      );
      values.push(value);
      if (value) count += 1;
    }
    if (count > 0) candidates.push({ row, values, count });
  }
  return candidates
    .sort((left, right) => right.count - left.count || left.row - right.row)
    .slice(0, 5)
    .map(({ row, values }) => ({ row, values }));
}

function suggestedRange(
  sheet: ParsedSheet,
):
  | {
      headerRow: number;
      startColumn: number;
      endColumn: number;
      endRow: number;
    }
  | undefined {
  const candidate = headerCandidates(sheet)[0];
  if (!candidate || sheet.maxColumn < 1 || sheet.maxRow <= candidate.row)
    return undefined;
  let startColumn = candidate.values.findIndex(Boolean) + 1;
  if (startColumn === 0) startColumn = 1;
  let endColumn = candidate.values.length;
  while (endColumn > startColumn && !candidate.values[endColumn - 1])
    endColumn -= 1;
  return {
    headerRow: candidate.row,
    startColumn,
    endColumn: Math.max(startColumn, endColumn),
    endRow: sheet.maxRow,
  };
}

/** Inspect an XLSX package without retaining a mutable workbook model. */
export function inspectWorkbook(bytes: Uint8Array): WorkbookInspection {
  const original = bytes.slice();
  const workbook = parseWorkbook(bytes);
  if (!bytesEqual(bytes, original))
    safety(
      "INVALID_ZIP",
      "The input workbook buffer was unexpectedly mutated.",
    );
  const sheets = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    hidden: sheet.hidden,
    rowCount: sheet.rows.size,
    maxRow: sheet.maxRow,
    maxColumn: sheet.maxColumn,
    headerCandidates: headerCandidates(sheet),
  }));
  const first =
    workbook.sheets.find((sheet) => !sheet.hidden) ?? workbook.sheets[0];
  const range = suggestedRange(first);
  return {
    date1904: workbook.date1904,
    sheets,
    suggestedSelection: range ? { sheetName: first.name, ...range } : undefined,
  };
}

function fieldKey(column: number): string {
  return `xlsx_col_${columnLabel(column)}`;
}

function fieldColumn(key: string): number | undefined {
  const match = /^xlsx_col_([A-Z]{1,3})$/.exec(key);
  return match ? columnNumber(match[1]) : undefined;
}

function inferFieldType(values: CellValue[], header: string): FieldType {
  const nonEmpty = values.filter((value) => value !== null);
  if (!nonEmpty.length)
    return /(?:url|link|링크)/i.test(header) ? "url" : "text";
  if (nonEmpty.every((value) => typeof value === "number")) return "number";
  if (
    nonEmpty.every(
      (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
    )
  )
    return "date";
  if (
    /url|link|링크/i.test(header) ||
    nonEmpty.every(
      (value) => typeof value === "string" && /^https?:\/\//i.test(value),
    )
  )
    return "url";
  return "text";
}

function bestField(fields: Field[], patterns: RegExp[]): string | undefined {
  const matches = fields.filter((field) =>
    patterns.some((pattern) => pattern.test(field.label)),
  );
  return matches.length === 1 ? matches[0].key : undefined;
}

function suggestMapping(fields: Field[], supplied?: Mapping): Mapping {
  const suggestion: Mapping = {
    title:
      bestField(fields, [/^(title|task|name|subject|제목|업무|할일)$/i]) ??
      fields[0]?.key ??
      "",
    date: bestField(fields, [/date|due|deadline|날짜|마감|일정/i]),
    assignee: bestField(fields, [/assignee|owner|assigned|담당/i]),
    status: bestField(fields, [/status|state|상태/i]),
    category: bestField(fields, [/category|type|분류|카테고리/i]),
    url: bestField(fields, [/url|link|링크/i]),
    identity: bestField(fields, [/^(id|identifier|key|번호|식별자)$/i]),
  };
  return {
    ...suggestion,
    ...supplied,
    title: supplied?.title || suggestion.title,
  };
}

function validateMapping(mapping: Mapping, fields: Field[]): void {
  const keys = new Set(fields.map((field) => field.key));
  for (const [role, key] of Object.entries(mapping)) {
    if (key !== undefined && key !== "" && !keys.has(key))
      safety(
        "INVALID_SELECTION",
        `Mapping ${role} does not refer to an imported column.`,
      );
  }
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function valueSignature(value: CellValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${value}`;
  return `boolean:${value}`;
}

function exactSignature(
  values: Record<string, CellValue>,
  fields: Field[],
): string {
  return fields
    .map((field) => `${field.key}=${valueSignature(values[field.key] ?? null)}`)
    .join("|");
}

function identityValue(
  record: WorkRecord,
  identity: string | undefined,
): string | undefined {
  if (!identity) return undefined;
  const value = record.values[identity];
  if (value === null || value === undefined || value === "") return undefined;
  return valueSignature(value);
}

function assertFiniteSelection(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1))
    safety("INVALID_SELECTION", `${name} must be a positive integer.`);
  return value;
}

/** Import a selected rectangle. Field keys contain explicit Excel column IDs. */
export function importWorkbook(
  bytes: Uint8Array,
  options: ImportWorkbookOptions = {},
): Dataset {
  const original = bytes.slice();
  const workbook = parseWorkbook(bytes);
  const sheet = options.sheetName
    ? workbook.sheets.find((candidate) => candidate.name === options.sheetName)
    : (workbook.sheets.find((candidate) => !candidate.hidden) ??
      workbook.sheets[0]);
  if (!sheet) safety("INVALID_SELECTION", "Selected worksheet does not exist.");
  const suggested = suggestedRange(sheet);
  const headerRow = assertFiniteSelection(
    options.headerRow ?? suggested?.headerRow,
    "headerRow",
  );
  const startColumn = assertFiniteSelection(
    options.startColumn ?? suggested?.startColumn ?? 1,
    "startColumn",
  );
  const endColumn = assertFiniteSelection(
    options.endColumn ?? suggested?.endColumn ?? sheet.maxColumn,
    "endColumn",
  );
  const endRow = assertFiniteSelection(
    options.endRow ?? suggested?.endRow ?? sheet.maxRow,
    "endRow",
  );
  if (
    !headerRow ||
    !startColumn ||
    !endColumn ||
    !endRow ||
    endColumn < startColumn ||
    endRow <= headerRow ||
    endColumn > 16_384 ||
    endRow > 1_048_576
  ) {
    safety("INVALID_SELECTION", "Selected header and range are invalid.");
  }

  const fieldColumns = Array.from(
    { length: endColumn - startColumn + 1 },
    (_, index) => startColumn + index,
  );
  const headers = fieldColumns.map((column) =>
    valueAsHeader(sheet.cells.get(cellRef(column, headerRow))?.value ?? null),
  );
  const fields: Field[] = fieldColumns.map((column, index) => ({
    key: fieldKey(column),
    label: headers[index] || `Column ${columnLabel(column)}`,
    type: "text",
  }));
  const rawRows: Array<{
    row: number;
    values: Record<string, CellValue>;
    lockedFields: string[];
  }> = [];
  for (let row = headerRow + 1; row <= endRow; row += 1) {
    const values: Record<string, CellValue> = {};
    const lockedFields: string[] = [];
    let hasValue = false;
    fields.forEach((field, index) => {
      const cell = sheet.cells.get(cellRef(fieldColumns[index], row));
      values[field.key] = cell?.value ?? null;
      if (cell?.value !== null && cell?.value !== undefined) hasValue = true;
      if (cell?.hasFormula) lockedFields.push(field.key);
    });
    if (hasValue) rawRows.push({ row, values, lockedFields });
  }
  fields.forEach((field) => {
    field.type = inferFieldType(
      rawRows.map((row) => row.values[field.key]),
      field.label,
    );
  });
  const mapping = suggestMapping(fields, options.mapping);
  validateMapping(mapping, fields);

  const duplicateCounters = new Map<string, number>();
  const identitySeen = new Set<string>();
  const records: WorkRecord[] = rawRows.map((raw) => {
    const signature = exactSignature(raw.values, fields);
    const identityKey = mapping.identity;
    const identityCell = identityKey ? raw.values[identityKey] : undefined;
    const explicitIdentity = identityKey
      ? valueSignature(identityCell ?? null)
      : undefined;
    if (
      identityKey &&
      identityCell !== null &&
      identityCell !== "" &&
      explicitIdentity !== undefined
    ) {
      if (identitySeen.has(explicitIdentity))
        safety(
          "INVALID_SELECTION",
          "The selected identity column contains duplicate values.",
        );
      identitySeen.add(explicitIdentity);
    }
    const base =
      explicitIdentity && identityCell !== null && identityCell !== ""
        ? `id-${stableHash(`${identityKey}:${explicitIdentity}`)}`
        : `row-${stableHash(signature)}`;
    const count = (duplicateCounters.get(base) ?? 0) + 1;
    duplicateCounters.set(base, count);
    return {
      id: count === 1 ? `xlsx-${base}` : `xlsx-${base}-${count}`,
      revision: 0,
      values: raw.values,
      sourceRow: raw.row,
      ...(raw.lockedFields.length ? { lockedFields: raw.lockedFields } : {}),
    };
  });
  const completedStatuses = mapping.status
    ? [
        ...new Set(
          records
            .map((record) => record.values[mapping.status!])
            .filter(
              (value): value is string =>
                typeof value === "string" &&
                /^(done|complete|completed|완료)$/i.test(value),
            ),
        ),
      ]
    : [];
  const sourceSignature = `${sheet.name}|${headerRow}|${startColumn}|${endColumn}|${endRow}|${fields.map((field) => field.label).join("|")}`;
  const dataset: Dataset = {
    id: `xlsx-${stableHash(sourceSignature)}`,
    name: options.name?.trim() || sheet.name,
    source: {
      kind: "xlsx",
      fileName: options.fileName,
      sheetName: sheet.name,
      headerRow,
      startColumn,
      endColumn,
      endRow,
      date1904: workbook.date1904,
    },
    fields,
    mapping,
    records,
    revision: 0,
    locale: options.locale ?? "en",
    timeZone: options.timeZone ?? "UTC",
    dateOrder: options.dateOrder ?? "ymd",
    weekStartsOn: options.weekStartsOn ?? 1,
    updatedAt: new Date().toISOString(),
    completedStatuses,
  };
  if (!bytesEqual(bytes, original))
    safety(
      "INVALID_ZIP",
      "The input workbook buffer was unexpectedly mutated.",
    );
  return validateDataset(dataset);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlElementName(localName: string): string {
  return `(?:[A-Za-z_][\\w.-]*:)?${localName}`;
}

function xmlElementPrefix(xml: string | undefined, localName: string): string {
  if (!xml) return "";
  return (
    new RegExp(`^<([A-Za-z_][\\w.-]*:)?${localName}\\b`).exec(xml)?.[1] ?? ""
  );
}

function openTagWithoutType(
  existingOpenTag: string | undefined,
  reference: string,
  styleIndex?: number,
  namespacePrefix = "",
): string {
  const prefix = xmlElementPrefix(existingOpenTag, "c") || namespacePrefix;
  if (!existingOpenTag)
    return `<${prefix}c r="${reference}"${styleIndex === undefined ? "" : ` s="${styleIndex}"`}>`;
  const attributes: string[] = [];
  const attributePattern = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(existingOpenTag))) {
    if (match[1] !== "r" && match[1] !== "t")
      attributes.push(`${match[1]}=${match[2]}`);
  }
  return `<${prefix}c r="${reference}"${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
}

function serializeCell(
  reference: string,
  value: CellValue,
  field: Field,
  date1904: boolean,
  existingOpenTag?: string,
  styleIndex?: number,
  namespacePrefix = "",
): string {
  const open = openTagWithoutType(
    existingOpenTag,
    reference,
    styleIndex,
    namespacePrefix,
  );
  const prefix = xmlElementPrefix(open, "c") || namespacePrefix;
  const tag = (localName: string) => `${prefix}${localName}`;
  if (value === null) return `${open.slice(0, -1)}/>`;
  if (field.type === "date") {
    if (typeof value !== "string")
      safety("INVALID_VALUE", `Date field ${field.label} must use YYYY-MM-DD.`);
    return `${open}<${tag("v")}>${dateToExcelSerial(value, date1904)}</${tag("v")}></${tag("c")}>`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      safety("INVALID_VALUE", `Number field ${field.label} must be finite.`);
    return `${open}<${tag("v")}>${value}</${tag("v")}></${tag("c")}>`;
  }
  if (typeof value === "boolean")
    return `${open.slice(0, -1)} t="b"><${tag("v")}>${value ? "1" : "0"}</${tag("v")}></${tag("c")}>`;
  const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
  return `${open.slice(0, -1)} t="inlineStr"><${tag("is")}><${tag("t")}${space}>${escapeXml(value)}</${tag("t")}></${tag("is")}></${tag("c")}>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCellXml(xml: string, reference: string): string | undefined {
  const quoted = escapeRegExp(reference);
  const cell = xmlElementName("c");
  const pattern = new RegExp(
    `<${cell}\\b(?=[^>]*\\br\\s*=\\s*(?:"${quoted}"|'${quoted}'))[^>]*(?:/>|>[\\s\\S]*?</${cell}\\s*>)`,
    "g",
  );
  const matches = [...xml.matchAll(pattern)];
  if (matches.length > 1)
    safety(
      "INVALID_XML",
      `Worksheet has duplicate XML cells for ${reference}.`,
    );
  return matches[0]?.[0];
}

function replaceCellXml(
  xml: string,
  reference: string,
  replacement: string,
): string {
  const quoted = escapeRegExp(reference);
  const cell = xmlElementName("c");
  const pattern = new RegExp(
    `<${cell}\\b(?=[^>]*\\br\\s*=\\s*(?:"${quoted}"|'${quoted}'))[^>]*(?:/>|>[\\s\\S]*?</${cell}\\s*>)`,
    "g",
  );
  let count = 0;
  const replaced = xml.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  if (count === 1) return replaced;
  if (count > 1)
    safety(
      "INVALID_XML",
      `Worksheet has duplicate XML cells for ${reference}.`,
    );
  const row = parseCellRef(reference).row;
  const rowElement = xmlElementName("row");
  const rowPattern = new RegExp(
    `<${rowElement}\\b(?=[^>]*\\br\\s*=\\s*(?:"${row}"|'${row}'))[^>]*(?:/>|>[\\s\\S]*?</${rowElement}\\s*>)`,
  );
  const rowMatch = rowPattern.exec(xml);
  if (!rowMatch)
    safety(
      "SOURCE_MISMATCH",
      `Source row ${row} is no longer present in the workbook.`,
    );
  const rowXml = rowMatch[0];
  const rowPrefix = xmlElementPrefix(rowXml, "row");
  const closingRow = `</${rowPrefix}row>`;
  const expanded = /\/>$/.test(rowXml)
    ? `${rowXml.slice(0, -2)}>${replacement}${closingRow}`
    : rowXml.replace(
        new RegExp(`</${escapeRegExp(rowPrefix)}row\\s*>$`),
        `${replacement}${closingRow}`,
      );
  return `${xml.slice(0, rowMatch.index)}${expanded}${xml.slice((rowMatch.index ?? 0) + rowXml.length)}`;
}

function xmlOpenTag(cellXml: string | undefined): string | undefined {
  return cellXml?.match(new RegExp(`^<${xmlElementName("c")}\\b[^>]*>`))?.[0];
}

type CellChange = { value: CellValue; field: Field };

function appendRowsXml(
  xml: string,
  rows: Map<number, Map<string, CellChange>>,
  date1904: boolean,
  dateStyleByField: Map<string, number>,
): string {
  if (!rows.size) return xml;
  const prefix = xmlElementPrefix(xml, "worksheet");
  const serializedRows = [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(
      ([row, cells]) =>
        `<${prefix}row r="${row}">${[...cells.entries()]
          .sort(
            ([left], [right]) =>
              parseCellRef(left).column - parseCellRef(right).column,
          )
          .map(([reference, change]) =>
            serializeCell(
              reference,
              change.value,
              change.field,
              date1904,
              undefined,
              dateStyleByField.get(change.field.key),
              prefix,
            ),
          )
          .join("")}</${prefix}row>`,
    )
    .join("");
  const sheetData = `${prefix}sheetData`;
  const selfClosing = new RegExp(`<${escapeRegExp(sheetData)}\\b([^>]*)\\/>`);
  if (selfClosing.test(xml))
    return xml.replace(
      selfClosing,
      `<${sheetData}$1>${serializedRows}</${sheetData}>`,
    );
  const closings = [
    ...xml.matchAll(new RegExp(`</${escapeRegExp(sheetData)}\\s*>`, "g")),
  ];
  const closing = closings.at(-1);
  if (!closing || closing.index === undefined)
    safety(
      "SOURCE_MISMATCH",
      "Worksheet has no sheetData section for a safe append.",
    );
  return `${xml.slice(0, closing.index)}${serializedRows}${xml.slice(closing.index)}`;
}

function parseMergeRange(reference: string): {
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow: number;
} {
  const clean = reference.replace(/\$/g, "");
  const [startReference, endReference = startReference] = clean.split(":");
  const start = parseCellRef(startReference);
  const end = parseCellRef(endReference);
  return {
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
  };
}

function rangesIntersect(
  left: {
    startColumn: number;
    endColumn: number;
    startRow: number;
    endRow: number;
  },
  right: {
    startColumn: number;
    endColumn: number;
    startRow: number;
    endRow: number;
  },
): boolean {
  return (
    left.startColumn <= right.endColumn &&
    left.endColumn >= right.startColumn &&
    left.startRow <= right.endRow &&
    left.endRow >= right.startRow
  );
}

function assertAppendAreaIsSafe(
  xml: string,
  sheet: ParsedSheet,
  source: NonNullable<Dataset["source"]>,
  firstRow: number,
  lastRow: number,
): void {
  const table = {
    startColumn: source.startColumn!,
    endColumn: source.endColumn!,
    startRow: source.headerRow!,
    endRow: source.endRow!,
  };
  const append = {
    startColumn: source.startColumn!,
    endColumn: source.endColumn!,
    startRow: firstRow,
    endRow: lastRow,
  };
  for (const [reference, cell] of sheet.cells) {
    const coordinate = parseCellRef(reference);
    if (coordinate.row >= firstRow && coordinate.row <= lastRow) {
      const reason = cell.hasFormula ? "a formula" : "existing content";
      safety(
        "SOURCE_MISMATCH",
        `Cannot append into row ${coordinate.row}; it contains ${reason}.`,
      );
    }
  }
  const mergePattern = new RegExp(
    `<${xmlElementName("mergeCell")}\\b[^>]*\\bref\\s*=\\s*(?:"([^"]+)"|'([^']+)')[^>]*\\/>`,
    "g",
  );
  for (const match of xml.matchAll(mergePattern)) {
    const merged = parseMergeRange(match[1] ?? match[2]);
    if (rangesIntersect(merged, table) || rangesIntersect(merged, append)) {
      safety(
        "SOURCE_MISMATCH",
        "Append is only supported for a plain rectangular table without intersecting merged cells.",
      );
    }
  }
}

function assertSheetMutation(
  before: string,
  after: string,
  changed: Map<string, CellChange>,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): void {
  const beforeArchive = { files: { "sheet.xml": textEncoder.encode(before) } };
  const afterArchive = { files: { "sheet.xml": textEncoder.encode(after) } };
  const beforeSheet = parseSheet(
    beforeArchive,
    "sheet",
    "sheet.xml",
    false,
    sharedStrings,
    dateStyles,
    date1904,
  );
  const afterSheet = parseSheet(
    afterArchive,
    "sheet",
    "sheet.xml",
    false,
    sharedStrings,
    dateStyles,
    date1904,
  );
  const allReferences = new Set([
    ...beforeSheet.cells.keys(),
    ...afterSheet.cells.keys(),
  ]);
  for (const reference of allReferences) {
    const beforeCell = beforeSheet.cells.get(reference);
    const afterCell = afterSheet.cells.get(reference);
    if (!changed.has(reference)) {
      const same =
        beforeCell?.value === afterCell?.value &&
        beforeCell?.hasFormula === afterCell?.hasFormula &&
        beforeCell?.style === afterCell?.style &&
        beforeCell?.type === afterCell?.type;
      if (!same)
        safety(
          "INVALID_XML",
          `Unselected cell ${reference} changed while exporting.`,
        );
      continue;
    }
    const expected = changed.get(reference)!;
    const afterValue = afterCell?.value ?? null;
    if (
      afterCell?.hasFormula ||
      afterValue !== expected.value ||
      (beforeCell && beforeCell.style !== afterCell?.style)
    ) {
      safety(
        "INVALID_XML",
        `Changed cell ${reference} did not survive XML post-validation.`,
      );
    }
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

interface ModifiedZipEntry {
  content: Uint8Array;
  crc: number;
  compressed: Uint8Array;
  rawLocal: Uint8Array;
}

function makeModifiedLocal(
  entry: ZipEntry,
  content: Uint8Array,
): ModifiedZipEntry {
  const compressed = deflateSync(content, { level: 6 });
  const crc = crc32(content);
  const local = new Uint8Array(30 + entry.nameBytes.length + compressed.length);
  writeU32(local, 0, 0x04034b50);
  writeU16(local, 4, 20);
  writeU16(local, 6, 0);
  writeU16(local, 8, 8);
  writeU16(local, 10, entry.modifiedTime);
  writeU16(local, 12, entry.modifiedDate);
  writeU32(local, 14, crc);
  writeU32(local, 18, compressed.length);
  writeU32(local, 22, content.length);
  writeU16(local, 26, entry.nameBytes.length);
  writeU16(local, 28, 0);
  local.set(entry.nameBytes, 30);
  local.set(compressed, 30 + entry.nameBytes.length);
  return { content, crc, compressed, rawLocal: local };
}

function rebuildZip(
  archive: ZipArchive,
  modifications: Map<string, Uint8Array>,
): Uint8Array {
  const modified = new Map<string, ModifiedZipEntry>();
  for (const [name, content] of modifications) {
    const entry = archive.entries.find((candidate) => candidate.name === name);
    if (!entry)
      safety("INVALID_ZIP", `Cannot patch a missing ZIP member: ${name}`);
    modified.set(name, makeModifiedLocal(entry, content));
  }
  const localOrder = [...archive.entries].sort(
    (left, right) => left.localOffset - right.localOffset,
  );
  const offsets = new Map<string, number>();
  const localParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of localOrder) {
    offsets.set(entry.name, offset);
    const replacement = modified.get(entry.name);
    const local = replacement?.rawLocal ?? entry.rawLocal;
    localParts.push(local);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralParts: Uint8Array[] = [];
  for (const entry of archive.entries) {
    const central = entry.rawCentral.slice();
    const replacement = modified.get(entry.name);
    if (replacement) {
      writeU16(central, 6, 20);
      writeU16(central, 8, 0);
      writeU16(central, 10, 8);
      writeU32(central, 16, replacement.crc);
      writeU32(central, 20, replacement.compressed.length);
      writeU32(central, 24, replacement.content.length);
    }
    writeU32(central, 42, offsets.get(entry.name)!);
    centralParts.push(central);
    offset += central.length;
  }
  const centralSize = offset - centralOffset;
  const eocd = new Uint8Array(22 + archive.comment.length);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, archive.entries.length);
  writeU16(eocd, 10, archive.entries.length);
  writeU32(eocd, 12, centralSize);
  writeU32(eocd, 16, centralOffset);
  writeU16(eocd, 20, archive.comment.length);
  eocd.set(archive.comment, 22);
  return concatBytes([...localParts, ...centralParts, eocd]);
}

function cellValuesEqual(left: CellValue, right: CellValue): boolean {
  return (
    left === right ||
    (typeof left === "number" &&
      typeof right === "number" &&
      Object.is(left, right))
  );
}

/**
 * Export the supplied Dataset back into its original package. Only mapped,
 * changed, non-formula cells are patched; all other local ZIP members are
 * copied directly from the original archive.
 */
export function exportWorkbook(
  original: Uint8Array,
  dataset: Dataset,
): Uint8Array {
  const immutableOriginal = original.slice();
  if (
    dataset.source.kind !== "xlsx" ||
    !dataset.source.sheetName ||
    !dataset.source.headerRow ||
    !dataset.source.startColumn ||
    !dataset.source.endColumn ||
    !dataset.source.endRow
  ) {
    safety(
      "SOURCE_MISMATCH",
      "Dataset does not contain a complete XLSX source selection.",
    );
  }
  validateDataset(dataset);
  const workbook = parseWorkbook(original);
  if (
    dataset.source.date1904 !== undefined &&
    dataset.source.date1904 !== workbook.date1904
  )
    safety("SOURCE_MISMATCH", "Workbook date system changed since import.");
  const sheet = workbook.sheets.find(
    (candidate) => candidate.name === dataset.source.sheetName,
  );
  if (!sheet)
    safety(
      "SOURCE_MISMATCH",
      "Selected worksheet is not present in the original workbook.",
    );

  const fieldsByKey = new Map(
    dataset.fields.map((field) => [field.key, field]),
  );
  const selectedColumns = new Map<string, number>();
  for (const field of dataset.fields) {
    const column = fieldColumn(field.key);
    if (
      !column ||
      column < dataset.source.startColumn ||
      column > dataset.source.endColumn
    )
      safety(
        "SOURCE_MISMATCH",
        `Field ${field.key} is not an explicit selected XLSX column.`,
      );
    selectedColumns.set(field.key, column);
  }
  const byRow = new Set<number>();
  const changes = new Map<string, Map<string, CellChange>>();
  const appendedRows = new Map<number, Map<string, CellChange>>();
  const recordsToAppend = dataset.records.filter(
    (record) => record.sourceRow === undefined,
  );
  const appendFirstRow = Math.max(dataset.source.endRow, sheet.maxRow) + 1;
  const appendDateStyles = new Map<string, number>();
  for (const field of dataset.fields.filter(
    (candidate) => candidate.type === "date",
  )) {
    const column = selectedColumns.get(field.key)!;
    const sourceDateCell = [...sheet.cells.entries()].find(
      ([reference, cell]) => {
        const coordinate = parseCellRef(reference);
        return (
          coordinate.column === column &&
          coordinate.row > dataset.source.headerRow! &&
          coordinate.row <= dataset.source.endRow! &&
          workbook.dateStyles.has(cell.style)
        );
      },
    );
    if (recordsToAppend.length && !sourceDateCell)
      safety(
        "SOURCE_MISMATCH",
        `Cannot append date field ${field.label} without an existing date-cell style.`,
      );
    if (sourceDateCell)
      appendDateStyles.set(field.key, sourceDateCell[1].style);
  }
  if (
    recordsToAppend.length &&
    appendFirstRow + recordsToAppend.length - 1 > 1_048_576
  )
    safety(
      "SOURCE_MISMATCH",
      "There is no remaining Excel row for a safe append.",
    );
  if (recordsToAppend.length) {
    const before = readXml(workbook.archive, sheet.path);
    assertAppendAreaIsSafe(
      before,
      sheet,
      dataset.source,
      appendFirstRow,
      appendFirstRow + recordsToAppend.length - 1,
    );
  }
  let appendOffset = 0;
  for (const record of dataset.records) {
    if (record.sourceRow === undefined) {
      const row = appendFirstRow + appendOffset;
      appendOffset += 1;
      const rowChanges = new Map<string, CellChange>();
      for (const field of dataset.fields) {
        const column = selectedColumns.get(field.key);
        if (!column)
          safety(
            "SOURCE_MISMATCH",
            `Field ${field.key} is not an explicit selected XLSX column.`,
          );
        if (record.lockedFields?.includes(field.key))
          safety(
            "FORMULA_LOCKED",
            `New record ${record.id} contains a locked formula field.`,
          );
        const value = record.values[field.key] ?? null;
        if (value !== null)
          rowChanges.set(cellRef(column, row), { value, field });
      }
      if (!rowChanges.size)
        safety(
          "INVALID_VALUE",
          `New record ${record.id} has no value to append.`,
        );
      appendedRows.set(row, rowChanges);
      continue;
    }
    if (
      !Number.isInteger(record.sourceRow) ||
      !record.sourceRow ||
      record.sourceRow <= dataset.source.headerRow ||
      record.sourceRow > dataset.source.endRow
    ) {
      safety(
        "SOURCE_MISMATCH",
        `Record ${record.id} has no valid XLSX source row.`,
      );
    }
    if (byRow.has(record.sourceRow))
      safety(
        "SOURCE_MISMATCH",
        `Multiple records reference XLSX row ${record.sourceRow}.`,
      );
    byRow.add(record.sourceRow);
    for (const [key, value] of Object.entries(record.values)) {
      const column = selectedColumns.get(key);
      const field = fieldsByKey.get(key);
      if (!column || !field)
        safety(
          "SOURCE_MISMATCH",
          `Record ${record.id} contains a field outside its XLSX selection.`,
        );
      const reference = cellRef(column, record.sourceRow);
      const originalCell = sheet.cells.get(reference);
      const originalValue = originalCell?.value ?? null;
      if (cellValuesEqual(originalValue, value)) continue;
      if (originalCell?.hasFormula || record.lockedFields?.includes(key))
        safety("FORMULA_LOCKED", `Formula cell ${reference} is read-only.`);
      const sheetChanges =
        changes.get(sheet.path) ?? new Map<string, CellChange>();
      if (sheetChanges.has(reference))
        safety(
          "SOURCE_MISMATCH",
          `Multiple changes target XLSX cell ${reference}.`,
        );
      sheetChanges.set(reference, { value, field });
      changes.set(sheet.path, sheetChanges);
    }
  }
  if (!changes.size && !appendedRows.size) return original.slice();

  const modifiedParts = new Map<string, Uint8Array>();
  const pathsToModify = new Set([
    ...changes.keys(),
    ...(appendedRows.size ? [sheet.path] : []),
  ]);
  for (const path of pathsToModify) {
    const sheetChanges = changes.get(path) ?? new Map<string, CellChange>();
    const before = readXml(workbook.archive, path);
    let after = before;
    for (const [reference, change] of sheetChanges) {
      const existing = findCellXml(after, reference);
      after = replaceCellXml(
        after,
        reference,
        serializeCell(
          reference,
          change.value,
          change.field,
          workbook.date1904,
          xmlOpenTag(existing),
          undefined,
          xmlElementPrefix(after, "worksheet"),
        ),
      );
    }
    if (path === sheet.path)
      after = appendRowsXml(
        after,
        appendedRows,
        workbook.date1904,
        appendDateStyles,
      );
    const valid = XMLValidator.validate(after);
    if (valid !== true)
      safety("INVALID_XML", `Patched worksheet XML is invalid: ${path}.`);
    const allChanges = new Map(sheetChanges);
    if (path === sheet.path)
      for (const [row, cells] of appendedRows)
        for (const [reference, change] of cells)
          allChanges.set(reference, change);
    assertSheetMutation(
      before,
      after,
      allChanges,
      workbook.sharedStrings,
      workbook.dateStyles,
      workbook.date1904,
    );
    modifiedParts.set(path, textEncoder.encode(after));
  }
  const output = rebuildZip(workbook.archive, modifiedParts);
  if (!bytesEqual(original, immutableOriginal))
    safety(
      "INVALID_ZIP",
      "The original workbook buffer was unexpectedly mutated.",
    );
  const verified = parseWorkbook(output);
  for (const path of pathsToModify) {
    const sheetChanges = changes.get(path) ?? new Map<string, CellChange>();
    const verifiedSheet = verified.sheets.find(
      (candidate) => candidate.path === path,
    );
    if (!verifiedSheet)
      safety("INVALID_ZIP", "Patched worksheet is missing after export.");
    const allChanges = new Map(sheetChanges);
    if (path === sheet.path)
      for (const [, cells] of appendedRows)
        for (const [reference, change] of cells)
          allChanges.set(reference, change);
    for (const [reference, expected] of allChanges) {
      const cell = verifiedSheet.cells.get(reference);
      if (
        !cell ||
        cell.hasFormula ||
        !cellValuesEqual(cell.value, expected.value)
      )
        safety(
          "INVALID_ZIP",
          `Patched cell ${reference} failed post-export verification.`,
        );
    }
  }
  return output;
}

/**
 * Match a refreshed import only by a unique explicit identity or an exact row
 * signature. It intentionally never uses sourceRow as a re-import identity.
 */
export function reimportWorkbook(
  existing: Dataset,
  bytes: Uint8Array,
  options: ImportWorkbookOptions = {},
): ReimportResult {
  const incoming = importWorkbook(bytes, {
    ...options,
    sheetName: options.sheetName ?? existing.source.sheetName,
    headerRow: options.headerRow ?? existing.source.headerRow,
    startColumn: options.startColumn ?? existing.source.startColumn,
    endColumn: options.endColumn ?? existing.source.endColumn,
    endRow: options.endRow ?? existing.source.endRow,
    mapping: options.mapping ?? existing.mapping,
    name: options.name ?? existing.name,
    dateOrder: options.dateOrder ?? existing.dateOrder,
    locale: options.locale ?? existing.locale,
    timeZone: options.timeZone ?? existing.timeZone,
    weekStartsOn: options.weekStartsOn ?? existing.weekStartsOn,
  });
  const conflicts: ReimportConflict[] = [];
  const identity = existing.mapping.identity;
  const oldIndex = new Map<string, WorkRecord[]>();
  const incomingIndex = new Map<string, WorkRecord[]>();
  const keyFor = (record: WorkRecord, fields: Field[]) =>
    identity
      ? identityValue(record, identity)
      : exactSignature(record.values, fields);
  for (const record of existing.records) {
    const key = keyFor(record, existing.fields);
    if (!key) {
      conflicts.push({
        kind: "unmatched_record",
        recordId: record.id,
        field: identity,
        message: "An existing record has no usable explicit identity.",
      });
      continue;
    }
    oldIndex.set(key, [...(oldIndex.get(key) ?? []), record]);
  }
  for (const record of incoming.records) {
    const key = keyFor(record, incoming.fields);
    if (!key) {
      conflicts.push({
        kind: "unmatched_record",
        incomingRecordId: record.id,
        field: identity,
        message: "An incoming record has no usable explicit identity.",
      });
      continue;
    }
    incomingIndex.set(key, [...(incomingIndex.get(key) ?? []), record]);
  }
  for (const [key, oldRecords] of oldIndex) {
    const incomingRecords = incomingIndex.get(key) ?? [];
    if (oldRecords.length !== 1 || incomingRecords.length !== 1) {
      conflicts.push({
        kind: identity ? "ambiguous_identity" : "ambiguous_exact_match",
        recordId: oldRecords[0]?.id,
        incomingRecordId: incomingRecords[0]?.id,
        field: identity,
        message:
          "Re-import match is ambiguous and was not guessed from row number.",
      });
    } else incomingRecords[0].id = oldRecords[0].id;
  }
  for (const [key, incomingRecords] of incomingIndex) {
    if (!oldIndex.has(key))
      conflicts.push({
        kind: "unmatched_record",
        incomingRecordId: incomingRecords[0]?.id,
        field: identity,
        message: "Incoming record has no exact existing match.",
      });
  }
  if (conflicts.length) return { conflicts };
  return {
    dataset: validateDataset({
      ...incoming,
      id: existing.id,
      revision: existing.revision,
      updatedAt: existing.updatedAt,
    }),
    conflicts,
  };
}
