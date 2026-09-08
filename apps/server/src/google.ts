import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type {
  CellValue,
  Dataset,
  Field,
  Mapping,
  RecordPatch,
  WorkRecord,
} from "../../../packages/core/src/types.ts";
import type { SqlClient } from "./db.ts";
import { asJson, parseJson } from "./db.ts";
import { HttpError, setupNeeded } from "./errors.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;
const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive.file"].join(" ");

export interface GoogleConfiguration {
  clientId?: string;
  clientSecret?: string;
  tokenEncryptionKey?: string;
  baseURL?: string;
  pickerDeveloperKey?: string;
  pickerAppId?: string;
  fetch?: typeof globalThis.fetch;
}

interface TokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope?: string;
  googleEmail?: string;
}

interface GoogleErrorBody {
  error?: string;
  error_description?: string;
}

async function googleFetch(
  request: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await request(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new HttpError(
        504,
        "GOOGLE_TIMEOUT",
        "Google did not respond before the 15-second safety timeout. No source change was confirmed.",
      );
    }
    throw error;
  }
}

export interface GoogleCredentialStore {
  begin(userId: string): Promise<{ state: string; url: string }>;
  complete(userId: string, state: string, code: string): Promise<void>;
  accessToken(userId: string): Promise<string>;
  enabled(): boolean;
}

export interface GooglePickerConfiguration {
  developerKey: string;
  appId: string;
}

export function googlePickerConfiguration(
  config: GoogleConfiguration = {},
): GooglePickerConfiguration | undefined {
  const developerKey =
    config.pickerDeveloperKey ?? process.env.GOOGLE_PICKER_DEVELOPER_KEY;
  const appId = config.pickerAppId ?? process.env.GOOGLE_APP_ID;
  return developerKey && appId ? { developerKey, appId } : undefined;
}

