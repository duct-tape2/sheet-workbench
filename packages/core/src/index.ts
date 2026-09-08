import type {
  CellValue,
  ChangeEntry,
  Dataset,
  Field,
  FieldType,
  Locale,
  Mapping,
  RecordPatch,
  Role,
  SourceInfo,
  WorkRecord,
} from "./types";
export * from "./types";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function assertRole(role: Role | undefined, write = false) {
  if (!role || (write && role === "viewer"))
    throw new DomainError(
      "FORBIDDEN",
      "Your workspace role does not allow this action.",
    );
}
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set<FieldType>([
  "text",
  "date",
  "number",
  "select",
  "url",
]);
const mappingKeys = new Set<keyof Mapping>([
  "title",
  "date",
  "assignee",
  "status",
  "category",
  "url",
  "identity",
]);
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/;
export function keyIsSafe(key: string) {
  return (
    typeof key === "string" &&
    /^[\p{L}\p{N}_. -]{1,100}$/u.test(key) &&
    !unsafeKeys.has(key)
  );
}
function isExcelColumn(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Z]{1,3}$/.test(value)) return false;
  let column = 0;
  for (const character of value)
    column = column * 26 + character.charCodeAt(0) - 64;
  return column <= 16_384;
}
export function normalizeLabel(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en");
}
export function labelKey(value: unknown) {
  return normalizeLabel(value).replace(/\s/g, "");
}
export function categoryIndex(value: unknown) {
  let hash = 2166136261;
  for (const ch of labelKey(value)) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 8;
}
export function isoDate(
  year: number,
  month: number,
  day: number,
): string | null {
  if (
    year < 1900 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  )
    return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  )
    return null;
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function parseDate(
  value: unknown,
  order: Dataset["dateOrder"] = "ymd",
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !["ymd", "dmy", "mdy"].includes(order))
    return null;
  const text = String(value).trim();
  const ymd = /^(\d{4})([-./])(\d{1,2})\2(\d{1,2})$/.exec(text);
  if (ymd) return isoDate(+ymd[1], +ymd[3], +ymd[4]);
  const local = /^(\d{1,2})([-./])(\d{1,2})\2(\d{4})$/.exec(text);
  if (!local || order === "ymd") return null;
  return isoDate(
    +local[4],
    +(order === "dmy" ? local[3] : local[1]),
    +(order === "dmy" ? local[1] : local[3]),
  );
}
export function excelDate(serial: number, date1904 = false): string | null {
  if (
    !Number.isFinite(serial) ||
    serial < 0 ||
    (!date1904 && Math.floor(serial) === 60)
  )
    return null;
  const offset = date1904 ? serial : serial > 60 ? serial - 1 : serial;
  const dt = new Date(
    Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) +
      Math.floor(offset) * 86400000,
  );
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export function addDays(date: string, days: number) {
  if (!parseDate(date))
    throw new DomainError(
      "INVALID_DATE",
      "Use a real date in YYYY-MM-DD format.",
    );
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function todayIn(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
}
export function weekRange(date: string, startsOn: 0 | 1 = 1) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const start = addDays(date, -((day - startsOn + 7) % 7));
  return { start, end: addDays(start, 6) };
}
export function weekLabel(
  date: string,
  locale: Locale = "en",
  startsOn: 0 | 1 = 1,
) {
  const range = weekRange(date, startsOn);
  const majority = addDays(range.start, 3);
  const first = weekRange(majority.slice(0, 8) + "01", startsOn);
  const firstOwned =
    addDays(first.start, 3).slice(0, 7) === majority.slice(0, 7)
      ? first.start
      : addDays(first.start, 7);
  const nth =
    Math.round((Date.parse(range.start) - Date.parse(firstOwned)) / 604800000) +
    1;
  const ym = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${majority}T12:00:00Z`));
  return locale === "ko" ? `${ym} ${nth}주차` : `${ym} · Week ${nth}`;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function isSafeTimestamp(value: unknown): value is string {
  return isBoundedText(value, 64) && !Number.isNaN(Date.parse(value));
}
function assertStableId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !stableIdPattern.test(value))
    throw new DomainError(
      "INVALID_ID",
      `${label} must be a stable 1–150 character identifier.`,
    );
}
function validateFields(fields: Field[]): Map<string, Field> {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 100)
    throw new DomainError("LIMIT", "Use 1–100 fields.");
  const byKey = new Map<string, Field>();
  for (const field of fields) {
    if (
      !isPlainRecord(field) ||
      !keyIsSafe(field.key) ||
      !isBoundedText(field.label, 160) ||
      !fieldTypes.has(field.type)
    )
      throw new DomainError(
        "INVALID_FIELDS",
        "Each field needs a safe key, label, and supported type.",
      );
    if (field.required !== undefined && typeof field.required !== "boolean")
      throw new DomainError(
        "INVALID_FIELDS",
        `${field.label}: required must be true or false.`,
      );
    if (field.options !== undefined) {
      if (
        !Array.isArray(field.options) ||
        field.options.length > 100 ||
        field.options.some((option) => !isBoundedText(option, 120)) ||
        new Set(field.options).size !== field.options.length
      )
        throw new DomainError(
          "INVALID_FIELDS",
          `${field.label}: options must be unique non-empty labels.`,
        );
      if (field.type !== "select")
        throw new DomainError(
          "INVALID_FIELDS",
          `${field.label}: options are only valid for select fields.`,
        );
    }
    if (byKey.has(field.key))
      throw new DomainError(
        "INVALID_FIELDS",
        "Column keys must be safe and unique.",
      );
    byKey.set(field.key, field);
  }
  return byKey;
}
function validateSource(source: SourceInfo): {
  headerRow?: number;
  startColumn?: number;
  endColumn?: number;
  endRow?: number;
} {
  if (
    !isPlainRecord(source) ||
    !["demo", "xlsx", "google"].includes(source.kind)
  )
    throw new DomainError("INVALID_SOURCE", "Dataset source is invalid.");
  for (const key of ["fileName", "sheetName", "spreadsheetId"] as const)
    if (
      source[key] !== undefined &&
      !isBoundedText(source[key], key === "sheetName" ? 200 : 255)
    )
      throw new DomainError("INVALID_SOURCE", `Source ${key} is invalid.`);
  if (
    source.connectedBy !== undefined &&
    !isBoundedText(source.connectedBy, 150)
  )
    throw new DomainError(
      "INVALID_SOURCE",
      "Source connection identity is invalid.",
    );
  if (
    source.identityColumn !== undefined &&
    !isExcelColumn(source.identityColumn)
  )
    throw new DomainError(
      "INVALID_SOURCE",
      "Source identity column is invalid.",
    );
  if (source.readOnly !== undefined && typeof source.readOnly !== "boolean")
    throw new DomainError("INVALID_SOURCE", "Source readOnly must be boolean.");
  if (
    source.readOnlyReason !== undefined &&
    !isBoundedText(source.readOnlyReason, 500)
  )
    throw new DomainError(
      "INVALID_SOURCE",
      "Source readOnlyReason is invalid.",
    );
  if (source.readOnly && !isBoundedText(source.readOnlyReason, 500))
    throw new DomainError(
      "INVALID_SOURCE",
      "Read-only sources require a reason.",
    );
  if (
    source.sourceColumns !== undefined &&
    (!isPlainRecord(source.sourceColumns) ||
      Object.keys(source.sourceColumns).length > 100 ||
      Object.entries(source.sourceColumns).some(
        ([key, column]) => !keyIsSafe(key) || !isExcelColumn(column),
      ))
  )
    throw new DomainError("INVALID_SOURCE", "Source columns are invalid.");
  if (
    source.sourceHeaders !== undefined &&
    (!isPlainRecord(source.sourceHeaders) ||
      Object.keys(source.sourceHeaders).length > 100 ||
      Object.entries(source.sourceHeaders).some(
        ([key, header]) => !keyIsSafe(key) || !isBoundedText(header, 200),
      ))
  )
    throw new DomainError("INVALID_SOURCE", "Source headers are invalid.");
  if (
    source.sheetId !== undefined &&
    (!Number.isSafeInteger(source.sheetId) || source.sheetId < 0)
  )
    throw new DomainError("INVALID_SOURCE", "Source sheet ID is invalid.");
  if (source.date1904 !== undefined && typeof source.date1904 !== "boolean")
    throw new DomainError("INVALID_SOURCE", "Source date1904 must be boolean.");
  const selectionKeys = [
    "headerRow",
    "startColumn",
    "endColumn",
    "endRow",
  ] as const;
  const hasSelection =
    selectionKeys.some((key) => source[key] !== undefined) ||
    (source.sheetName !== undefined && source.kind === "xlsx");
  if ((source.kind === "xlsx" || source.kind === "google") && hasSelection) {
    if (!isBoundedText(source.sheetName, 200))
      throw new DomainError(
        "INVALID_SOURCE",
        "Worksheet source selection requires a worksheet name.",
      );
    const headerRow = source.headerRow;
    const startColumn = source.startColumn;
    const endColumn = source.endColumn;
    const endRow = source.endRow;
    if (
      ![headerRow, startColumn, endColumn, endRow].every(
        Number.isSafeInteger,
      ) ||
      !headerRow ||
      !startColumn ||
      !endColumn ||
      !endRow ||
      headerRow < 1 ||
      endRow > 1_048_576 ||
      startColumn < 1 ||
      endColumn < 1 ||
      startColumn > 16_384 ||
      endColumn > 16_384 ||
      startColumn > endColumn ||
      headerRow >= endRow
    )
      throw new DomainError(
        "INVALID_SOURCE",
        "Worksheet source range is invalid.",
      );
    return { headerRow, startColumn, endColumn, endRow };
  }
  if (
    source.kind === "google" &&
    (!isBoundedText(source.spreadsheetId, 255) ||
      !isBoundedText(source.sheetName, 200))
  )
    throw new DomainError(
      "INVALID_SOURCE",
      "Google source requires a spreadsheet and worksheet identity.",
    );
  return {};
}
function validateMapping(
  mapping: Mapping,
  fieldsByKey: Map<string, Field>,
): void {
  if (
    !isPlainRecord(mapping) ||
    Object.keys(mapping).some((key) => !mappingKeys.has(key as keyof Mapping))
  )
    throw new DomainError(
      "INVALID_MAPPING",
      "Mapping contains an unsupported field.",
    );
  if (!isBoundedText(mapping.title, 100) || !fieldsByKey.has(mapping.title))
    throw new DomainError("INVALID_MAPPING", "Map a title column.");
  for (const key of mappingKeys)
    if (
      key !== "title" &&
      mapping[key] !== undefined &&
      (typeof mapping[key] !== "string" || !fieldsByKey.has(mapping[key]!))
    )
      throw new DomainError(
        "INVALID_MAPPING",
        `Mapping ${key} must reference an existing field.`,
      );
}
function validateValue(
  field: Field,
  value: unknown,
): asserts value is CellValue {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value))
    throw new DomainError(
      "INVALID_VALUE",
      `${field.label}: use plain text, a number or a date.`,
    );
  if (typeof value === "number" && !Number.isFinite(value))
    throw new DomainError(
      "INVALID_NUMBER",
      `${field.label}: use a finite number.`,
    );
  if (typeof value === "string" && value.length > 10000)
    throw new DomainError(
      "VALUE_TOO_LONG",
      `${field.label}: maximum 10,000 characters.`,
    );
  if (field.required && (value == null || String(value).trim() === ""))
    throw new DomainError("REQUIRED_FIELD", `${field.label} is required.`);
  if (value === null || value === "") return;
  if (field.type === "number" && typeof value !== "number")
    throw new DomainError("INVALID_NUMBER", `${field.label}: use a number.`);
  if (
    field.type === "date" &&
    (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !parseDate(value))
  )
    throw new DomainError(
      "INVALID_DATE",
      `${field.label}: use a real YYYY-MM-DD date.`,
    );
  if (field.type === "url" && (typeof value !== "string" || !safeUrl(value)))
    throw new DomainError(
      "INVALID_URL",
      `${field.label}: use an http or https address.`,
    );
  if (
    field.type === "select" &&
    (typeof value !== "string" ||
      (field.options?.length && !field.options.includes(value)))
  )
    throw new DomainError(
      "INVALID_OPTION",
      `${field.label}: choose one of the configured options.`,
    );
}
function validateValuesWithMap(
  fields: Field[],
  fieldsByKey: Map<string, Field>,
  values: Record<string, CellValue>,
  partial: boolean,
): Record<string, CellValue> {
  if (!isPlainRecord(values))
    throw new DomainError("INVALID_VALUES", "Values must be a plain object.");
  for (const [key, value] of Object.entries(values)) {
    const field = fieldsByKey.get(key);
    if (!keyIsSafe(key) || !field)
      throw new DomainError("UNKNOWN_FIELD", `Unknown field: ${key}`);
    validateValue(field, value);
  }
  if (!partial)
    for (const field of fields)
      if (
        field.required &&
        (values[field.key] == null || String(values[field.key]).trim() === "")
      )
        throw new DomainError("REQUIRED_FIELD", `${field.label} is required.`);
  return values;
}
function validateSourceValues(
  fieldsByKey: Map<string, Field>,
  values: Record<string, CellValue>,
): void {
  if (!isPlainRecord(values))
    throw new DomainError(
      "INVALID_SOURCE_VALUES",
      "Source values must be a plain object.",
    );
  for (const [key, value] of Object.entries(values)) {
    if (!keyIsSafe(key) || !fieldsByKey.has(key))
      throw new DomainError(
        "INVALID_SOURCE_VALUES",
        `Unknown source field: ${key}`,
      );
    if (
      value !== null &&
      !["string", "number", "boolean"].includes(typeof value)
    )
      throw new DomainError(
        "INVALID_SOURCE_VALUES",
        "Source values must be scalar values.",
      );
    if (typeof value === "number" && !Number.isFinite(value))
      throw new DomainError(
        "INVALID_SOURCE_VALUES",
        "Source numbers must be finite.",
      );
    if (typeof value === "string" && value.length > 10_000)
      throw new DomainError(
        "INVALID_SOURCE_VALUES",
        "Source text is too long.",
      );
  }
}
export function validateValues(
  fields: Field[],
  values: Record<string, CellValue>,
  partial = false,
) {
  return validateValuesWithMap(fields, validateFields(fields), values, partial);
}
export function validateDataset(dataset: Dataset): Dataset {
  if (
    !isPlainRecord(dataset) ||
    !Array.isArray(dataset.fields) ||
    !Array.isArray(dataset.records)
  )
    throw new DomainError("INVALID_DATASET", "Invalid dataset.");
  assertStableId(dataset.id, "Dataset ID");
  if (!isBoundedText(dataset.name, 160))
    throw new DomainError(
      "INVALID_NAME",
      "Dataset name must be 1–160 characters.",
    );
  if (dataset.records.length > 10_000)
    throw new DomainError("LIMIT", "Maximum 10,000 records.");
  const fieldsByKey = validateFields(dataset.fields);
  const sourceRange = validateSource(dataset.source);
  if (
    dataset.source.sourceColumns &&
    Object.keys(dataset.source.sourceColumns).some(
      (key) => !fieldsByKey.has(key),
    )
  )
    throw new DomainError(
      "INVALID_SOURCE",
      "Source columns must reference imported fields.",
    );
  if (
    dataset.source.sourceHeaders &&
    Object.keys(dataset.source.sourceHeaders).some(
      (key) => !fieldsByKey.has(key),
    )
  )
    throw new DomainError(
      "INVALID_SOURCE",
      "Source headers must reference imported fields.",
    );
  validateMapping(dataset.mapping, fieldsByKey);
  if (
    !["en", "ko"].includes(dataset.locale) ||
    !["ymd", "dmy", "mdy"].includes(dataset.dateOrder) ||
    ![0, 1].includes(dataset.weekStartsOn)
  )
    throw new DomainError(
      "INVALID_SETTINGS",
      "Check locale, date order and week start.",
    );
  if (!isBoundedText(dataset.timeZone, 100))
    throw new DomainError("INVALID_TIMEZONE", "Choose a valid IANA time zone.");
  try {
    todayIn(dataset.timeZone);
  } catch {
    throw new DomainError("INVALID_TIMEZONE", "Choose a valid IANA time zone.");
  }
  if (!Number.isSafeInteger(dataset.revision) || dataset.revision < 0)
    throw new DomainError(
      "INVALID_REVISION",
      "Dataset revision must be nonnegative.",
    );
  if (
    typeof dataset.updatedAt !== "string" ||
    Number.isNaN(Date.parse(dataset.updatedAt))
  )
    throw new DomainError(
      "INVALID_UPDATED_AT",
      "Dataset updatedAt must be an ISO timestamp.",
    );
  if (
    dataset.lastCheckedAt !== undefined &&
    !isSafeTimestamp(dataset.lastCheckedAt)
  )
    throw new DomainError(
      "INVALID_LAST_CHECKED_AT",
      "Dataset lastCheckedAt must be a valid timestamp.",
    );
  if (
    dataset.lastSyncError !== undefined &&
    (typeof dataset.lastSyncError !== "string" ||
      !/^[A-Z][A-Z0-9_:-]{0,99}$/.test(dataset.lastSyncError))
  )
    throw new DomainError(
      "INVALID_LAST_SYNC_ERROR",
      "Dataset lastSyncError must be a safe error code.",
    );
  if (
    !Array.isArray(dataset.completedStatuses) ||
    dataset.completedStatuses.length > 100 ||
    dataset.completedStatuses.some((status) => !isBoundedText(status, 120)) ||
    new Set(dataset.completedStatuses).size !== dataset.completedStatuses.length
  )
    throw new DomainError(
      "INVALID_STATUSES",
      "Completed statuses must be unique labels.",
    );
  if (
    dataset.categoryColors !== undefined &&
    (!isPlainRecord(dataset.categoryColors) ||
      Object.keys(dataset.categoryColors).length > 100 ||
      Object.entries(dataset.categoryColors).some(
        ([key, color]) =>
          !keyIsSafe(key) ||
          key !== labelKey(key) ||
          !Number.isInteger(color) ||
          color < 0 ||
          color > 7,
      ))
  )
    throw new DomainError(
      "INVALID_CATEGORY_COLORS",
      "Category colors must map normalized labels to palette values 0–7.",
    );
  const recordIds = new Set<string>();
  const sourceRows = new Set<number>();
  const identityValues = new Set<string>();
  for (const record of dataset.records) {
    if (!isPlainRecord(record))
      throw new DomainError("INVALID_RECORD", "Invalid record.");
    assertStableId(record.id, "Record ID");
    if (recordIds.has(record.id))
      throw new DomainError("DUPLICATE_ID", "Record IDs must be unique.");
    recordIds.add(record.id);
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !isPlainRecord(record.values)
    )
      throw new DomainError(
        "INVALID_RECORD",
        "Invalid record revision or values.",
      );
    validateValuesWithMap(dataset.fields, fieldsByKey, record.values, false);
    if (record.sourceValues !== undefined)
      validateSourceValues(fieldsByKey, record.sourceValues);
    if (record.sourceRow !== undefined) {
      if (
        !Number.isSafeInteger(record.sourceRow) ||
        record.sourceRow < 1 ||
        record.sourceRow > 1_048_576 ||
        sourceRows.has(record.sourceRow)
      )
        throw new DomainError(
          "INVALID_SOURCE_ROW",
          "Source rows must be unique worksheet row numbers.",
        );
      if (
        sourceRange.headerRow !== undefined &&
        (record.sourceRow <= sourceRange.headerRow ||
          record.sourceRow > sourceRange.endRow!)
      )
        throw new DomainError(
          "INVALID_SOURCE_ROW",
          "Source row is outside the selected worksheet range.",
        );
      sourceRows.add(record.sourceRow);
    }
    if (
      record.lockedFields !== undefined &&
      (!Array.isArray(record.lockedFields) ||
        record.lockedFields.length > dataset.fields.length ||
        record.lockedFields.some(
          (key) => typeof key !== "string" || !fieldsByKey.has(key),
        ) ||
        new Set(record.lockedFields).size !== record.lockedFields.length)
    )
      throw new DomainError(
        "INVALID_LOCKS",
        "Locked fields must be unique imported field keys.",
      );
    if (dataset.mapping.identity) {
      const identity = record.values[dataset.mapping.identity];
      if (identity === null || identity === undefined || identity === "")
        throw new DomainError(
          "INVALID_IDENTITY",
          "Every record needs a source identity value.",
        );
      const signature = `${typeof identity}:${String(identity)}`;
      if (identityValues.has(signature))
        throw new DomainError(
          "DUPLICATE_IDENTITY",
          "Source identity values must be unique.",
        );
      identityValues.add(signature);
    }
  }
  return dataset;
}
export function safeUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function applyRecordPatch(
  dataset: Dataset,
  patch: RecordPatch,
  actor: string,
  now = new Date().toISOString(),
) {
  validateDataset(dataset);
  if (!isPlainRecord(patch))
    throw new DomainError(
      "INVALID_OPERATION",
      "A valid operation is required.",
    );
  assertStableId(patch.operationId, "Operation ID");
  if (
    !Number.isSafeInteger(patch.baseRevision) ||
    patch.baseRevision < 0 ||
    typeof patch.recordId !== "string"
  )
    throw new DomainError(
      "INVALID_OPERATION",
      "A valid operation revision and record ID are required.",
    );
  const index = dataset.records.findIndex((r) => r.id === patch.recordId);
  const existing = dataset.records[index];
  if (!existing)
    throw new DomainError("NOT_FOUND", "The record no longer exists.");
  if (existing.revision !== patch.baseRevision)
    throw new DomainError(
      "CONFLICT",
      "This record changed. Review the current values before saving.",
      { current: existing, proposed: patch.changes },
    );
  if (
    !isPlainRecord(patch.changes) ||
    !Object.keys(patch.changes).length ||
    Object.keys(patch.changes).length > dataset.fields.length
  )
    throw new DomainError(
      "EMPTY_PATCH",
      "Provide one or more valid field changes.",
    );
  for (const key of Object.keys(patch.changes))
    if (
      existing.lockedFields?.includes(key) ||
      key === dataset.mapping.identity
    )
      throw new DomainError(
        "READ_ONLY",
        "Formula and source ID cells are read-only.",
      );
  validateValues(dataset.fields, patch.changes, true);
  const before: Record<string, CellValue> = {};
  for (const key of Object.keys(patch.changes))
    before[key] = existing.values[key] ?? null;
  const record = {
    ...existing,
    revision: existing.revision + 1,
    values: { ...existing.values, ...patch.changes },
  };
  const records = [...dataset.records];
  records[index] = record;
  const entry: ChangeEntry = {
    id: patch.operationId,
    operationId: patch.operationId,
    recordId: record.id,
    actor,
    at: now,
    before,
    after: { ...patch.changes },
    revision: record.revision,
  };
  const next = validateDataset({
    ...dataset,
    records,
    revision: dataset.revision + 1,
    updatedAt: now,
  });
  return { dataset: next, record, entry };
}
export function undoChange(
  dataset: Dataset,
  entry: ChangeEntry,
  operationId: string,
  actor: string,
) {
  validateDataset(dataset);
  assertStableId(operationId, "Operation ID");
  if (
    !isPlainRecord(entry) ||
    !isPlainRecord(entry.after) ||
    !isPlainRecord(entry.before) ||
    typeof entry.recordId !== "string" ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0
  )
    throw new DomainError("INVALID_OPERATION", "Undo entry is invalid.");
  const record = dataset.records.find((r) => r.id === entry.recordId);
  if (
    !record ||
    record.revision !== entry.revision ||
    Object.entries(entry.after).some(([k, v]) => record.values[k] !== v)
  )
    throw new DomainError(
      "CONFLICT",
      "This record changed after that edit. Undo would overwrite newer work.",
    );
  return applyRecordPatch(
    dataset,
    {
      operationId,
      recordId: record.id,
      baseRevision: record.revision,
      changes: entry.before,
    },
    actor,
  );
}
export function createRecord(
  dataset: Dataset,
  values: Record<string, CellValue>,
  id: string = crypto.randomUUID(),
): WorkRecord {
  validateDataset(dataset);
  assertStableId(id, "Record ID");
  validateValues(dataset.fields, values);
  if (!String(values[dataset.mapping.title] ?? "").trim())
    throw new DomainError("REQUIRED_FIELD", "A title is required.");
  if (dataset.records.some((r) => r.id === id))
    throw new DomainError("DUPLICATE_ID", "Record ID already exists.");
  if (dataset.mapping.identity) {
    const identity = values[dataset.mapping.identity];
    if (identity === null || identity === undefined || identity === "")
      throw new DomainError(
        "INVALID_IDENTITY",
        "New records need a non-empty source identity value.",
      );
    const signature = `${typeof identity}:${String(identity)}`;
    if (
      dataset.records.some(
        (record) =>
          `${typeof record.values[dataset.mapping.identity!]}:${String(record.values[dataset.mapping.identity!])}` ===
          signature,
      )
    )
      throw new DomainError(
        "DUPLICATE_IDENTITY",
        "Source identity values must be unique.",
      );
  }
  return { id, revision: 0, values };
}
export interface RecordFilter {
  query?: string;
  status?: string;
  assignee?: string;
  category?: string;
  start?: string;
  end?: string;
}
export function recordDate(dataset: Dataset, record: WorkRecord) {
  return dataset.mapping.date
    ? parseDate(record.values[dataset.mapping.date], dataset.dateOrder)
    : null;
}
export function filterRecords(dataset: Dataset, filters: RecordFilter = {}) {
  const needle = normalizeLabel(filters.query);
  return dataset.records.filter((r) => {
    if (
      needle &&
      !Object.values(r.values).some((v) => normalizeLabel(v).includes(needle))
    )
      return false;
    for (const field of ["status", "assignee", "category"] as const)
      if (
        filters[field] &&
        labelKey(r.values[dataset.mapping[field] ?? ""]) !==
          labelKey(filters[field])
      )
        return false;
    const date = recordDate(dataset, r);
    if ((filters.start || filters.end) && !date) return false;
    return (
      (!filters.start || date! >= filters.start) &&
      (!filters.end || date! <= filters.end)
    );
  });
}
export function isCompleted(dataset: Dataset, record: WorkRecord) {
  return (
    !!dataset.mapping.status &&
    dataset.completedStatuses.some(
      (s) => labelKey(s) === labelKey(record.values[dataset.mapping.status!]),
    )
  );
}
export function report(dataset: Dataset, filters: RecordFilter = {}) {
  const rows = filterRecords(dataset, filters).sort(
    (a, b) =>
      (recordDate(dataset, a) ?? "").localeCompare(
        recordDate(dataset, b) ?? "",
      ) ||
      String(a.values[dataset.mapping.title]).localeCompare(
        String(b.values[dataset.mapping.title]),
      ),
  );
  const groups = new Map<string, WorkRecord[]>();
  for (const row of rows) {
    const status = String(
      row.values[dataset.mapping.status ?? ""] ||
        (dataset.locale === "ko" ? "상태 없음" : "No status"),
    );
    groups.set(status, [...(groups.get(status) ?? []), row]);
  }
  const heading = dataset.locale === "ko" ? "주간 보고" : "Weekly report";
  const lines = [
    `# ${dataset.name} — ${heading}`,
    filters.start && filters.end ? `${filters.start} – ${filters.end}` : "",
    "",
    `${rows.length} ${dataset.locale === "ko" ? "건" : "records"}`,
  ];
  for (const [status, records] of groups) {
    lines.push("", `## ${status}`);
    for (const row of records) {
      const title = String(row.values[dataset.mapping.title] ?? "").replace(
        /[\r\n]/g,
        " ",
      );
      const who = String(row.values[dataset.mapping.assignee ?? ""] ?? "");
      lines.push(
        `- ${recordDate(dataset, row) ?? "—"} · ${title}${who ? ` · ${who}` : ""}`,
      );
    }
  }
  return {
    rows,
    groups: [...groups.entries()],
    total: rows.length,
    completed: rows.filter((r) => isCompleted(dataset, r)).length,
    markdown: lines.join("\n"),
    text: lines.join("\n").replace(/^#{1,2} /gm, ""),
  };
}
export function issues(dataset: Dataset) {
  const result: {
    recordId: string;
    field?: string;
    code: string;
    message: string;
  }[] = [];
  const titles = new Map<string, string>();
  for (const r of dataset.records) {
    for (const f of dataset.fields) {
      const value = r.values[f.key];
      if (
        (f.required || f.key === dataset.mapping.title) &&
        !String(value ?? "").trim()
      )
        result.push({
          recordId: r.id,
          field: f.key,
          code: "REQUIRED",
          message: `${f.label}: ${dataset.locale === "ko" ? "입력 필요" : "required"}`,
        });
      if (
        (f.type === "date" || f.key === dataset.mapping.date) &&
        value &&
        !parseDate(value, dataset.dateOrder)
      )
        result.push({
          recordId: r.id,
          field: f.key,
          code: "DATE",
          message: `${f.label}: ${dataset.locale === "ko" ? "날짜 확인 필요" : "check date format"}`,
        });
    }
    const title = labelKey(r.values[dataset.mapping.title]);
    if (title && titles.has(title))
      result.push({
        recordId: r.id,
        code: "DUPLICATE",
        message:
          dataset.locale === "ko"
            ? "같은 제목이 있습니다. 중복인지 확인해 주세요."
            : "A matching title exists. Review before merging.",
      });
    if (title) titles.set(title, r.id);
  }
  return result;
}
export function csv(dataset: Dataset, records = dataset.records) {
  const escape = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return (
    "\uFEFF" +
    [
      dataset.fields.map((f) => escape(f.label)).join(","),
      ...records.map((r) =>
        dataset.fields.map((f) => escape(r.values[f.key])).join(","),
      ),
    ].join("\r\n")
  );
}
