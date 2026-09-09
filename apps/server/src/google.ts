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
import { withActorTransaction } from "./write-access.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
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

/**
 * A single, already-resolved OAuth token bound to one Google actor.  This is
 * deliberately not a cache and never mutates a shared connector: callers use
 * it for the short interval after `PostgresGoogleCredentials.accessToken()`
 * has persisted any required refresh and before a database transaction starts.
 */
export class PreparedGoogleCredentials implements GoogleCredentialStore {
  constructor(
    private readonly userId: string,
    private readonly token: string,
  ) {}

  enabled(): boolean {
    return true;
  }

  async accessToken(userId: string): Promise<string> {
    if (userId !== this.userId)
      throw new HttpError(
        409,
        "GOOGLE_CREDENTIAL_IDENTITY_CHANGED",
        "The prepared Google credential belongs to a different workspace member.",
      );
    return this.token;
  }

  async begin(): Promise<{ state: string; url: string }> {
    throw setupNeeded("Prepared Google credentials cannot start OAuth.");
  }

  async complete(): Promise<void> {
    throw setupNeeded("Prepared Google credentials cannot complete OAuth.");
  }
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
    await withActorTransaction(this.db, userId, async (tx) => {
      await tx.query(
        "INSERT INTO google_oauth_states (state_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')",
        [sha256(state), userId],
      );
    });
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
    };
    // The token-exchange HTTP call completed above; only the durable state
    // transition is actor-locked, so an account-erasure marker cannot be
    // bypassed by a callback that was authenticated earlier.
    await withActorTransaction(this.db, userId, async (tx) => {
      const claimed = await tx.query(
        "UPDATE google_oauth_states SET used_at = NOW() WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > NOW() RETURNING state_hash",
        [sha256(state), userId],
      );
      if (!claimed.rows.length)
        throw new HttpError(
          400,
          "INVALID_OAUTH_STATE",
          "Google authorization state is invalid or expired.",
        );
      await this.save(userId, payload, config.tokenEncryptionKey, tx);
    });
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
    // Persist token rotation before the caller begins its data transaction.
    await withActorTransaction(this.db, userId, async (tx) => {
      await this.save(userId, next, config.tokenEncryptionKey, tx);
    });
    return next.accessToken;
  }

  private async save(
    userId: string,
    payload: TokenPayload,
    keyMaterial: string,
    sql: SqlClient = this.db,
  ): Promise<void> {
    await sql.query(
      `INSERT INTO google_credentials (user_id, encrypted_payload, expires_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [userId, encrypt(asJson(payload), keyMaterial), payload.expiresAt],
    );
  }
}

export type GoogleSource = Dataset["source"] & {
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
  /** Present only after a user has explicitly enabled row metadata identity. */
  identityStrategy?: "column" | "developer-metadata";
  developerMetadataKey?: string;
  developerMetadataConsent?: boolean;
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
  /** Updated locator when a metadata-backed row has moved after a sort/insert. */
  recordSource?: Pick<WorkRecord, "sourceRow" | "sourceIdentity">;
}

export interface GooglePatchVerification {
  /** The remote write definitely was not applied and may be retried once. */
  outcome: "not-applied" | "applied";
  /** Present only when the remote postimage exactly matches every requested cell. */
  write?: GoogleWriteResult;
}

export interface GoogleMetadataIdentityEnableRequest {
  operationId: string;
  /** Explicit acknowledgement that row-scoped developer metadata is written. */
  consent: true;
}

export interface GoogleMetadataIdentityEnableResult {
  source: GoogleSource;
  records: WorkRecord[];
  /** All expected metadata already existed after a prior uncertain request. */
  replayed: boolean;
}

export interface GoogleCreateRequest {
  operationId: string;
  /** A validated local record generated before the connector is invoked. */
  record: WorkRecord;
  /** Explicit acknowledgement that one source row will be inserted. */
  appendConsent: true;
  /** Required if this create also writes developer metadata. */
  developerMetadataConsent?: true;
}

export interface GoogleCreateResult {
  record: WorkRecord;
  /** Persist this source copy with the returned record in the same local transaction. */
  source: GoogleSource;
  operationIdentity: {
    strategy: "column" | "developer-metadata";
    value: string;
  };
  /** True only after reconciling an exact prior remote create. */
  replayed: boolean;
}

export interface GoogleCreateVerification {
  outcome: "not-applied" | "applied";
  create?: GoogleCreateResult;
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

interface GoogleGridData {
  startRow?: unknown;
  startColumn?: unknown;
  rowData?: Array<{ values?: GoogleGridCell[] }>;
  rowMetadata?: Array<{ developerMetadata?: GoogleDeveloperMetadata[] }>;
}

interface GoogleSelectionGrid {
  cells: GoogleGridCell[][];
  /**
   * Row markers returned in the same spreadsheets.get snapshot as `cells`.
   * They must never be joined to a later physical-grid read after a sort.
   */
  metadataRows: GoogleMetadataRow[];
}

interface GoogleDeveloperMetadata {
  metadataId?: unknown;
  metadataKey?: unknown;
  metadataValue?: unknown;
  location?: {
    locationType?: unknown;
    dimensionRange?: {
      sheetId?: unknown;
      dimension?: unknown;
      startIndex?: unknown;
      endIndex?: unknown;
    };
  };
  visibility?: unknown;
}

interface GoogleMetadataMatch {
  developerMetadata?: GoogleDeveloperMetadata;
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

function columnNumber(label: string): number | undefined {
  if (!/^[A-Z]{1,3}$/.test(label)) return undefined;
  let value = 0;
  for (const character of label)
    value = value * 26 + character.charCodeAt(0) - 64;
  return value >= 1 && value <= 16_384 ? value : undefined;
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

interface GoogleMetadataRow {
  id: number;
  value: string;
  /** One-based Sheets row number, never an inferred display position. */
  row: number;
}

function validMetadataText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function metadataRows(
  response: Record<string, unknown>,
  key: string,
  sheetId: number,
): GoogleMetadataRow[] {
  const matches = Array.isArray(response.matchedDeveloperMetadata)
    ? response.matchedDeveloperMetadata
    : [];
  const rows: GoogleMetadataRow[] = [];
  for (const match of matches) {
    const metadata = (match as GoogleMetadataMatch).developerMetadata;
    if (!metadata) continue;
    rows.push(metadataRow(metadata, key, sheetId));
  }
  return rows;
}

/** Parse only an exact document-visible marker for one whole sheet row. */
function metadataRow(
  metadata: GoogleDeveloperMetadata,
  key: string,
  sheetId: number,
  expectedRow?: number,
): GoogleMetadataRow {
  const range = metadata.location?.dimensionRange;
  const metadataId = metadata.metadataId;
  const startIndex = range?.startIndex;
  const endIndex = range?.endIndex;
  if (
    metadata.metadataKey !== key ||
    !validMetadataText(metadata.metadataValue) ||
    metadata.location?.locationType !== "ROW" ||
    metadata.visibility !== "DOCUMENT" ||
    range?.sheetId !== sheetId ||
    range.dimension !== "ROWS" ||
    typeof startIndex !== "number" ||
    !Number.isSafeInteger(startIndex) ||
    typeof endIndex !== "number" ||
    !Number.isSafeInteger(endIndex) ||
    startIndex < 0 ||
    endIndex !== startIndex + 1 ||
    (expectedRow !== undefined && startIndex + 1 !== expectedRow) ||
    typeof metadataId !== "number" ||
    !Number.isSafeInteger(metadataId) ||
    metadataId <= 0
  ) {
    throw new HttpError(
      409,
      "GOOGLE_METADATA_IDENTITY_MISMATCH",
      "Google developer metadata is not a single document-visible source row.",
    );
  }
  return { id: metadataId, value: metadata.metadataValue, row: startIndex + 1 };
}

function metadataOperationValue(operationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/.test(operationId))
    throw new HttpError(
      400,
      "INVALID_OPERATION_ID",
      "Google source operation IDs must be stable identifiers.",
    );
  return `op:${operationId}`;
}

function metadataExistingValue(record: WorkRecord): string {
  return `record:${record.id}`;
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

  /** Creates an isolated reader without changing this reader's credentials. */
  withCredentials(credentials: GoogleCredentialStore): GoogleSheetsReader {
    return new GoogleSheetsReader(credentials, this.request);
  }

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
    const selectionGrid = await this.selectionGrid(
      selection.spreadsheetId,
      properties.title,
      selection,
      accessToken,
    );
    const canEdit = await this.canEdit(selection.spreadsheetId, accessToken);
    const baseDataset = this.datasetFromGrid(
      selection,
      properties.title,
      selectionGrid.cells,
    );
    const dataset =
      selection.identityStrategy === "developer-metadata"
        ? await this.withDeveloperMetadataIdentity(
            baseDataset,
            selection,
            accessToken,
            selectionGrid.metadataRows,
          )
        : baseDataset;
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
    const metadataIdentity =
      source.identityStrategy === "developer-metadata" &&
      Boolean(source.developerMetadataKey) &&
      source.developerMetadataConsent === true;
    const metadataComplete =
      metadataIdentity &&
      dataset.records.every((record) =>
        validMetadataText(record.sourceIdentity),
      );
    const readOnlyReason =
      metadataIdentity && !metadataComplete
        ? "Google has new or untracked rows without approved metadata identities. Review them before enabling writeback."
        : metadataIdentity
          ? !canEdit
            ? "The connected Google account cannot edit this spreadsheet."
            : undefined
          : stableIdentity
            ? "Set up explicit row metadata before Google writeback. A visible ID column alone cannot guard a concurrent sort."
            : !identity
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
    const writable = canEdit && metadataIdentity && metadataComplete;
    const records = dataset.records.map((record) => {
      const identityValue = identity ? record.values[identity] : null;
      return metadataIdentity
        ? {
            ...record,
            ...(identity
              ? {
                  // Metadata, not the visible ID, locates future writes. Keep
                  // the visible ID immutable so its uniqueness invariant is
                  // retained across refreshes and row creation.
                  lockedFields: [
                    ...new Set([...(record.lockedFields ?? []), identity]),
                  ],
                }
              : {}),
          }
        : stableIdentity
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
  ): Promise<GoogleSelectionGrid> {
    const range = `${quotedSheet(sheetName)}!${columnLabel(selection.startColumn)}${selection.headerRow}:${columnLabel(selection.endColumn)}${selection.endRow}`;
    const fields = encodeURIComponent(
      "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue)),rowMetadata(developerMetadata(metadataId,metadataKey,metadataValue,visibility,location))))",
    );
    const result = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${fields}`,
      accessToken,
    );
    const sheets = Array.isArray(result.sheets) ? result.sheets : [];
    const sheet = sheets[0] as { data?: GoogleGridData[] } | undefined;
    const data = sheet?.data?.[0];
    const rowData = data?.rowData ?? [];
    const rowMetadata = data?.rowMetadata ?? [];
    const width = selection.endColumn - selection.startColumn + 1;
    const height = selection.endRow - selection.headerRow + 1;
    const responseStartRow =
      typeof data?.startRow === "number"
        ? data.startRow
        : selection.headerRow - 1;
    const responseStartColumn =
      typeof data?.startColumn === "number"
        ? data.startColumn
        : selection.startColumn - 1;
    const rowOffset = responseStartRow - (selection.headerRow - 1);
    const columnOffset = responseStartColumn - (selection.startColumn - 1);
    const cells = Array.from({ length: height }, (_, row) =>
      Array.from(
        { length: width },
        (_, column) =>
          rowData[row - rowOffset]?.values?.[column - columnOffset] ?? {},
      ),
    );
    const metadataRows = rowMetadata.flatMap((dimension, index) =>
      (dimension.developerMetadata ?? [])
        .filter(
          (metadata) => metadata.metadataKey === selection.developerMetadataKey,
        )
        .map((metadata) =>
          metadataRow(
            metadata,
            selection.developerMetadataKey ?? "",
            selection.sheetId,
            responseStartRow + index + 1,
          ),
        ),
    );
    return { cells, metadataRows };
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
        ...(selection.identityStrategy
          ? { identityStrategy: selection.identityStrategy }
          : {}),
        ...(selection.developerMetadataKey
          ? { developerMetadataKey: selection.developerMetadataKey }
          : {}),
        ...(selection.developerMetadataConsent
          ? { developerMetadataConsent: true }
          : {}),
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

  /**
   * A metadata identity is accepted only when every non-empty imported row has
   * exactly one row-scoped marker in the selected sheet. This makes a later
   * sort/row insertion a locator update rather than a best-effort row guess.
   */
  private async withDeveloperMetadataIdentity(
    dataset: Dataset,
    selection: GoogleImportSelection,
    accessToken: string,
    snapshotRows: GoogleMetadataRow[],
  ): Promise<Dataset> {
    const source = dataset.source as GoogleSource;
    const key = source.developerMetadataKey;
    if (
      !source.developerMetadataConsent ||
      !validMetadataText(key) ||
      source.sheetId === undefined ||
      !source.headerRow ||
      !source.endRow
    ) {
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_UNSAFE",
        "Metadata identity needs explicit consent and a sheet-scoped key.",
      );
    }
    // The identity marker and cell values were read together above. A second
    // metadata search verifies that no marker was added/removed/reused while
    // the snapshot was in flight, but it never supplies a later row position
    // to pair with those earlier cells (a concurrent sort would make that
    // pairing unsafe).
    const searchedRows = await this.searchMetadataRows(
      source.spreadsheetId!,
      key,
      source.sheetId,
      accessToken,
    );
    const snapshotById = new Map(snapshotRows.map((item) => [item.id, item]));
    const searchedById = new Map(searchedRows.map((item) => [item.id, item]));
    if (
      snapshotById.size !== snapshotRows.length ||
      searchedById.size !== searchedRows.length ||
      snapshotById.size !== searchedById.size ||
      [...snapshotById].some(
        ([id, item]) => searchedById.get(id)?.value !== item.value,
      )
    ) {
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_MISMATCH",
        "Google row metadata changed while source cells were read; refresh again before using row identities.",
      );
    }
    const rows = snapshotRows;
    const byRow = new Map<number, GoogleMetadataRow>();
    const byValue = new Set<string>();
    for (const item of rows) {
      if (
        item.row <= source.headerRow ||
        item.row > source.endRow ||
        byRow.has(item.row) ||
        byValue.has(item.value)
      ) {
        throw new HttpError(
          409,
          "GOOGLE_METADATA_IDENTITY_MISMATCH",
          "Google row metadata is duplicate, outside the selected range, or ambiguous.",
        );
      }
      byRow.set(item.row, item);
      byValue.add(item.value);
    }
    const recordRows = new Set<number>();
    const records = dataset.records.map((record) => {
      if (!record.sourceRow || recordRows.has(record.sourceRow))
        throw new HttpError(
          409,
          "GOOGLE_METADATA_IDENTITY_MISMATCH",
          "Imported Google rows do not have unique source locations.",
        );
      recordRows.add(record.sourceRow);
      const located = byRow.get(record.sourceRow);
      if (!located) return record;
      return {
        ...record,
        id: `google-${sha256(`${selection.spreadsheetId}:${selection.sheetId}:${key}:${located.value}`)}`,
        sourceIdentity: located.value,
      };
    });
    if ([...byRow.keys()].some((row) => !recordRows.has(row)))
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_MISMATCH",
        "Google metadata points to a blank or unimported row; refresh is unsafe.",
      );
    return { ...dataset, records };
  }

  private async searchMetadataRows(
    spreadsheetId: string,
    key: string,
    sheetId: number,
    accessToken: string,
  ): Promise<GoogleMetadataRow[]> {
    const result = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/developerMetadata:search`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          dataFilters: [
            {
              developerMetadataLookup: {
                metadataKey: key,
                locationType: "ROW",
                visibility: "DOCUMENT",
              },
            },
          ],
        }),
      },
    );
    return metadataRows(result, key, sheetId);
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

interface PreparedGooglePatch {
  source: GoogleSource;
  spreadsheetId: string;
  accessToken: string;
  record: WorkRecord;
  patch: RecordPatch;
  columns: Record<string, string>;
  metadata: GoogleMetadataRow;
  keys: string[];
  recordSource?: Pick<WorkRecord, "sourceRow" | "sourceIdentity">;
}

interface PatchExpectation {
  preimage: Record<string, CellValue>;
  postwrite: Record<string, CellValue>;
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

  /** Creates an isolated connector without changing this connector's credentials. */
  withCredentials(credentials: GoogleCredentialStore): GoogleSheetsConnector {
    return new GoogleSheetsConnector(credentials, this.request);
  }

  async applyPatch(
    dataset: Dataset,
    patch: RecordPatch,
    userId: string,
  ): Promise<GoogleWriteResult> {
    const source = dataset.source as GoogleSource;
    if (source.identityStrategy === "developer-metadata")
      return this.applyMetadataPatch(dataset, patch, userId);
    throw new HttpError(
      409,
      "GOOGLE_METADATA_IDENTITY_REQUIRED",
      "Google writes stay read-only until explicit row metadata identity is enabled. A visible ID column alone cannot safely guard a concurrent sort.",
    );
  }

  /**
   * Read-only reconciliation. A worker may retry only after this returns
   * `not-applied`; a mixed state is deliberately terminal until a person
   * resolves it. The caller's credential is reacquired and Drive canEdit is
   * rechecked here, rather than trusting an earlier worker attempt.
   */
  async verifyPatchOutcome(
    dataset: Dataset,
    patch: RecordPatch,
    userId: string,
  ): Promise<GooglePatchVerification> {
    const prepared = await this.preparePatch(dataset, patch, userId);
    const expectation = this.patchExpectation(dataset, prepared);
    const current = await this.readPatchState(prepared);
    if (this.matchesPatchState(prepared, expectation.preimage, current))
      return { outcome: "not-applied" };
    if (this.matchesPatchState(prepared, expectation.postwrite, current))
      return {
        outcome: "applied",
        write: this.patchResult(
          dataset,
          prepared,
          expectation.preimage,
          current.values,
        ),
      };
    throw new HttpError(
      409,
      "GOOGLE_RECOVERY_CONFLICT",
      "Google patch recovery found a mixed or unrelated source state. It will not retry or overwrite it.",
    );
  }

  async recoverPatch(
    dataset: Dataset,
    patch: RecordPatch,
    userId: string,
  ): Promise<GooglePatchVerification> {
    return this.verifyPatchOutcome(dataset, patch, userId);
  }

  /**
   * Explicitly tags every currently represented row with document-visible
   * developer metadata. It is idempotent only when the exact expected marker
   * already exists; partial or unrelated markers fail closed.
   */
  async enableMetadataIdentity(
    dataset: Dataset,
    request: GoogleMetadataIdentityEnableRequest,
    userId: string,
  ): Promise<GoogleMetadataIdentityEnableResult> {
    metadataOperationValue(request.operationId);
    if (request.consent !== true)
      throw new HttpError(
        400,
        "GOOGLE_METADATA_CONSENT_REQUIRED",
        "Explicit consent is required before row developer metadata is created.",
      );
    const source = dataset.source as GoogleSource;
    if (
      source.kind !== "google" ||
      !source.spreadsheetId ||
      !source.sheetName ||
      source.sheetId === undefined ||
      !source.headerRow ||
      !source.startColumn ||
      !source.endColumn ||
      !source.endRow ||
      !source.sourceColumns ||
      !source.sourceHeaders ||
      dataset.records.length === 0
    ) {
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_UNSAFE",
        "Developer-metadata identity is only available for a bounded Google source.",
      );
    }
    const key =
      source.developerMetadataKey ?? `sheet-workbench.row.v1:${dataset.id}`;
    if (!validMetadataText(key))
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_UNSAFE",
        "The dataset developer-metadata key is invalid.",
      );
    const accessToken = await this.credentials.accessToken(userId);
    await this.assertCanEdit(source.spreadsheetId, accessToken);
    await this.assertHeaderSchema(
      source.spreadsheetId,
      source.sheetName,
      source,
      accessToken,
    );
    let rows = await this.searchMetadataRows(
      source.spreadsheetId,
      key,
      source.sheetId,
      accessToken,
    );
    this.assertDistinctMetadataRows(rows, source);
    const expected = new Map<string, WorkRecord>();
    for (const record of dataset.records) {
      if (
        !record.sourceRow ||
        expected.has(record.sourceIdentity ?? metadataExistingValue(record))
      )
        throw new HttpError(
          409,
          "GOOGLE_METADATA_IDENTITY_MISMATCH",
          "Google records need unique source rows and metadata identities before enablement.",
        );
      expected.set(
        record.sourceIdentity ?? metadataExistingValue(record),
        record,
      );
    }
    if (rows.some((row) => !expected.has(row.value)))
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_MISMATCH",
        "Google contains unrelated developer metadata for this dataset identity key.",
      );
    const byValue = new Map(rows.map((row) => [row.value, row]));
    const preparedRecords = dataset.records.map((record) => {
      const identity = record.sourceIdentity ?? metadataExistingValue(record);
      const located = byValue.get(identity);
      return {
        ...record,
        sourceIdentity: identity,
        ...(located ? { sourceRow: located.row } : {}),
      };
    });
    await this.assertMetadataEnablePreimage(
      dataset,
      source,
      preparedRecords,
      accessToken,
    );
    const toCreate = preparedRecords.filter(
      (record) => !byValue.has(record.sourceIdentity!),
    );
    if (toCreate.length) {
      await this.google(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId)}:batchUpdate`,
        accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            requests: toCreate.map((record) => ({
              createDeveloperMetadata: {
                developerMetadata: {
                  metadataKey: key,
                  metadataValue: record.sourceIdentity,
                  visibility: "DOCUMENT",
                  location: {
                    dimensionRange: {
                      sheetId: source.sheetId,
                      dimension: "ROWS",
                      startIndex: record.sourceRow! - 1,
                      endIndex: record.sourceRow!,
                    },
                  },
                },
              },
            })),
          }),
        },
      );
    }
    rows = await this.searchMetadataRows(
      source.spreadsheetId,
      key,
      source.sheetId,
      accessToken,
    );
    this.assertDistinctMetadataRows(rows, source);
    const confirmed = new Map(rows.map((row) => [row.value, row]));
    if (
      confirmed.size !== preparedRecords.length ||
      preparedRecords.some((record) => !confirmed.has(record.sourceIdentity!))
    )
      throw new HttpError(
        502,
        "GOOGLE_POSTWRITE_UNCERTAIN",
        "Google did not confirm every requested row identity; local data was not changed.",
      );
    const confirmedRecords = preparedRecords.map((record) => ({
      ...record,
      sourceRow: confirmed.get(record.sourceIdentity!)!.row,
    }));
    // The metadata search establishes only that a marker exists at a row. A
    // concurrent sort or edit can otherwise make a fixed row-targeted create
    // attach a valid marker to the wrong logical record. Re-read the complete
    // selected grid at the confirmed locations before exposing identities.
    await this.assertMetadataEnablePreimage(
      dataset,
      source,
      confirmedRecords,
      accessToken,
    );
    const { readOnlyReason: _reason, ...sourceWithoutReason } = source;
    return {
      source: {
        ...sourceWithoutReason,
        identityStrategy: "developer-metadata",
        developerMetadataKey: key,
        developerMetadataConsent: true,
        readOnly: false,
      },
      records: confirmedRecords.map((record) => ({
        ...record,
        ...(dataset.mapping.identity
          ? {
              lockedFields: [
                ...new Set([
                  ...(record.lockedFields ?? []),
                  dataset.mapping.identity,
                ]),
              ],
            }
          : {}),
      })),
      replayed: toCreate.length === 0,
    };
  }

  /**
   * Inserts one blank source row at the explicit selection boundary, writes
   * only connected non-empty cells, and adds an operation marker in the same
   * atomic Sheets batch. The marker is always reconciled before another insert
   * is considered, so an uncertain response can never create a silent clone.
   */
  async createRow(
    dataset: Dataset,
    request: GoogleCreateRequest,
    userId: string,
  ): Promise<GoogleCreateResult> {
    const operationValue = metadataOperationValue(request.operationId);
    if (request.appendConsent !== true)
      throw new HttpError(
        400,
        "GOOGLE_APPEND_CONSENT_REQUIRED",
        "Explicit consent is required before inserting a Google source row.",
      );
    const source = dataset.source as GoogleSource;
    const metadataIdentity = source.identityStrategy === "developer-metadata";
    if (!metadataIdentity)
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_REQUIRED",
        "Google row creation stays read-only until explicit row metadata identity is enabled.",
      );
    if (
      source.kind !== "google" ||
      !source.spreadsheetId ||
      !source.sheetName ||
      source.sheetId === undefined ||
      !source.headerRow ||
      !source.startColumn ||
      !source.endColumn ||
      !source.endRow ||
      source.endRow >= 1_048_576 ||
      !source.sourceColumns ||
      !source.sourceHeaders ||
      !request.record.id ||
      !source.developerMetadataConsent ||
      !request.developerMetadataConsent
    ) {
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google row creation needs a bounded source, explicit append/metadata consent, and a verified connector.",
      );
    }
    const identityField = dataset.mapping.identity;
    if (
      identityField &&
      (!source.sourceColumns[identityField] ||
        request.record.values[identityField] === null ||
        request.record.values[identityField] === undefined ||
        request.record.values[identityField] === "")
    )
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "New rows with a visible Google ID need a non-empty value.",
      );
    const key =
      source.developerMetadataKey ?? `sheet-workbench.row.v1:${dataset.id}`;
    if (!validMetadataText(key))
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_UNSAFE",
        "The Google operation metadata key is invalid.",
      );
    const accessToken = await this.credentials.accessToken(userId);
    await this.assertCanEdit(source.spreadsheetId, accessToken);
    await this.assertHeaderSchema(
      source.spreadsheetId,
      source.sheetName,
      source,
      accessToken,
    );
    const sourceAfter = {
      ...source,
      endRow: source.endRow + 1,
      developerMetadataKey: key,
      developerMetadataConsent: true,
    } as GoogleSource;
    const existing = await this.searchMetadataRows(
      source.spreadsheetId,
      key,
      source.sheetId,
      accessToken,
      operationValue,
    );
    if (existing.length > 1)
      throw new HttpError(
        409,
        "GOOGLE_RECOVERY_CONFLICT",
        "Google contains duplicate operation metadata. A row insert will not be retried.",
      );
    if (existing[0])
      return this.confirmCreatedRow(
        dataset,
        request,
        {
          ...sourceAfter,
          endRow: Math.max(sourceAfter.endRow!, existing[0]!.row),
        },
        existing[0]!.row,
        operationValue,
        accessToken,
        true,
      );
    if (identityField)
      await this.assertIdentityAvailable(
        source.spreadsheetId,
        source.sheetName,
        source,
        identityField!,
        request.record.values[identityField!]!,
        accessToken,
      );
    const insertionIndex = source.endRow;
    const requests: Array<Record<string, unknown>> = [
      {
        insertDimension: {
          range: {
            sheetId: source.sheetId,
            dimension: "ROWS",
            startIndex: insertionIndex,
            endIndex: insertionIndex + 1,
          },
          // Dimension properties may inherit; no existing cell/formula value is
          // copied or overwritten by this request.
          inheritFromBefore: false,
        },
      },
      ...this.createCellRequests(
        dataset,
        request.record,
        source,
        insertionIndex,
      ),
      {
        createDeveloperMetadata: {
          developerMetadata: {
            metadataKey: key,
            metadataValue: operationValue,
            visibility: "DOCUMENT",
            location: {
              dimensionRange: {
                sheetId: source.sheetId,
                dimension: "ROWS",
                startIndex: insertionIndex,
                endIndex: insertionIndex + 1,
              },
            },
          },
        },
      },
    ];
    await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId)}:batchUpdate`,
      accessToken,
      { method: "POST", body: JSON.stringify({ requests }) },
    );
    const confirmed = await this.searchMetadataRows(
      source.spreadsheetId,
      key,
      source.sheetId,
      accessToken,
      operationValue,
    );
    if (confirmed.length !== 1)
      throw new HttpError(
        502,
        "GOOGLE_POSTWRITE_UNCERTAIN",
        "Google did not confirm the inserted row operation identity; local data was not changed.",
      );
    return this.confirmCreatedRow(
      dataset,
      request,
      sourceAfter,
      confirmed[0]!.row,
      operationValue,
      accessToken,
      false,
    );
  }

  /** Read-only create recovery that callers can run before a retry. */
  async verifyCreateOutcome(
    dataset: Dataset,
    request: GoogleCreateRequest,
    userId: string,
  ): Promise<GoogleCreateVerification> {
    const source = dataset.source as GoogleSource;
    const key =
      source.developerMetadataKey ?? `sheet-workbench.row.v1:${dataset.id}`;
    if (
      source.kind !== "google" ||
      !source.spreadsheetId ||
      source.sheetId === undefined ||
      !source.endRow ||
      !validMetadataText(key)
    )
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google row recovery needs the original bounded source metadata.",
      );
    const accessToken = await this.credentials.accessToken(userId);
    await this.assertCanEdit(source.spreadsheetId, accessToken);
    await this.assertHeaderSchema(
      source.spreadsheetId,
      source.sheetName!,
      source,
      accessToken,
    );
    const rows = await this.searchMetadataRows(
      source.spreadsheetId,
      key,
      source.sheetId,
      accessToken,
      metadataOperationValue(request.operationId),
    );
    if (rows.length === 0) return { outcome: "not-applied" };
    if (rows.length > 1)
      throw new HttpError(
        409,
        "GOOGLE_RECOVERY_CONFLICT",
        "Google contains duplicate operation metadata. A row insert will not be retried.",
      );
    const sourceAfter = {
      ...source,
      endRow: Math.max(source.endRow + 1, rows[0]!.row),
      developerMetadataKey: key,
      developerMetadataConsent: true,
    } as GoogleSource;
    return {
      outcome: "applied",
      create: await this.confirmCreatedRow(
        dataset,
        request,
        sourceAfter,
        rows[0]!.row,
        metadataOperationValue(request.operationId),
        accessToken,
        true,
      ),
    };
  }

  private async applyMetadataPatch(
    dataset: Dataset,
    patch: RecordPatch,
    userId: string,
  ): Promise<GoogleWriteResult> {
    const prepared = await this.preparePatch(dataset, patch, userId);
    const expectation = this.patchExpectation(dataset, prepared);
    const before = await this.readPatchState(prepared);
    if (!this.matchesPatchState(prepared, expectation.preimage, before))
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_CONFLICT",
        "Google Sheets changed one or more requested cells or made them formulas; no write was made.",
      );
    await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(prepared.spreadsheetId)}/values:batchUpdateByDataFilter`,
      prepared.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "RAW",
          // Developer metadata follows its row through a sort. Null entries
          // are skipped by the Values API; only mapped changed columns have a
          // typed value (or an explicit empty string to clear it).
          data: [this.metadataWriteRange(prepared, expectation)],
        }),
      },
    );
    const after = await this.readPatchState(prepared);
    if (!this.matchesPatchState(prepared, expectation.postwrite, after))
      throw new HttpError(
        502,
        "GOOGLE_POSTWRITE_UNCERTAIN",
        "Google did not confirm every requested source cell after writing; local data was not changed.",
      );
    const located = await this.locateMetadataRow(
      prepared.spreadsheetId,
      prepared.source,
      prepared.record.sourceIdentity!,
      prepared.accessToken,
    );
    prepared.recordSource = {
      sourceRow: located.row,
      sourceIdentity: prepared.record.sourceIdentity!,
    };
    return this.patchResult(
      dataset,
      prepared,
      expectation.preimage,
      after.values,
    );
  }

  private async preparePatch(
    dataset: Dataset,
    patch: RecordPatch,
    userId: string,
  ): Promise<PreparedGooglePatch> {
    const source = dataset.source as GoogleSource;
    const spreadsheetId = source.spreadsheetId;
    const sheetName = source.sheetName;
    const record = dataset.records.find((item) => item.id === patch.recordId);
    const columns = source.sourceColumns;
    const metadata = source.identityStrategy === "developer-metadata";
    if (!metadata)
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_REQUIRED",
        "Google source recovery is disabled until explicit row metadata identity is enabled.",
      );
    if (
      source.kind !== "google" ||
      !spreadsheetId ||
      !sheetName ||
      !record ||
      !columns ||
      !source.sourceHeaders ||
      !source.headerRow ||
      !source.endRow ||
      !source.developerMetadataConsent ||
      !validMetadataText(source.developerMetadataKey) ||
      source.sheetId === undefined ||
      !validMetadataText(record.sourceIdentity)
    ) {
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google writeback needs verified source identity, row, and column metadata.",
      );
    }
    for (const key of Object.keys(patch.changes)) {
      if (!columns[key] || record.lockedFields?.includes(key))
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_UNSAFE",
          `Google cannot safely write field "${key}".`,
        );
    }
    const accessToken = await this.credentials.accessToken(userId);
    await this.assertCanEdit(spreadsheetId, accessToken);
    await this.assertHeaderSchema(
      spreadsheetId,
      sheetName,
      source,
      accessToken,
    );
    const metadataRow = await this.locateMetadataRow(
      spreadsheetId,
      source,
      record.sourceIdentity!,
      accessToken,
    );
    const keys = Object.keys(patch.changes);
    return {
      source,
      spreadsheetId,
      accessToken,
      record,
      patch,
      columns,
      metadata: metadataRow,
      keys,
      recordSource: {
        sourceRow: metadataRow.row,
        sourceIdentity: record.sourceIdentity!,
      },
    };
  }

  private patchExpectation(
    dataset: Dataset,
    prepared: PreparedGooglePatch,
  ): PatchExpectation {
    const preimage: Record<string, CellValue> = {};
    const postwrite: Record<string, CellValue> = {};
    for (const key of prepared.keys) {
      const value = prepared.patch.changes[key]!;
      preimage[key] = this.expectedPreimage(prepared.record, dataset, key);
      const next = this.writeValue(prepared.record, dataset, key, value);
      postwrite[key] = next === "" ? null : next;
    }
    return { preimage, postwrite };
  }

  private async readPatchState(prepared: PreparedGooglePatch): Promise<{
    values: CellValue[];
    formulas: CellValue[];
  }> {
    return {
      values: await this.readMetadataColumns(prepared, "UNFORMATTED_VALUE"),
      formulas: await this.readMetadataColumns(prepared, "FORMULA"),
    };
  }

  private metadataFilter(
    prepared: PreparedGooglePatch,
  ): Record<string, unknown> {
    return {
      developerMetadataLookup: {
        // An exact metadata ID, not a row number or matching cell value, is
        // the only target accepted for a metadata-backed write/read.
        metadataId: prepared.metadata.id,
      },
    };
  }

  private metadataWriteRange(
    prepared: PreparedGooglePatch,
    expectation: PatchExpectation,
  ): Record<string, unknown> {
    const changedColumns = prepared.keys.map((key) => {
      const column = columnNumber(prepared.columns[key]!);
      if (!column)
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_UNSAFE",
          `Google source column "${key}" is invalid.`,
        );
      return { key, column };
    });
    const values: Array<CellValue | ""> = Array.from(
      { length: Math.max(...changedColumns.map(({ column }) => column)) },
      () => null,
    );
    for (const { key, column } of changedColumns) {
      const next = expectation.postwrite[key]!;
      values[column - 1] = next === null ? "" : next;
    }
    return {
      dataFilter: this.metadataFilter(prepared),
      majorDimension: "ROWS",
      values: [values],
    };
  }

  private async readMetadataColumns(
    prepared: PreparedGooglePatch,
    valueRenderOption: "UNFORMATTED_VALUE" | "FORMULA",
  ): Promise<CellValue[]> {
    const response = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(prepared.spreadsheetId)}/values:batchGetByDataFilter`,
      prepared.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          dataFilters: [this.metadataFilter(prepared)],
          majorDimension: "ROWS",
          valueRenderOption,
        }),
      },
    );
    const matched = Array.isArray(response.valueRanges)
      ? response.valueRanges
      : [];
    if (matched.length !== 1)
      throw new HttpError(
        502,
        "GOOGLE_PREIMAGE_UNCERTAIN",
        "Google did not return exactly one metadata-selected source row.",
      );
    const valueRange = (matched[0] as { valueRange?: { values?: unknown } })
      .valueRange;
    const row =
      valueRange &&
      Array.isArray(valueRange.values) &&
      Array.isArray(valueRange.values[0])
        ? valueRange.values[0]
        : [];
    return prepared.keys.map((key) => {
      const column = columnNumber(prepared.columns[key]!);
      const value = column ? row[column - 1] : undefined;
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
        "A metadata-selected Google source cell has an unsupported type.",
      );
    });
  }

  private matchesPatchState(
    prepared: PreparedGooglePatch,
    expected: Record<string, CellValue>,
    state: { values: CellValue[]; formulas: CellValue[] },
  ): boolean {
    return prepared.keys.every(
      (key, index) =>
        !isFormula(state.formulas[index]) &&
        sameCell(state.values[index], expected[key]!),
    );
  }

  private patchResult(
    dataset: Dataset,
    prepared: PreparedGooglePatch,
    preimage: Record<string, CellValue>,
    values: CellValue[],
  ): GoogleWriteResult {
    const postwrite = Object.fromEntries(
      prepared.keys.map((key, index) => [key, values[index]!]),
    ) as Record<string, CellValue>;
    const sourceValues =
      dataset.mapping.date &&
      Object.hasOwn(prepared.patch.changes, dataset.mapping.date)
        ? { [dataset.mapping.date]: postwrite[dataset.mapping.date]! }
        : undefined;
    return {
      preimage,
      postwrite,
      ...(sourceValues ? { sourceValues } : {}),
      ...(prepared.recordSource ? { recordSource: prepared.recordSource } : {}),
    };
  }

  private assertDistinctMetadataRows(
    rows: GoogleMetadataRow[],
    source: GoogleSource,
  ): void {
    const values = new Set<string>();
    const locations = new Set<number>();
    for (const item of rows) {
      if (
        !source.headerRow ||
        !source.endRow ||
        item.row <= source.headerRow ||
        item.row > source.endRow ||
        values.has(item.value) ||
        locations.has(item.row)
      )
        throw new HttpError(
          409,
          "GOOGLE_METADATA_IDENTITY_MISMATCH",
          "Google row metadata is duplicate, ambiguous, or outside the selected source range.",
        );
      values.add(item.value);
      locations.add(item.row);
    }
  }

  /** Validate every connected cell before any row identity metadata is added. */
  private async assertMetadataEnablePreimage(
    dataset: Dataset,
    source: GoogleSource,
    records: WorkRecord[],
    accessToken: string,
  ): Promise<void> {
    const grid = await this.selectionGrid(source, accessToken);
    const byRow = new Map<number, WorkRecord>();
    for (const record of records) {
      if (!record.sourceRow || byRow.has(record.sourceRow))
        throw new HttpError(
          409,
          "GOOGLE_METADATA_IDENTITY_MISMATCH",
          "Developer-metadata enablement needs unique local source rows.",
        );
      byRow.set(record.sourceRow, record);
    }
    const columns = source.sourceColumns!;
    for (let index = 1; index < grid.length; index += 1) {
      const sourceRow = source.headerRow! + index;
      const record = byRow.get(sourceRow);
      const cells = grid[index]!;
      const populated = Object.values(columns).some((label) => {
        const column = columnNumber(label)! - source.startColumn!;
        const cell = cells[column];
        return plainCell(cell) !== null || hasFormula(cell);
      });
      if (!record) {
        if (populated)
          throw new HttpError(
            409,
            "GOOGLE_METADATA_IDENTITY_MISMATCH",
            "Google has an untracked populated row. Refresh and explicitly review it before adding identities.",
          );
        continue;
      }
      for (const [key, label] of Object.entries(columns)) {
        const column = columnNumber(label)! - source.startColumn!;
        const cell = cells[column];
        if (hasFormula(cell))
          throw new HttpError(
            409,
            "GOOGLE_METADATA_IDENTITY_UNSAFE",
            "Google formula cells cannot be assigned a new row identity without review.",
          );
        if (
          !sameCell(
            plainCell(cell),
            this.expectedPreimage(record, dataset, key),
          )
        )
          throw new HttpError(
            409,
            "GOOGLE_METADATA_IDENTITY_MISMATCH",
            "Google row values changed or relocated while identity enablement was in progress; local identities were not enabled.",
          );
      }
    }
  }

  private async selectionGrid(
    source: GoogleSource,
    accessToken: string,
  ): Promise<GoogleGridCell[][]> {
    const range = `${quotedSheet(source.sheetName!)}!${columnLabel(source.startColumn!)}${source.headerRow!}:${columnLabel(source.endColumn!)}${source.endRow!}`;
    const fields = encodeURIComponent(
      "sheets(data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue))))",
    );
    const result = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId!)}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${fields}`,
      accessToken,
    );
    const sheet = (
      Array.isArray(result.sheets) ? result.sheets[0] : undefined
    ) as
      | {
          data?: Array<{
            startRow?: unknown;
            startColumn?: unknown;
            rowData?: Array<{ values?: GoogleGridCell[] }>;
          }>;
        }
      | undefined;
    const data = sheet?.data?.[0];
    const rowData = data?.rowData ?? [];
    const responseStartRow =
      typeof data?.startRow === "number"
        ? data.startRow
        : source.headerRow! - 1;
    const responseStartColumn =
      typeof data?.startColumn === "number"
        ? data.startColumn
        : source.startColumn! - 1;
    const rowOffset = responseStartRow - (source.headerRow! - 1);
    const columnOffset = responseStartColumn - (source.startColumn! - 1);
    const height = source.endRow! - source.headerRow! + 1;
    const width = source.endColumn! - source.startColumn! + 1;
    return Array.from({ length: height }, (_, row) =>
      Array.from(
        { length: width },
        (_, column) =>
          rowData[row - rowOffset]?.values?.[column - columnOffset] ?? {},
      ),
    );
  }

  private createCellRequests(
    dataset: Dataset,
    record: WorkRecord,
    source: GoogleSource,
    rowIndex: number,
  ): Array<Record<string, unknown>> {
    return Object.entries(source.sourceColumns!).flatMap(([key, label]) => {
      const column = columnNumber(label);
      if (!column)
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_UNSAFE",
          `Google source column "${key}" is invalid.`,
        );
      const value = this.createWriteValue(dataset, record, key);
      if (value === null) return [];
      return [
        {
          updateCells: {
            start: {
              sheetId: source.sheetId,
              rowIndex,
              columnIndex: column - 1,
            },
            rows: [
              {
                values: [{ userEnteredValue: this.extendedValue(value) }],
              },
            ],
            // This targets one cell only; unconnected cells and formulas are
            // never supplied to the request and therefore remain untouched.
            fields: "userEnteredValue",
          },
        },
      ];
    });
  }

  private createWriteValue(
    dataset: Dataset,
    record: WorkRecord,
    key: string,
  ): CellValue {
    const value = record.values[key] ?? null;
    if (value === null || value === "") return null;
    if (key !== dataset.mapping.date) return value;
    if (typeof value !== "string" || !validIsoDate(value))
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "New Google date values must use canonical YYYY-MM-DD text.",
      );
    const rawTypes = new Set(
      dataset.records
        .map((item) => item.sourceValues?.[key])
        .filter(
          (item): item is Exclude<CellValue, null> =>
            item !== null && item !== undefined,
        )
        .map((item) => typeof item),
    );
    if (rawTypes.size > 1 || rawTypes.has("boolean"))
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google date column types are mixed or unsupported. Refresh and review before adding a date row.",
      );
    return rawTypes.has("number") ? googleDateSerial(value) : value;
  }

  private extendedValue(
    value: Exclude<CellValue, null>,
  ): Record<string, unknown> {
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "number") return { numberValue: value };
    return { boolValue: value };
  }

  private async confirmCreatedRow(
    dataset: Dataset,
    request: GoogleCreateRequest,
    source: GoogleSource,
    row: number,
    operationValue: string,
    accessToken: string,
    replayed: boolean,
  ): Promise<GoogleCreateResult> {
    if (!source.spreadsheetId || !source.sheetName || !source.sourceColumns)
      throw new HttpError(
        409,
        "GOOGLE_SOURCE_UNSAFE",
        "Google source metadata is incomplete for create confirmation.",
      );
    const escapeSheet = (name: string) => `'${name.replaceAll("'", "''")}'`;
    const keys = Object.keys(source.sourceColumns);
    const ranges = keys.map(
      (key) =>
        `${escapeSheet(source.sheetName!)}!${source.sourceColumns![key]}${row}`,
    );
    const values = await this.readRanges(
      source.spreadsheetId,
      ranges,
      accessToken,
      "UNFORMATTED_VALUE",
    );
    const formulas = await this.readRanges(
      source.spreadsheetId,
      ranges,
      accessToken,
      "FORMULA",
    );
    for (const [index, key] of keys.entries()) {
      const expected = this.createWriteValue(dataset, request.record, key);
      if (isFormula(formulas[index]) || !sameCell(values[index], expected))
        throw new HttpError(
          502,
          "GOOGLE_POSTWRITE_UNCERTAIN",
          "Google did not confirm the exact inserted row values; local data was not changed.",
        );
    }
    const metadataIdentity = source.identityStrategy === "developer-metadata";
    const identityField = dataset.mapping.identity;
    const record: WorkRecord = {
      ...request.record,
      sourceRow: row,
      ...(metadataIdentity ? { sourceIdentity: operationValue } : {}),
      ...(identityField
        ? {
            lockedFields: [
              ...new Set([
                ...(request.record.lockedFields ?? []),
                identityField,
              ]),
            ],
          }
        : {}),
      ...(dataset.mapping.date
        ? {
            sourceValues: {
              ...request.record.sourceValues,
              [dataset.mapping.date]: this.createWriteValue(
                dataset,
                request.record,
                dataset.mapping.date,
              ),
            },
          }
        : {}),
    };
    return {
      record,
      source,
      operationIdentity: {
        strategy: "developer-metadata",
        value: operationValue,
      },
      replayed,
    };
  }

  private async assertIdentityAvailable(
    spreadsheetId: string,
    sheetName: string,
    source: GoogleSource,
    identityField: string,
    candidate: CellValue,
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
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (isFormula(formulas[index]))
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_CONFLICT",
          "The Google identity column contains a formula; no row was inserted.",
        );
      if (value === null) continue;
      const signature = `${typeof value}:${String(value)}`;
      if (seen.has(signature) || sameCell(value, candidate))
        throw new HttpError(
          409,
          "GOOGLE_SOURCE_CONFLICT",
          "The Google identity column contains a duplicate or the requested new ID already exists.",
        );
      seen.add(signature);
    }
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

  private async locateMetadataRow(
    spreadsheetId: string,
    source: GoogleSource,
    value: string,
    accessToken: string,
  ): Promise<GoogleMetadataRow> {
    if (
      !validMetadataText(source.developerMetadataKey) ||
      source.sheetId === undefined ||
      !source.headerRow ||
      !source.endRow
    )
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_UNSAFE",
        "Google metadata identity is incomplete. Re-import or enable it again before writing.",
      );
    const rows = await this.searchMetadataRows(
      spreadsheetId,
      source.developerMetadataKey,
      source.sheetId,
      accessToken,
      value,
    );
    if (
      rows.length !== 1 ||
      rows[0]!.row <= source.headerRow ||
      rows[0]!.row > source.endRow
    )
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_MISMATCH",
        "Google row metadata is missing, duplicate, or outside the selected source range.",
      );
    return rows[0]!;
  }

  private async searchMetadataRows(
    spreadsheetId: string,
    key: string,
    sheetId: number,
    accessToken: string,
    value?: string,
  ): Promise<GoogleMetadataRow[]> {
    const result = await this.google(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/developerMetadata:search`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          dataFilters: [
            {
              developerMetadataLookup: {
                metadataKey: key,
                ...(value ? { metadataValue: value } : {}),
                locationType: "ROW",
                visibility: "DOCUMENT",
              },
            },
          ],
        }),
      },
    );
    const rows = metadataRows(result, key, sheetId);
    if (value && rows.some((item) => item.value !== value))
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_MISMATCH",
        "Google returned unrelated developer metadata for this row identity.",
      );
    return rows;
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