function configured(
  config: GoogleConfiguration,
):
  | Required<
      Pick<
        GoogleConfiguration,
        "clientId" | "clientSecret" | "tokenEncryptionKey"
      >
    >
  | undefined {
  const clientId = config.clientId ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = config.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
  const tokenEncryptionKey =
    config.tokenEncryptionKey ?? process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  return clientId && clientSecret && tokenEncryptionKey
    ? { clientId, clientSecret, tokenEncryptionKey }
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function encrypt(plaintext: string, keyMaterial: string): string {
  const key = createHash("sha256").update(keyMaterial).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decrypt(payload: string, keyMaterial: string): string {
  const [ivText, tagText, ciphertextText] = payload.split(".");
  if (!ivText || !tagText || !ciphertextText)
    throw setupNeeded(
      "Stored Google credentials are unreadable; reconnect Google Sheets.",
    );
  try {
    const key = createHash("sha256").update(keyMaterial).digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw setupNeeded(
      "Stored Google credentials cannot be decrypted; reconnect Google Sheets.",
    );
  }
}

function baseURL(config: GoogleConfiguration): string {
  return (
    config.baseURL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
}

async function jsonOrError(
  response: Response,
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const detail = body as GoogleErrorBody;
    throw new HttpError(
      502,
      "GOOGLE_OAUTH_FAILED",
      detail.error_description ??
        detail.error ??
        "Google rejected the request.",
    );
  }
  return body;
}

/** Per-user encrypted OAuth tokens. Tokens are never returned from any route. */
export class PostgresGoogleCredentials implements GoogleCredentialStore {
  private readonly config: GoogleConfiguration;
  private readonly request: typeof globalThis.fetch;

  constructor(
    private readonly db: SqlClient,
    config: GoogleConfiguration = {},
  ) {
    this.config = config;
    this.request = config.fetch ?? globalThis.fetch;
  }

  enabled(): boolean {
    return Boolean(configured(this.config));
  }

  async begin(userId: string): Promise<{ state: string; url: string }> {
    const config = configured(this.config);
    if (!config)
      throw setupNeeded(
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_TOKEN_ENCRYPTION_KEY.",
      );
    const state = token();
    await this.db.query(
      "INSERT INTO google_oauth_states (state_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')",
      [sha256(state), userId],
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set(
      "redirect_uri",
      `${baseURL(this.config)}/api/google/callback`,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPES);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return { state, url: url.toString() };
  }

  async complete(userId: string, state: string, code: string): Promise<void> {
    const config = configured(this.config);
    if (!config) throw setupNeeded("Google OAuth is not configured.");
    const stateRow = await this.db.query<{
      user_id: string;
      expires_at: string | Date;
      used_at: string | Date | null;
    }>(
      "SELECT user_id, expires_at, used_at FROM google_oauth_states WHERE state_hash = $1",
      [sha256(state)],
    );
    const saved = stateRow.rows[0];
    if (
      !saved ||
      saved.user_id !== userId ||
      saved.used_at ||
      new Date(saved.expires_at).getTime() < Date.now()
    ) {
      throw new HttpError(
        400,
        "INVALID_OAUTH_STATE",
        "Google authorization state is invalid or expired.",
      );
    }

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${baseURL(this.config)}/api/google/callback`,
    });
    const exchange = await googleFetch(this.request, GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenResponse = await jsonOrError(exchange);
    const accessToken =
      typeof tokenResponse.access_token === "string"
        ? tokenResponse.access_token
        : undefined;
    if (!accessToken)
      throw new HttpError(
        502,
        "GOOGLE_OAUTH_FAILED",
        "Google did not return an access token.",
      );
    const expiresIn =
      typeof tokenResponse.expires_in === "number"
        ? tokenResponse.expires_in
        : 3600;
    const profileResponse = await googleFetch(
      this.request,
      GOOGLE_USERINFO_URL,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const profile = await jsonOrError(profileResponse);
    const googleEmail =
      typeof profile.email === "string"
        ? profile.email.toLowerCase()
        : undefined;
    const payload: TokenPayload = {
      accessToken,
      refreshToken:
        typeof tokenResponse.refresh_token === "string"
          ? tokenResponse.refresh_token
          : undefined,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      scope:
        typeof tokenResponse.scope === "string"
          ? tokenResponse.scope
          : GOOGLE_SCOPES,
      googleEmail,
    };
    await this.save(userId, payload, config.tokenEncryptionKey);
    await this.db.query(
      "UPDATE google_oauth_states SET used_at = NOW() WHERE state_hash = $1 AND used_at IS NULL",
      [sha256(state)],
    );
  }

  async accessToken(userId: string): Promise<string> {
    const config = configured(this.config);
    if (!config) throw setupNeeded("Google Sheets is not configured.");
    const result = await this.db.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM google_credentials WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (!row)
      throw setupNeeded("Connect Google Sheets before editing this source.");
    const payload = parseJson<TokenPayload>(
      decrypt(row.encrypted_payload, config.tokenEncryptionKey),
    );
    if (new Date(payload.expiresAt).getTime() > Date.now() + 60_000)
      return payload.accessToken;
    if (!payload.refreshToken)
      throw setupNeeded(
        "Google access expired and no refresh token is stored. Reconnect Google Sheets.",
      );

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: payload.refreshToken,
    });
    const response = await googleFetch(this.request, GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const refreshed = await jsonOrError(response);
    if (typeof refreshed.access_token !== "string")
      throw new HttpError(
        502,
        "GOOGLE_REFRESH_FAILED",
        "Google did not return a refreshed access token.",
      );
    const expiresIn =
      typeof refreshed.expires_in === "number" ? refreshed.expires_in : 3600;
    const next: TokenPayload = {
      ...payload,
      accessToken: refreshed.access_token,
      refreshToken:
        typeof refreshed.refresh_token === "string"
          ? refreshed.refresh_token
          : payload.refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      scope:
        typeof refreshed.scope === "string" ? refreshed.scope : payload.scope,
    };
    await this.save(userId, next, config.tokenEncryptionKey);
    return next.accessToken;
  }

  private async save(
    userId: string,
    payload: TokenPayload,
    keyMaterial: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO google_credentials (user_id, encrypted_payload, expires_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [userId, encrypt(asJson(payload), keyMaterial), payload.expiresAt],
    );
  }
}

type GoogleSource = Dataset["source"] & {
  sourceColumns?: Record<string, string>;
  /** Imported headers keyed by field key; never derived from display labels. */
  sourceHeaders?: Record<string, string>;
  identityColumn?: string;
  readOnly?: boolean;
  readOnlyReason?: string;
};

export interface GoogleSheetPreview {
  id: number;
  name: string;
  hidden: boolean;
  sheetType: string;
  rowCount?: number;
  columnCount?: number;
  preview: string[][];
}

export interface GoogleSheetInspection {
  spreadsheetId: string;
  title: string;
  canEdit: boolean;
  sheets: GoogleSheetPreview[];
  previewTruncated: boolean;
}

export interface GoogleImportSelection {
  spreadsheetId: string;
  sheetId: number;
  headerRow: number;
  startColumn: number;
  endColumn: number;
  endRow: number;
  mapping: Mapping;
  identityField?: string;
  name: string;
  locale: Dataset["locale"];
  timeZone: string;
  dateOrder: Dataset["dateOrder"];
  weekStartsOn: Dataset["weekStartsOn"];
}

export interface GoogleImportDraft {
  dataset: Dataset;
  canEdit: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
}

export interface GoogleWriteResult {
  preimage: Record<string, CellValue>;
  postwrite: Record<string, CellValue>;
  /** Raw postwrite values for fields whose display values are normalized. */
  sourceValues?: Record<string, CellValue>;
}

interface DriveMetadata {
  capabilities?: { canEdit?: unknown };
}
interface SheetProperties {
  sheetId?: unknown;
  title?: unknown;
  sheetType?: unknown;
  hidden?: unknown;
  gridProperties?: { rowCount?: unknown; columnCount?: unknown };
}
interface GoogleGridCell {
  userEnteredValue?: Record<string, unknown>;
  effectiveValue?: Record<string, unknown>;
  formattedValue?: unknown;
}

const MAX_INSPECTION_SHEETS = 20;
const MAX_PREVIEW_ROWS = 20;
const MAX_PREVIEW_COLUMNS = 26;

function columnLabel(column: number): string {
  let value = column;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function quotedSheet(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

function plainCell(cell: GoogleGridCell | undefined): CellValue {
  const value = cell?.effectiveValue;
  if (!value) return null;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (
    typeof value.numberValue === "number" &&
    Number.isFinite(value.numberValue)
  )
    return value.numberValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  // Error/formula-only and unsupported rich values are intentionally not
  // coerced into a plausible value. They are displayed as blank/read-only.
  return null;
}

interface GoogleDateCell {
  /** The canonical date-only value exposed to the workbench. */
  value: CellValue;
  /** Original typed Sheets value retained for future conflict checks/writes. */
  raw: CellValue;
  /** A date can only be rewritten when its source value was unambiguous. */
  writable: boolean;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function googleDateCell(cell: GoogleGridCell | undefined): GoogleDateCell {
  const raw = plainCell(cell);
  const formula = hasFormula(cell);
  if (raw === null || raw === "")
    return { value: null, raw: null, writable: !formula };
  if (typeof raw === "string" && validIsoDate(raw))
    return { value: raw, raw, writable: !formula };
  if (
    typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw >= 0 &&
    raw <= 2_958_465
  ) {
    // Google Sheets serial dates use the 1899-12-30 epoch. The canonical
    // workbench value is date-only; fractional time is kept in `raw` solely
    // for preimage fidelity until a user explicitly changes the date.
    const value = new Date(
      Date.UTC(1899, 11, 30) + Math.floor(raw) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    return { value, raw, writable: !formula };
  }
  // A mapped date that is text, boolean, an error, or another ambiguous type
  // stays visible as blank and locked. We never turn it into a plausible date
  // or overwrite it on a later patch.
  return { value: null, raw, writable: false };
}

function googleDateSerial(value: string): number {
  // `value` has already passed core date validation when this is called.
  return Math.round(
    (Date.parse(`${value}T00:00:00.000Z`) - Date.UTC(1899, 11, 30)) /
      86_400_000,
  );
}

function hasFormula(cell: GoogleGridCell | undefined): boolean {
  return typeof cell?.userEnteredValue?.formulaValue === "string";
}

function displayCell(cell: GoogleGridCell | undefined): string {
  const value = plainCell(cell);
  if (value !== null) return String(value);
  return typeof cell?.formattedValue === "string" ? cell.formattedValue : "";
}

function inferField(values: CellValue[], key: string, label: string): Field {
  const populated = values.filter(
    (value): value is Exclude<CellValue, null> => value !== null,
  );
  const type =
    populated.length > 0 &&
    populated.every((value) => typeof value === "boolean")
      ? ("select" as const)
      : populated.length > 0 &&
          populated.every((value) => typeof value === "number")
        ? ("number" as const)
        : ("text" as const);
  return type === "select"
    ? { key, label, type, options: ["true", "false"] }
    : { key, label, type };
}

function gridCell(
  rows: GoogleGridCell[][],
  row: number,
  column: number,
): GoogleGridCell | undefined {
  return rows[row]?.[column];
}

/** Read-only Google Sheets API client. All ranges are bounded by server limits. */
export class GoogleSheetsReader {
  constructor(
    private readonly credentials: GoogleCredentialStore,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async inspect(
    spreadsheetId: string,
    userId: string,
  ): Promise<GoogleSheetInspection> {
    const accessToken = await this.credentials.accessToken(userId);
    const metadata = await this.metadata(spreadsheetId, accessToken);
    const canEdit = await this.canEdit(spreadsheetId, accessToken);
    const rawSheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
    const sheets: GoogleSheetPreview[] = [];
    for (const rawSheet of rawSheets.slice(0, MAX_INSPECTION_SHEETS)) {
      const properties = (rawSheet as { properties?: SheetProperties })
        .properties;
      const id =
        typeof properties?.sheetId === "number"
          ? properties.sheetId
          : undefined;
      const name =
        typeof properties?.title === "string" ? properties.title : undefined;
      if (id === undefined || !name) continue;
      const sheetProperties = properties!;
      const sheetType =
        typeof sheetProperties.sheetType === "string"
          ? sheetProperties.sheetType
          : "GRID";
      const preview =
        sheetType === "GRID"
          ? await this.preview(spreadsheetId, name, accessToken)
          : [];
      sheets.push({
        id,
        name,
        hidden: sheetProperties.hidden === true,
        sheetType,
        rowCount: numberOrUndefined(sheetProperties.gridProperties?.rowCount),
        columnCount: numberOrUndefined(
          sheetProperties.gridProperties?.columnCount,
        ),
        preview,
      });
    }
    return {
      spreadsheetId,
      title:
        typeof (metadata.properties as { title?: unknown } | undefined)
          ?.title === "string"
          ? (metadata.properties as { title: string }).title
          : spreadsheetId,
      canEdit,
      sheets,
      previewTruncated: rawSheets.length > MAX_INSPECTION_SHEETS,
    };
  }

  async importSelection(
    selection: GoogleImportSelection,
    userId: string,
  ): Promise<GoogleImportDraft> {
    validateSelection(selection);
    const accessToken = await this.credentials.accessToken(userId);
    const metadata = await this.metadata(selection.spreadsheetId, accessToken);
    const rawSheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
    const properties = rawSheets
      .map((item) => (item as { properties?: SheetProperties }).properties)
      .find((item) => item?.sheetId === selection.sheetId);
    if (
      !properties ||
      typeof properties.title !== "string" ||
      properties.sheetType === "OBJECT"
    ) {
      throw new HttpError(
        404,
        "GOOGLE_SHEET_NOT_FOUND",
        "The selected Google Sheet tab was not found.",
      );
    }
    if (properties.sheetType && properties.sheetType !== "GRID")
      throw new HttpError(
        409,
        "GOOGLE_SHEET_UNSUPPORTED",
        "Only GRID Google Sheet tabs can be imported.",
      );
    const grid = await this.selectionGrid(
      selection.spreadsheetId,
      properties.title,
      selection,
      accessToken,
    );
    const canEdit = await this.canEdit(selection.spreadsheetId, accessToken);
    const dataset = this.datasetFromGrid(selection, properties.title, grid);
    const source = dataset.source as GoogleSource;
    const identity = dataset.mapping.identity;
    const ids = identity
      ? dataset.records
          .map((record) => record.values[identity])
          .filter((value) => value !== null && value !== "")
      : [];
    const uniqueIdentity =
      Boolean(identity) &&
      ids.length === dataset.records.length &&
      new Set(ids.map(String)).size === ids.length;
    const formulaIdentity =
      Boolean(identity) &&
      dataset.records.some((record) =>
        record.lockedFields?.includes(identity!),
      );
    const stableIdentity =
      Boolean(identity) &&
      identity !== dataset.mapping.date &&
      !formulaIdentity &&
      uniqueIdentity;
    const readOnlyReason = !identity
      ? "Choose an existing unique ID column before enabling Google writeback."
      : identity === dataset.mapping.date
        ? "A date column cannot be used as a Google writeback identity."
        : formulaIdentity
          ? "A formula column cannot be used as a Google writeback identity."
          : !uniqueIdentity
            ? "The selected ID column has blank or duplicate values; Google writeback is disabled."
            : !canEdit
              ? "The connected Google account cannot edit this spreadsheet."
              : undefined;
    const writable = canEdit && stableIdentity;
    const records = dataset.records.map((record) => {
      const identityValue = identity ? record.values[identity] : null;
      return stableIdentity
        ? {
            ...record,
            id: `google-${sha256(`${selection.spreadsheetId}:${selection.sheetId}:${String(identityValue)}`)}`,
          }
        : record;
    });
    return {
      dataset: {
        ...dataset,
        records,
        source: {
          ...source,
          readOnly: !writable,
          ...(readOnlyReason ? { readOnlyReason } : {}),
        },
      },
      canEdit,
      readOnly: !writable,
      ...(readOnlyReason ? { readOnlyReason } : {}),
    };
  }

  private async metadata(
    spreadsheetId: string,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const fields = encodeURIComponent(
      "spreadsheetId,properties(title),sheets(properties(sheetId,title,sheetType,hidden,gridProperties(rowCount,columnCount)))",
    );
    return this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false&fields=${fields}`,
      accessToken,
    );
  }

  private async canEdit(
    spreadsheetId: string,
    accessToken: string,
  ): Promise<boolean> {
    const fields = encodeURIComponent("id,capabilities(canEdit)");
    const result = await this.google(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=${fields}`,
      accessToken,
    );
    return (result as DriveMetadata).capabilities?.canEdit === true;
  }

  private async preview(
    spreadsheetId: string,
    sheetName: string,
    accessToken: string,
  ): Promise<string[][]> {
    const range = `${quotedSheet(sheetName)}!A1:${columnLabel(MAX_PREVIEW_COLUMNS)}${MAX_PREVIEW_ROWS}`;
    const result = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
      accessToken,
    );
    const values = Array.isArray(result.values) ? result.values : [];
    return values
      .slice(0, MAX_PREVIEW_ROWS)
      .map((row) =>
        Array.isArray(row)
          ? row.slice(0, MAX_PREVIEW_COLUMNS).map((cell) => String(cell))
          : [],
      );
  }

  private async selectionGrid(
    spreadsheetId: string,
    sheetName: string,
    selection: GoogleImportSelection,
    accessToken: string,
  ): Promise<GoogleGridCell[][]> {
    const range = `${quotedSheet(sheetName)}!${columnLabel(selection.startColumn)}${selection.headerRow}:${columnLabel(selection.endColumn)}${selection.endRow}`;
    const fields = encodeURIComponent(
      "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue))))",
    );
    const result = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${fields}`,
      accessToken,
    );
    const sheets = Array.isArray(result.sheets) ? result.sheets : [];
    const sheet = sheets[0] as
      | { data?: Array<{ rowData?: Array<{ values?: GoogleGridCell[] }> }> }
      | undefined;
    const data = sheet?.data?.[0];
    const rowData = data?.rowData ?? [];
    const width = selection.endColumn - selection.startColumn + 1;
    const height = selection.endRow - selection.headerRow + 1;
    return Array.from({ length: height }, (_, row) =>
      Array.from(
        { length: width },
        (_, column) => rowData[row]?.values?.[column] ?? {},
      ),
    );
  }

  private datasetFromGrid(
    selection: GoogleImportSelection,
    sheetName: string,
    rows: GoogleGridCell[][],
  ): Dataset {
    const width = selection.endColumn - selection.startColumn + 1;
    const fieldKeys = Array.from(
      { length: width },
      (_, index) => `g_${columnLabel(selection.startColumn + index)}`,
    );
    const headers = fieldKeys.map(
      (_, index) =>
        displayCell(gridCell(rows, 0, index)).trim() ||
        `Column ${columnLabel(selection.startColumn + index)}`,
    );
    const mapping: Mapping = {
      ...selection.mapping,
      ...(selection.identityField ? { identity: selection.identityField } : {}),
    };
    if (
      !fieldKeys.includes(mapping.title) ||
      Object.values(mapping)
        .filter(Boolean)
        .some((key) => !fieldKeys.includes(key!))
    ) {
      throw new HttpError(
        400,
        "INVALID_GOOGLE_MAPPING",
        "Mapping must use selected Google Sheet columns (for example g_A).",
      );
    }
    const rawRecords = rows
      .slice(1)
      .map((cells, index) => {
        const parsedDates = new Map<string, GoogleDateCell>();
        const values = Object.fromEntries(
          fieldKeys.map((key, column) => {
            if (mapping.date !== key) return [key, plainCell(cells[column])];
            const parsed = googleDateCell(cells[column]);
            parsedDates.set(key, parsed);
            return [key, parsed.value];
          }),
        ) as Record<string, CellValue>;
        // Formula cells and ambiguous date cells are never blindly rewritten.
        // Valid raw dates remain editable and retain their typed preimage in
        // `sourceValues`; a formula added after import is checked again by the
        // connector immediately before the write.
        const lockedFields = fieldKeys.filter(
          (key, column) =>
            hasFormula(cells[column]) ||
            (mapping.date === key && !parsedDates.get(key)?.writable),
        );
        const dateSourceValues = Object.fromEntries(
          [...parsedDates].map(([key, parsed]) => [key, parsed.raw]),
        ) as Record<string, CellValue>;
        return {
          id: `google-row-${selection.sheetId}-${selection.headerRow + index + 1}`,
          revision: 0,
          values,
          sourceRow: selection.headerRow + index + 1,
          ...(Object.keys(dateSourceValues).length
            ? { sourceValues: dateSourceValues }
            : {}),
          ...(lockedFields.length ? { lockedFields } : {}),
        } satisfies WorkRecord;
      })
      .filter((record) =>
        Object.values(record.values).some((value) => value !== null),
      );
    const fields = fieldKeys.map((key, index) =>
      mapping.date === key
        ? { key, label: headers[index]!, type: "date" as const }
        : inferField(
            rawRecords.map((record) => record.values[key] ?? null),
            key,
            headers[index]!,
          ),
    );
    const sourceColumns = Object.fromEntries(
      fieldKeys.map((key, index) => [
        key,
        columnLabel(selection.startColumn + index),
      ]),
    );
    const sourceHeaders = Object.fromEntries(
      fieldKeys.map((key, index) => [key, headers[index]!]),
    );
    return validateGoogleDataset({
      id: randomId(),
      name: selection.name,
      source: {
        kind: "google",
        spreadsheetId: selection.spreadsheetId,
        sheetId: selection.sheetId,
        sheetName,
        headerRow: selection.headerRow,
        startColumn: selection.startColumn,
        endColumn: selection.endColumn,
        endRow: selection.endRow,
        sourceColumns,
        sourceHeaders,
      } as GoogleSource,
      fields,
      mapping,
      records: rawRecords,
      revision: 0,
      locale: selection.locale,
      timeZone: selection.timeZone,
      dateOrder: selection.dateOrder,
      weekStartsOn: selection.weekStartsOn,
      updatedAt: new Date().toISOString(),
      completedStatuses: [],
    });
  }

  private async google(
    url: string,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const response = await googleFetch(this.request, url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return jsonOrError(response);
  }
}

function validateSelection(selection: GoogleImportSelection): void {
  const width = selection.endColumn - selection.startColumn + 1;
  const height = selection.endRow - selection.headerRow + 1;
  if (
    !Number.isInteger(selection.sheetId) ||
    selection.sheetId < 0 ||
    !Number.isInteger(selection.headerRow) ||
    selection.headerRow < 1 ||
    !Number.isInteger(selection.startColumn) ||
    selection.startColumn < 1 ||
    !Number.isInteger(selection.endColumn) ||
    selection.endColumn < selection.startColumn ||
    !Number.isInteger(selection.endRow) ||
    selection.endRow <= selection.headerRow ||
    width > 100 ||
    height > 10_001
  ) {
    throw new HttpError(
      400,
      "INVALID_GOOGLE_SELECTION",
      "Google import must select 1–100 columns and at most 10,000 data rows.",
    );
  }
}

function validateGoogleDataset(dataset: Dataset): Dataset {
  // Avoid a circular core import surface in this focused connector module.
  if (
    !dataset.name.trim() ||
    dataset.fields.length < 1 ||
    dataset.records.length > 10_000
  ) {
    throw new HttpError(
      400,
      "INVALID_GOOGLE_IMPORT",
      "Google import produced an invalid dataset.",
    );
  }
  return dataset;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function randomId(): string {
  return `google-${randomBytes(16).toString("hex")}`;
}

/**
 * Google Sheets writeback with deliberately conservative identity checks.
 * It refuses to write when an importer has not supplied an immutable source
 * row plus identity and column metadata; guessing a matching row would be a
 * data-loss bug.
 */
export class GoogleSheetsConnector {
  constructor(
    private readonly credentials: GoogleCredentialStore,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async applyPatch(
    dataset: Dataset,
    patch: RecordPatch,
    userId: string,
  ): Promise<GoogleWriteResult> {
    const source = dataset.source as GoogleSource;
    const spreadsheetId = source.spreadsheetId;
    const sheetName = source.sheetName;
    const record = dataset.records.find((item) => item.id === patch.recordId);
    const identityField = dataset.mapping.identity;
    const columns = source.sourceColumns;
    if (
      source.kind !== "google" ||
      !spreadsheetId ||
      !sheetName ||
      !record?.sourceRow ||
      !identityField ||
      !columns?.[identityField] ||
      !source.sourceHeaders ||
      !source.headerRow ||
      !source.endRow
    ) {
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google writeback needs a verified source row, identity field, and source-column mapping.",
      );
    }
    for (const key of Object.keys(patch.changes)) {
      if (!columns[key] || record.lockedFields?.includes(key)) {
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_UNSAFE",
          `Google cannot safely write field "${key}".`,
        );
      }
    }

    const accessToken = await this.credentials.accessToken(userId);
    await this.assertCanEdit(spreadsheetId, accessToken);
    await this.assertHeaderSchema(
      spreadsheetId,
      sheetName,
      source,
      accessToken,
    );
    await this.assertIdentityColumn(
      spreadsheetId,
      sheetName,
      source,
      identityField,
      record,
      accessToken,
    );
    const row = record.sourceRow;
    const escapeSheet = (name: string) => `'${name.replaceAll("'", "''")}'`;
    const ranges = [identityField, ...Object.keys(patch.changes)].map(
      (key) => `${escapeSheet(sheetName)}!${columns[key]}${row}`,
    );
    const beforeValues = await this.readRanges(
      spreadsheetId,
      ranges,
      accessToken,
      "UNFORMATTED_VALUE",
    );
    const beforeFormulas = await this.readRanges(
      spreadsheetId,
      ranges,
      accessToken,
      "FORMULA",
    );
    const expectedIdentity = record.values[identityField] ?? null;
    if (
      isFormula(beforeFormulas[0]) ||
      !sameCell(beforeValues[0], expectedIdentity)
    ) {
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_CONFLICT",
        "The source row identity changed in Google Sheets; no write was made.",
      );
    }
    const preimage: Record<string, CellValue> = {};
    const expectedPostwrite: Record<string, CellValue> = {};
    const updates = Object.entries(patch.changes).map(([key, value], index) => {
      const current = beforeValues[index + 1];
      const expected = this.expectedPreimage(record, dataset, key);
      if (
        isFormula(beforeFormulas[index + 1]) ||
        !sameCell(current, expected)
      ) {
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_CONFLICT",
          `Google Sheets changed field "${key}" or made it a formula; no write was made.`,
        );
      }
      preimage[key] = current;
      const next = this.writeValue(record, dataset, key, value);
      expectedPostwrite[key] = next === "" ? null : next;
      // RAW preserves number and boolean types. An empty string is the Sheets
      // API's explicit clear-cell value; null is not sent as a fake value.
      return { range: ranges[index + 1], values: [[next]] };
    });
    await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
      },
    );
    const afterValues = await this.readRanges(
      spreadsheetId,
      ranges,
      accessToken,
      "UNFORMATTED_VALUE",
    );
    const afterFormulas = await this.readRanges(
      spreadsheetId,
      ranges,
      accessToken,
      "FORMULA",
    );
    if (
      isFormula(afterFormulas[0]) ||
      !sameCell(afterValues[0], expectedIdentity)
    ) {
      throw new HttpError(
        502,
        "GOOGLE_POSTWRITE_UNCERTAIN",
        "Google did not preserve the source identity after writing; local data was not changed.",
      );
    }
    const postwrite: Record<string, CellValue> = {};
    Object.entries(patch.changes).forEach(([key], index) => {
      const actual = afterValues[index + 1];
      if (
        isFormula(afterFormulas[index + 1]) ||
        !sameCell(actual, expectedPostwrite[key]!)
      ) {
        throw new HttpError(
          502,
          "GOOGLE_POSTWRITE_UNCERTAIN",
          `Google did not confirm field "${key}" after writing; local data was not changed.`,
        );
      }
      postwrite[key] = actual;
    });
    const sourceValues =
      dataset.mapping.date && Object.hasOwn(patch.changes, dataset.mapping.date)
        ? { [dataset.mapping.date]: postwrite[dataset.mapping.date]! }
        : undefined;
    return { preimage, postwrite, ...(sourceValues ? { sourceValues } : {}) };
  }

  private expectedPreimage(
    record: WorkRecord,
    dataset: Dataset,
    key: string,
  ): CellValue {
    if (key !== dataset.mapping.date) return record.values[key] ?? null;
    if (!record.sourceValues || !Object.hasOwn(record.sourceValues, key)) {
      // Existing datasets created before raw-date provenance was introduced
      // must be refreshed/re-imported before changing dates. Guessing whether
      // a rendered ISO value was numeric or text would corrupt source types.
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Refresh or re-import this Google date column before editing it.",
      );
    }
    return record.sourceValues[key] ?? null;
  }

  private writeValue(
    record: WorkRecord,
    dataset: Dataset,
    key: string,
    value: CellValue,
  ): CellValue | "" {
    if (value === null) return "";
    if (key !== dataset.mapping.date) return value;
    if (typeof value !== "string" || !validIsoDate(value)) {
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google date writes require a canonical date-only value.",
      );
    }
    const original = this.expectedPreimage(record, dataset, key);
    if (typeof original === "number") return googleDateSerial(value);
    if (typeof original === "string" || original === null) return value;
    throw new HttpError(
      409,
      "GOOGLE_SOURCE_UNSAFE",
      "This Google date cell has an ambiguous source type.",
    );
  }

  private async assertCanEdit(
    spreadsheetId: string,
    accessToken: string,
  ): Promise<void> {
    const fields = encodeURIComponent("id,capabilities(canEdit)");
    const response = await this.google(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=${fields}`,
      accessToken,
    );
    const capabilities = response.capabilities as
      { canEdit?: unknown } | undefined;
    if (capabilities?.canEdit !== true)
      throw new HttpError(
        403,
        "GOOGLE_CANNOT_EDIT",
        "The connected Google account cannot edit this spreadsheet.",
      );
  }

  private async assertHeaderSchema(
    spreadsheetId: string,
    sheetName: string,
    source: GoogleSource,
    accessToken: string,
  ): Promise<void> {
    const expected = source.sourceHeaders;
    const columns = source.sourceColumns;
    if (!expected || !columns || !source.headerRow)
      throw new HttpError(
        409,
        "GOOGLE_SCHEMA_UNVERIFIED",
        "Google source headers were not fingerprinted. Re-import before writing.",
      );
    const escapeSheet = (name: string) => `'${name.replaceAll("'", "''")}'`;
    const keys = Object.keys(expected);
    if (!keys.length || keys.some((key) => !columns[key]))
      throw new HttpError(
        409,
        "GOOGLE_SCHEMA_UNVERIFIED",
        "Google source header mapping is incomplete. Re-import before writing.",
      );
    const ranges = keys.map(
      (key) => `${escapeSheet(sheetName)}!${columns[key]}${source.headerRow}`,
    );
    const values = await this.readRanges(
      spreadsheetId,
      ranges,
      accessToken,
      "UNFORMATTED_VALUE",
    );
    const formulas = await this.readRanges(
      spreadsheetId,
      ranges,
      accessToken,
      "FORMULA",
    );
    for (const [index, key] of keys.entries()) {
      if (
        isFormula(formulas[index]) ||
        String(values[index] ?? "").trim() !== expected[key]
      ) {
        throw new HttpError(
          409,
          "GOOGLE_SCHEMA_CHANGED",
          "Google source headers changed. Review a re-import before writing.",
        );
      }
    }
  }

  private async assertIdentityColumn(
    spreadsheetId: string,
    sheetName: string,
    source: GoogleSource,
    identityField: string,
    record: WorkRecord,
    accessToken: string,
  ): Promise<void> {
    const column = source.sourceColumns?.[identityField];
    if (!column || !source.headerRow || !source.endRow)
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google source identity range is incomplete.",
      );
    const escapeSheet = (name: string) => `'${name.replaceAll("'", "''")}'`;
    const range = `${escapeSheet(sheetName)}!${column}${source.headerRow + 1}:${column}${source.endRow}`;
    const values = await this.readColumn(
      spreadsheetId,
      range,
      source.endRow - source.headerRow,
      accessToken,
      "UNFORMATTED_VALUE",
    );
    const formulas = await this.readColumn(
      spreadsheetId,
      range,
      source.endRow - source.headerRow,
      accessToken,
      "FORMULA",
    );
    const expected = record.values[identityField] ?? null;
    const sourceRow = record.sourceRow;
    if (!sourceRow)
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google source row is missing.",
      );
    const index = sourceRow - source.headerRow - 1;
    if (
      index < 0 ||
      index >= values.length ||
      isFormula(formulas[index]) ||
      !sameCell(values[index], expected)
    ) {
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_CONFLICT",
        "The Google source row moved or its identity changed; no write was made.",
      );
    }
    const seen = new Set<string>();
    for (let row = 0; row < values.length; row += 1) {
      const value = values[row]!;
      if (value === null) continue;
      if (isFormula(formulas[row]))
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_CONFLICT",
          "The Google identity column contains a formula; no write was made.",
        );
      const key = `${typeof value}:${String(value)}`;
      if (seen.has(key))
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_CONFLICT",
          "The Google identity column contains duplicates; no write was made.",
        );
      seen.add(key);
    }
  }

  private async readRanges(
    spreadsheetId: string,
    ranges: string[],
    accessToken: string,
    valueRenderOption: "UNFORMATTED_VALUE" | "FORMULA",
  ): Promise<CellValue[]> {
    const params = new URLSearchParams();
    for (const range of ranges) params.append("ranges", range);
    params.set("majorDimension", "ROWS");
    params.set("valueRenderOption", valueRenderOption);
    const response = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params.toString()}`,
      accessToken,
    );
    const valueRanges = Array.isArray(response.valueRanges)
      ? response.valueRanges
      : [];
    if (valueRanges.length !== ranges.length)
      throw new HttpError(
        502,
        "GOOGLE_PREIMAGE_UNCERTAIN",
        "Google returned an incomplete source preimage.",
      );
    return valueRanges.map((range) => {
      const values = (range as { values?: unknown }).values;
      const value =
        Array.isArray(values) && Array.isArray(values[0])
          ? values[0][0]
          : undefined;
      if (value === undefined || value === null || value === "") return null;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        return value;
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_CONFLICT",
        "A required Google source cell has an unsupported type.",
      );
    });
  }

  private async readColumn(
    spreadsheetId: string,
    range: string,
    length: number,
    accessToken: string,
    valueRenderOption: "UNFORMATTED_VALUE" | "FORMULA",
  ): Promise<CellValue[]> {
    const params = new URLSearchParams({
      majorDimension: "COLUMNS",
      valueRenderOption,
    });
    const response = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`,
      accessToken,
    );
    const column =
      Array.isArray(response.values) && Array.isArray(response.values[0])
        ? response.values[0]
        : [];
    if (column.length > length)
      throw new HttpError(
        502,
        "GOOGLE_PREIMAGE_UNCERTAIN",
        "Google returned an oversized identity range.",
      );
    return Array.from({ length }, (_, index) => {
      const value = column[index];
      if (value === undefined || value === null || value === "") return null;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        return value;
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_CONFLICT",
        "Google identity has an unsupported value type.",
      );
    });
  }

  private async google(
    url: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const response = await googleFetch(this.request, url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    return jsonOrError(response);
  }
}

function isFormula(value: CellValue): boolean {
  return typeof value === "string" && value.startsWith("=");
}

function sameCell(left: CellValue, right: CellValue): boolean {
  return (
    left === right ||
    (typeof left === "number" &&
      typeof right === "number" &&
      Object.is(left, right))
  );
}
