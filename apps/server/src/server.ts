import { basename } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  applyRecordPatch,
  createRecord,
  DomainError,
  labelKey,
  undoChange,
  validateDataset,
  type CellValue,
  type ChangeEntry,
  type Dataset,
  type Field,
  type Mapping,
  type RecordPatch,
  type Role,
  type WorkRecord,
} from "../../../packages/core/src/index.ts";
import {
  exportWorkbook,
  importWorkbook,
  inspectWorkbook,
  reimportWorkbook,
  XlsxSafetyError,
  type ReimportResult,
} from "../../../packages/xlsx/src/index.ts";
import {
  createBetterAuth,
  trustedOriginsFor,
  sessionFromAuth,
  passwordResetEnabled,
  type AuthConfiguration,
  type BetterAuthInstance,
  type SessionUser,
} from "./auth.ts";
import { asJson, inTransaction, parseJson, type SqlClient } from "./db.ts";
import {
  conflict,
  forbidden,
  HttpError,
  setupNeeded,
  unauthorized,
  unavailable,
} from "./errors.ts";
import {
  GoogleSheetsConnector,
  GoogleSheetsReader,
  PostgresGoogleCredentials,
  PreparedGoogleCredentials,
  googlePickerConfiguration,
  type GoogleConfiguration,
  type GoogleCredentialStore,
  type GoogleWriteResult,
} from "./google.ts";
import { registerPortability } from "./portability.ts";
import {
  prepareGoogleIdentityPreview,
  assertGoogleIdentityPreviewFingerprint,
} from "./google-identity-preview.ts";
import {
  SourceQueue,
  sourceJobResult,
  type SourceJob,
} from "./source-queue.ts";
import {
  registerAdministration,
  prepareAccountErasure,
} from "./administration.ts";
import {
  lockActiveActor,
  lockWorkspaceAccess,
  withActorTransaction,
} from "./write-access.ts";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const INVITATION_TTL_DAYS = 7;

export interface XlsxService {
  inspect(bytes: Uint8Array, fileName: string): Promise<unknown>;
  import(bytes: Uint8Array, options: XlsxImportOptions): Promise<Dataset>;
  export(original: Uint8Array, dataset: Dataset): Promise<Uint8Array>;
  reimport(
    existing: Dataset,
    bytes: Uint8Array,
    options: XlsxImportOptions,
  ): Promise<ReimportResult>;
}

export interface XlsxImportOptions {
  sheetName: string;
  headerRow: number;
  startColumn: number;
  endColumn: number;
  endRow: number;
  mapping: Mapping;
  name: string;
  fileName?: string;
  dateOrder: Dataset["dateOrder"];
  locale: Dataset["locale"];
  timeZone: string;
  weekStartsOn: Dataset["weekStartsOn"];
}

export interface ServerOptions {
  /** A real pg Pool in production; PGlite may be supplied by integration tests. */
  db?: SqlClient;
  auth?: BetterAuthInstance;
  authConfig?: AuthConfiguration;
  /** Test-only seam. Production must use Better Auth, never this callback. */
  sessionResolver?: (
    request: FastifyRequest,
  ) => Promise<SessionUser | null> | SessionUser | null;
  xlsx?: XlsxService;
  google?: {
    config?: GoogleConfiguration;
    credentials?: GoogleCredentialStore;
    connector?: GoogleSheetsConnector;
    reader?: GoogleSheetsReader;
  };
  trustedOrigins?: string[];
  storageLabel?: string;
  logger?: boolean;
  /** Disabled for deterministic injection tests; enabled by default in production. */
  sourceWorker?: boolean;
}

interface DatasetRow {
  id: string;
  workspace_id: string;
  snapshot: unknown;
  revision: number;
  source_kind: Dataset["source"]["kind"];
  source_upload_id?: string | null;
  updated_at: string | Date;
}

interface ChangeRow {
  id: string;
  operation_id: string;
  actor_id: string;
  entry: unknown;
  record: unknown;
  dataset_revision: number;
}

interface DatasetOperationRow {
  actor_id: string;
  result: unknown;
}

interface WorkspaceAccess {
  user: SessionUser;
  role: Role;
}

interface PreparedGoogleClient {
  actorId: string;
  reader?: GoogleSheetsReader;
  connector?: GoogleSheetsConnector;
}

const cellValue = z.union([
  z.string().max(20_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const operationId = z
  .string()
  .min(12)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "must be URL-safe");
// Imported rows use deterministic `xlsx-…`/`google-…` identifiers while new
// rows use UUIDs. This admits those core-owned IDs without allowing path-ish
// or control-character identifiers into SQL-backed audit records.
const recordId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "must be a safe record identifier");
const roleSchema = z.enum(["owner", "editor", "viewer"]);
const patchSchema = z
  .object({
    operationId,
    recordId,
    baseRevision: z.number().int().nonnegative(),
    changes: z
      .record(z.string().min(1).max(120), cellValue)
      .refine(
        (value) => Object.keys(value).length > 0,
        "must include a change",
      ),
  })
  .strict();
const mappingSchema = z
  .object({
    title: z.string().min(1).max(120),
    date: z.string().min(1).max(120).optional(),
    assignee: z.string().min(1).max(120).optional(),
    status: z.string().min(1).max(120).optional(),
    category: z.string().min(1).max(120).optional(),
    url: z.string().min(1).max(120).optional(),
    identity: z.string().min(1).max(120).optional(),
  })
  .strict();
const fieldSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    label: z.string().min(1).max(120),
    type: z.enum(["text", "date", "number", "select", "url"]),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1).max(120)).max(100).optional(),
  })
  .strict();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

function jsonBody<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success)
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "Request body is invalid.",
      parsed.error.flatten(),
    );
  return parsed.data;
}

function params(request: FastifyRequest): Record<string, string> {
  return request.params as Record<string, string>;
}

function headersFromRequest(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

function rowDataset(row: DatasetRow): Dataset {
  const dataset = parseJson<Dataset>(row.snapshot);
  // The scalar revision is a cheap concurrency guard, while snapshot remains
  // the canonical portable representation. Detect corruption instead of
  // silently selecting one of two inconsistent revisions.
  if (dataset.revision !== Number(row.revision))
    throw new HttpError(
      500,
      "DATASET_CORRUPT",
      "Stored dataset revision is inconsistent.",
    );
  return validateDataset(dataset);
}

function datasetSummary(
  dataset: Dataset,
): Pick<Dataset, "id" | "name" | "source" | "revision" | "updatedAt"> {
  return {
    id: dataset.id,
    name: dataset.name,
    source: dataset.source,
    revision: dataset.revision,
    updatedAt: dataset.updatedAt,
  };
}

function safeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 160);
  return name || "workbook.xlsx";
}

function cellEqual(
  left: CellValue | undefined,
  right: CellValue | undefined,
): boolean {
  return (
    left === right ||
    (typeof left === "number" &&
      typeof right === "number" &&
      Object.is(left, right))
  );
}

/** Preserve local record revision guards when a reviewed import replaces rows. */
function prepareReimportCandidate(
  existing: Dataset,
  incoming: Dataset,
  fileName: string,
): Dataset {
  const oldById = new Map(
    existing.records.map((record) => [record.id, record]),
  );
  const records = incoming.records.map((record) => {
    const previous = oldById.get(record.id);
    if (!previous) return record;
    const valuesChanged = Object.keys({
      ...previous.values,
      ...record.values,
    }).some((key) => !cellEqual(previous.values[key], record.values[key]));
    const sourceChanged =
      previous.sourceRow !== record.sourceRow ||
      JSON.stringify(previous.lockedFields ?? []) !==
        JSON.stringify(record.lockedFields ?? []);
    return {
      ...record,
      revision: previous.revision + (valuesChanged || sourceChanged ? 1 : 0),
    };
  });
  return {
    ...incoming,
    id: existing.id,
    source: { ...incoming.source, kind: "xlsx", fileName },
    mapping: existing.mapping,
    completedStatuses: existing.completedStatuses,
    records,
    revision: existing.revision,
    updatedAt: existing.updatedAt,
  };
}

function reimportDiff(
  existing: Dataset,
  candidate: Dataset,
): Array<Record<string, unknown>> {
  const before = new Map(existing.records.map((record) => [record.id, record]));
  const after = new Map(candidate.records.map((record) => [record.id, record]));
  const changes: Array<Record<string, unknown>> = [];
  for (const [id, oldRecord] of before) {
    const nextRecord = after.get(id);
    if (!nextRecord) {
      changes.push({ kind: "removed", recordId: id, before: oldRecord.values });
      continue;
    }
    const fields: Record<
      string,
      { before: CellValue | undefined; after: CellValue | undefined }
    > = {};
    for (const key of Object.keys({
      ...oldRecord.values,
      ...nextRecord.values,
    })) {
      if (!cellEqual(oldRecord.values[key], nextRecord.values[key]))
        fields[key] = {
          before: oldRecord.values[key],
          after: nextRecord.values[key],
        };
    }
    if (
      Object.keys(fields).length ||
      oldRecord.sourceRow !== nextRecord.sourceRow
    ) {
      changes.push({
        kind: "changed",
        recordId: id,
        fields,
        sourceRow: { before: oldRecord.sourceRow, after: nextRecord.sourceRow },
      });
    }
  }
  for (const [id, record] of after)
    if (!before.has(id))
      changes.push({ kind: "added", recordId: id, after: record.values });
  return changes;
}

type StoredGoogleSource = Dataset["source"] & {
  sourceColumns?: Record<string, string>;
  sourceHeaders?: Record<string, string>;
  connectedBy?: string;
  readOnly?: boolean;
  readOnlyReason?: string;
};
type DatasetWithPresentation = Dataset & {
  categoryColors?: Record<string, number>;
  lastCheckedAt?: string;
  lastSyncError?: string;
};

function applyEditableFields(
  existing: Field[],
  requested: Array<{
    key: string;
    label: string;
    required?: boolean;
    options?: string[];
  }>,
): Field[] {
  if (requested.length !== existing.length)
    throw new HttpError(
      400,
      "INVALID_SETTINGS",
      "Columns cannot be added, removed, renamed, or reordered here.",
    );
  const byKey = new Map(requested.map((field) => [field.key, field]));
  return existing.map((field) => {
    const next = byKey.get(field.key);
    if (!next || next.label !== field.label)
      throw new HttpError(
        400,
        "INVALID_SETTINGS",
        "Columns cannot be added, removed, renamed, or reordered here.",
      );
    if (next.options && field.type !== "select")
      throw new HttpError(
        400,
        "INVALID_SETTINGS",
        "Only select columns may define options.",
      );
    return {
      ...field,
      ...(next.required ? { required: true } : {}),
      ...(next.required === false ? { required: undefined } : {}),
      ...(next.options === undefined ? {} : { options: next.options }),
    };
  });
}

function normalizeCategoryColors(
  colors: Record<string, number>,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [label, color] of Object.entries(colors)) {
    const key = labelKey(label);
    if (!key)
      throw new HttpError(
        400,
        "INVALID_SETTINGS",
        "Category color labels cannot be empty.",
      );
    if (normalized[key] !== undefined && normalized[key] !== color) {
      throw new HttpError(
        400,
        "INVALID_SETTINGS",
        "Two category colors normalize to the same category.",
      );
    }
    normalized[key] = color;
  }
  return normalized;
}

/**
 * Core patches retain normalized ISO date values. Google date cells additionally
 * retain their confirmed raw serial/text value, so the next preimage check does
 * not compare a rendered date against a typed Sheets value.
 */
function applyGoogleSourceValues(
  mutation: { dataset: Dataset; record: WorkRecord; entry: ChangeEntry },
  write: GoogleWriteResult | undefined,
): { dataset: Dataset; record: WorkRecord; entry: ChangeEntry } {
  if (!write?.sourceValues && !write?.recordSource) return mutation;
  const record = {
    ...mutation.record,
    sourceValues: { ...mutation.record.sourceValues, ...write.sourceValues },
    ...write.recordSource,
  };
  const records = mutation.dataset.records.map((item) =>
    item.id === record.id ? record : item,
  );
  return {
    ...mutation,
    record,
    dataset: validateDataset({ ...mutation.dataset, records }),
  };
}

function googleSelectionFromDataset(dataset: Dataset) {
  const source = dataset.source as StoredGoogleSource;
  if (
    source.kind !== "google" ||
    !source.spreadsheetId ||
    !source.sheetName ||
    source.sheetId === undefined ||
    !source.headerRow ||
    !source.startColumn ||
    !source.endColumn ||
    !source.endRow
  ) {
    throw new HttpError(
      409,
      "GOOGLE_REFRESH_UNSAFE",
      "This Google dataset lacks its original bounded source selection.",
    );
  }
  return {
    spreadsheetId: source.spreadsheetId,
    sheetId: source.sheetId,
    headerRow: source.headerRow,
    startColumn: source.startColumn,
    endColumn: source.endColumn,
    endRow: source.endRow,
    mapping: dataset.mapping,
    identityField: dataset.mapping.identity,
    identityStrategy: source.identityStrategy,
    developerMetadataKey: source.developerMetadataKey,
    developerMetadataConsent: source.developerMetadataConsent,
    name: dataset.name,
    locale: dataset.locale,
    timeZone: dataset.timeZone,
    dateOrder: dataset.dateOrder,
    weekStartsOn: dataset.weekStartsOn,
  };
}

function sameGoogleHeaderSchema(
  previous: StoredGoogleSource,
  incoming: StoredGoogleSource,
): boolean {
  const before = previous.sourceHeaders;
  const after = incoming.sourceHeaders;
  if (!before || !after) return false;
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  return (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every(
      (key, index) => key === afterKeys[index] && before[key] === after[key],
    )
  );
}

function valuesChanged(left: WorkRecord, right: WorkRecord): boolean {
  return Object.keys({ ...left.values, ...right.values }).some(
    (key) => !cellEqual(left.values[key], right.values[key]),
  );
}

function hasUniqueRecordIdentity(dataset: Dataset): boolean {
  if (dataset.source.identityStrategy === "developer-metadata") {
    const values = dataset.records.map((record) => record.sourceIdentity);
    return values.every(Boolean) && new Set(values).size === values.length;
  }
  const identity = dataset.mapping.identity;
  if (!identity) return false;
  const values = dataset.records.map((record) => record.values[identity]);
  return (
    values.every(
      (value) => value !== null && value !== undefined && value !== "",
    ) && new Set(values.map(String)).size === values.length
  );
}

/** Merge only after complete unique identity indexes have been built. */
function mergeGoogleRefresh(
  existing: Dataset,
  incoming: Dataset,
): { dataset: Dataset; added: number; updated: number; removed: number } {
  const identity = existing.mapping.identity;
  if (!identity && existing.source.identityStrategy !== "developer-metadata")
    throw new HttpError(
      409,
      "GOOGLE_REFRESH_UNSAFE",
      "Google refresh needs a stable existing identity column.",
    );
  const index = (records: WorkRecord[], label: string) => {
    const result = new Map<string, WorkRecord>();
    for (const record of records) {
      const value =
        existing.source.identityStrategy === "developer-metadata"
          ? record.sourceIdentity
          : record.values[identity!];
      if (value === null || value === undefined || value === "")
        throw new HttpError(
          409,
          "GOOGLE_REFRESH_CONFLICT",
          `${label} has an empty identity value; no rows were changed.`,
        );
      const key = String(value);
      if (result.has(key))
        throw new HttpError(
          409,
          "GOOGLE_REFRESH_CONFLICT",
          `${label} has duplicate identity value "${key}"; no rows were changed.`,
        );
      result.set(key, record);
    }
    return result;
  };
  const current = index(existing.records, "Stored dataset");
  const remote = index(incoming.records, "Google Sheets");
  let added = 0;
  let updated = 0;
  const records: WorkRecord[] = [];
  for (const [key, next] of remote) {
    const previous = current.get(key);
    if (!previous) {
      added += 1;
      records.push(next);
      continue;
    }
    const changed =
      valuesChanged(previous, next) ||
      previous.sourceRow !== next.sourceRow ||
      JSON.stringify(previous.lockedFields ?? []) !==
        JSON.stringify(next.lockedFields ?? []);
    if (changed) updated += 1;
    records.push({
      ...next,
      id: previous.id,
      revision: previous.revision + (changed ? 1 : 0),
    });
  }
  const removed = [...current.keys()].filter((key) => !remote.has(key)).length;
  const changed = added + updated + removed > 0;
  return {
    dataset: changed
      ? validateDataset({
          ...existing,
          records,
          revision: existing.revision + 1,
          updatedAt: new Date().toISOString(),
        })
      : existing,
    added,
    updated,
    removed,
  };
}

async function recordGoogleRefreshFailure(
  db: SqlClient,
  workspaceId: string,
  datasetId: string,
  error: unknown,
): Promise<void> {
  try {
    const found = await db.query<DatasetRow>(
      "SELECT id, workspace_id, snapshot, revision, source_kind, source_upload_id, updated_at FROM datasets WHERE id = $1 AND workspace_id = $2",
      [datasetId, workspaceId],
    );
    const row = found.rows[0];
    if (!row) return;
    const dataset = rowDataset(row) as DatasetWithPresentation;
    if (dataset.source.kind !== "google") return;
    const code =
      error instanceof HttpError ? error.code : "GOOGLE_REFRESH_FAILED";
    // Preserve the last good records and updatedAt. This telemetry is separate
    // from content revision so a revoked token never looks like a source edit.
    await db.query(
      "UPDATE datasets SET snapshot = $1 WHERE id = $2 AND workspace_id = $3 AND revision = $4",
      [
        asJson({
          ...dataset,
          lastCheckedAt: new Date().toISOString(),
          lastSyncError: code,
        }),
        row.id,
        workspaceId,
        row.revision,
      ],
    );
  } catch {
    // Do not replace the original refresh failure with telemetry failure.
  }
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

class DatasetEvents {
  private readonly listeners = new Map<
    string,
    Set<(payload: unknown) => void>
  >();

  subscribe(
    datasetId: string,
    listener: (payload: unknown) => void,
  ): () => void {
    const set = this.listeners.get(datasetId) ?? new Set();
    set.add(listener);
    this.listeners.set(datasetId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(datasetId);
    };
  }

  emit(datasetId: string, payload: unknown): void {
    for (const listener of this.listeners.get(datasetId) ?? [])
      listener(payload);
  }
}

/**
 * Constructs the HTTP service without connecting to a database. Startup owns
 * migrations and passes a pg Pool once ready; no in-memory data fallback is
 * ever used for authenticated or workspace data.
 */
export function createServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_000_000,
  });
  const db = options.db;
  const events = new DatasetEvents();
  const authConfig: AuthConfiguration = {
    ...options.authConfig,
    ...(options.trustedOrigins
      ? { trustedOrigins: options.trustedOrigins }
      : {}),
  };
  const auth =
    options.auth ??
    (db
      ? createBetterAuth(db, {
          ...authConfig,
          beforeUserDelete: (user) =>
            prepareAccountErasure(db, user.id, (id, payload) =>
              events.emit(id, payload),
            ),
        })
      : undefined);
  const origins = new Set(trustedOriginsFor(authConfig));
  const googleCredentials =
    options.google?.credentials ??
    (db &&
    (options.google?.config ||
      (!options.google?.connector && !options.google?.reader))
      ? new PostgresGoogleCredentials(db, options.google?.config)
      : undefined);
  const googleConnector =
    options.google?.connector ??
    (googleCredentials
      ? new GoogleSheetsConnector(googleCredentials)
      : undefined);
  const googleReader =
    options.google?.reader ??
    (googleCredentials ? new GoogleSheetsReader(googleCredentials) : undefined);

  /**
   * Resolves (and, if needed, persists) OAuth state before a caller takes a
   * transaction client. The returned reader/connector are new, per-operation
   * instances backed only by that in-memory token; no shared connector is
   * mutated. The fallback preserves the existing narrow test seams that pass
   * structural fake clients instead of GoogleSheetsReader/Connector instances.
   */
  async function prepareGoogleClient(
    actorId: string,
  ): Promise<PreparedGoogleClient> {
    // Structural clients are an explicit test seam. Production has a
    // credential store whenever a Google client exists.
    if (!googleCredentials)
      return { actorId, reader: googleReader, connector: googleConnector };
    if (
      (googleReader && !(googleReader instanceof GoogleSheetsReader)) ||
      (googleConnector && !(googleConnector instanceof GoogleSheetsConnector))
    )
      throw setupNeeded(
        "Google clients must support operation-local credentials when OAuth storage is configured.",
      );
    const credentials = new PreparedGoogleCredentials(
      actorId,
      await googleCredentials.accessToken(actorId),
    );
    return {
      actorId,
      reader:
        googleReader instanceof GoogleSheetsReader
          ? googleReader.withCredentials(credentials)
          : googleReader,
      connector:
        googleConnector instanceof GoogleSheetsConnector
          ? googleConnector.withCredentials(credentials)
          : googleConnector,
    };
  }

  function requirePreparedGoogleClient(
    prepared: unknown,
    actorId: string,
  ): PreparedGoogleClient {
    const client = prepared as PreparedGoogleClient | undefined;
    if (!client || client.actorId !== actorId)
      throw new HttpError(
        409,
        "GOOGLE_CREDENTIAL_IDENTITY_CHANGED",
        "The prepared Google credential no longer matches this workspace member.",
      );
    return client;
  }
  const xlsx: XlsxService = options.xlsx ?? {
    inspect: async (bytes) => inspectWorkbook(bytes),
    import: async (bytes, settings) => importWorkbook(bytes, settings),
    export: async (original, dataset) => exportWorkbook(original, dataset),
    reimport: async (existing, bytes, settings) =>
      reimportWorkbook(existing, bytes, settings),
  };

  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_UPLOAD_BYTES,
      fields: 20,
      fieldNameSize: 100,
    },
    throwFileSizeLimit: true,
  });

  // Same-origin production serving is intentionally restrictive while still
  // allowing Google Picker's documented scripts, frames, and OAuth requests.
  // API responses receive the same headers as the static workbench shell.
  app.addHook("onSend", async (request, reply) => {
    // API payloads may contain workspace records, session data, or signed
    // downloads. Never allow a browser/proxy to cache them as static content.
    if (request.url.startsWith("/api/"))
      reply.header("cache-control", "no-store");
    reply.header(
      "content-security-policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' https://apis.google.com https://accounts.google.com https://www.gstatic.com",
        "style-src 'self' 'unsafe-inline' https://accounts.google.com https://www.gstatic.com",
        "font-src 'self' data:",
        "img-src 'self' data: blob: https://*.googleusercontent.com https://www.gstatic.com",
        "connect-src 'self' https://accounts.google.com https://apis.google.com https://www.googleapis.com https://content.googleapis.com",
        "frame-src https://accounts.google.com https://apis.google.com https://drive.google.com https://docs.google.com https://*.googleusercontent.com",
        "worker-src 'self' blob:",
      ].join("; "),
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header(
      "permissions-policy",
      "camera=(), geolocation=(), microphone=()",
    );
    reply.header("x-dns-prefetch-control", "off");
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError)
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        details: error.details,
      });
    if (error instanceof DomainError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "CONFLICT"
            ? 409
            : error.code === "FORBIDDEN"
              ? 403
              : 400;
      return reply.status(status).send({
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
    if (error instanceof XlsxSafetyError)
      return reply
        .status(422)
        .send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        code: "INVALID_REQUEST",
        message: "Request body is invalid.",
        details: error.flatten(),
      });
    const pgCode = (error as { code?: string }).code;
    if (pgCode === "23505")
      return reply.status(409).send({
        code: "CONFLICT",
        message: "The request conflicts with existing data.",
      });
    app.log.error(error);
    return reply
      .status(500)
      .send({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
  });

  // Browsers attach Origin to cross-site state changes. A missing Origin is
  // accepted only for a non-cookie request (CLI and Fastify injection); cookie
  // authenticated requests without a same-origin header fail closed.
  app.addHook("onRequest", async (request) => {
    if (
      !request.url.startsWith("/api/") ||
      request.url.startsWith("/api/auth/") ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
    )
      return;
    const origin = request.headers.origin;
    const hasCookie = Boolean(request.headers.cookie);
    if ((origin && !origins.has(origin)) || (!origin && hasCookie)) {
      throw new HttpError(
        403,
        "CSRF_ORIGIN_REJECTED",
        "Cross-origin state changes are not allowed.",
      );
    }
  });

  app.get("/api/config", async () => ({
    teamMode: Boolean(db && (auth || options.sessionResolver)),
    googleEnabled: Boolean(googleCredentials?.enabled()),
    passwordResetEnabled: passwordResetEnabled(authConfig),
    storageLabel:
      options.storageLabel ??
      (db
        ? auth || options.sessionResolver
          ? "Workspace database"
          : "Database configured; authentication setup required"
        : "Browser-only demo mode"),
  }));

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/api/auth/*",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    handler: async (request, reply) => {
      if (!auth)
        throw setupNeeded(
          db
            ? "Authentication is not configured. Set BETTER_AUTH_SECRET."
            : "Authentication requires a configured database.",
        );
      const method = request.method;
      const requestBody =
        method === "GET" || method === "HEAD"
          ? undefined
          : request.body === undefined
            ? undefined
            : JSON.stringify(request.body);
      const host = request.headers.host ?? "localhost:3001";
      const protocol = request.protocol || "http";
      const response = await auth.handler(
        new Request(`${protocol}://${host}${request.raw.url}`, {
          method,
          headers: headersFromRequest(request),
          body: requestBody,
        }),
      );
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      const setCookie =
        response.headers.getSetCookie?.() ??
        (response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")!]
          : []);
      if (setCookie.length) reply.header("set-cookie", setCookie);
      reply
        .status(response.status)
        .send(Buffer.from(await response.arrayBuffer()));
    },
  });

  async function requireDb(): Promise<SqlClient> {
    if (!db) throw unavailable();
    return db;
  }

  async function currentUser(request: FastifyRequest): Promise<SessionUser> {
    await requireDb();
    const user = options.sessionResolver
      ? await options.sessionResolver(request)
      : auth
        ? await sessionFromAuth(auth, headersFromRequest(request))
        : null;
    if (user) return user;
    if (!options.sessionResolver && !auth)
      throw setupNeeded(
        "Authentication is not configured. Set BETTER_AUTH_SECRET.",
      );
    throw unauthorized();
  }

  async function workspaceAccess(
    request: FastifyRequest,
    workspaceId: string,
    write = false,
    ownerOnly = false,
  ): Promise<WorkspaceAccess> {
    const sql = await requireDb();
    const user = await currentUser(request);
    const result = await sql.query<{ role: Role }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, user.id],
    );
    const role = result.rows[0]?.role;
    if (
      !role ||
      (write && role === "viewer") ||
      (ownerOnly && role !== "owner")
    )
      throw forbidden();
    return { user, role };
  }

  async function loadDataset(
    sql: SqlClient,
    workspaceId: string,
    datasetId: string,
    lock = false,
  ): Promise<{ row: DatasetRow; dataset: Dataset }> {
    const result = await sql.query<DatasetRow>(
      `SELECT id, workspace_id, snapshot, revision, source_kind, source_upload_id, updated_at FROM datasets WHERE id = $1 AND workspace_id = $2${lock ? " FOR UPDATE" : ""}`,
      [datasetId, workspaceId],
    );
    const row = result.rows[0];
    if (!row)
      throw new HttpError(404, "DATASET_NOT_FOUND", "Dataset was not found.");
    return { row, dataset: rowDataset(row) };
  }

  async function priorOperation(
    sql: SqlClient,
    datasetId: string,
    operation: string,
    actorId: string,
  ): Promise<
    | { record: WorkRecord; entry: ChangeEntry; datasetRevision: number }
    | undefined
  > {
    const result = await sql.query<ChangeRow>(
      "SELECT id, operation_id, actor_id, entry, record, dataset_revision FROM dataset_changes WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operation],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.actor_id !== actorId)
      throw conflict("This operation ID belongs to another workspace member.");
    return {
      record: parseJson<WorkRecord>(row.record),
      entry: parseJson<ChangeEntry>(row.entry),
      datasetRevision: Number(row.dataset_revision),
    };
  }

  async function priorDatasetOperation<T>(
    sql: SqlClient,
    datasetId: string,
    operation: string,
    actorId: string,
  ): Promise<T | undefined> {
    const result = await sql.query<DatasetOperationRow>(
      "SELECT actor_id, result FROM dataset_operations WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operation],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.actor_id !== actorId)
      throw conflict("This operation ID belongs to another workspace member.");
    return parseJson<T>(row.result);
  }

  async function persistMutation(
    sql: SqlClient,
    row: DatasetRow,
    beforeRevision: number,
    result: { dataset: Dataset; record: WorkRecord; entry: ChangeEntry },
    actorId: string,
  ): Promise<{
    record: WorkRecord;
    entry: ChangeEntry;
    datasetRevision: number;
  }> {
    const updated = await sql.query(
      "UPDATE datasets SET snapshot = $1, revision = $2, updated_at = NOW() WHERE id = $3 AND revision = $4",
      [asJson(result.dataset), result.dataset.revision, row.id, beforeRevision],
    );
    if (updated.rowCount !== 1)
      throw conflict(
        "The dataset changed while this operation was being applied. Reload and retry.",
      );
    await sql.query(
      `INSERT INTO dataset_changes (id, dataset_id, operation_id, actor_id, entry, record, dataset_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        result.entry.id,
        row.id,
        result.entry.operationId,
        actorId,
        asJson(result.entry),
        asJson(result.record),
        result.dataset.revision,
      ],
    );
    return {
      record: result.record,
      entry: result.entry,
      datasetRevision: result.dataset.revision,
    };
  }

  async function createSourceOperation(
    sql: SqlClient,
    datasetId: string,
    operation: string,
    actorId: string,
  ): Promise<void> {
    await sql.query(
      `INSERT INTO source_operations (id, dataset_id, operation_id, actor_id, status)
       VALUES ($1, $2, $3, $4, 'queued') ON CONFLICT (dataset_id, operation_id) DO NOTHING`,
      [randomUUID(), datasetId, operation, actorId],
    );
  }

  async function executeSourceJob(
    job: SourceJob,
    tx: SqlClient,
    prepared: unknown,
  ): Promise<unknown> {
    const google = requirePreparedGoogleClient(prepared, job.actor_id);
    if (!google.connector)
      throw setupNeeded("Google Sheets writeback is not configured.");
    const did = job.dataset_id,
      actor = job.actor_id;
    const repeated =
      job.kind === "patch"
        ? await priorOperation(tx, did, job.operation_id, actor)
        : await priorDatasetOperation(tx, did, job.operation_id, actor);
    if (repeated) return repeated;
    const { row, dataset } = await loadDataset(tx, job.workspace_id, did, true);
    if (dataset.source.kind !== "google" || dataset.source.readOnly)
      throw new HttpError(
        409,
        "GOOGLE_READ_ONLY",
        dataset.source.readOnlyReason ?? "This source is not writable.",
      );
    if (job.kind === "patch") {
      const patch = job.payload as RecordPatch;
      const mutation = applyRecordPatch(dataset, patch, actor);
      let write: GoogleWriteResult;
      if (job.attempts > 1) {
        const recovered = await google.connector.recoverPatch(
          dataset,
          patch,
          actor,
        );
        if (recovered.outcome === "applied" && !recovered.write)
          throw conflict(
            "The recovered source outcome has no verified values.",
          );
        write =
          recovered.outcome === "applied"
            ? recovered.write!
            : await google.connector.applyPatch(dataset, patch, actor);
      } else write = await google.connector.applyPatch(dataset, patch, actor);
      const result = await persistMutation(
        tx,
        row,
        dataset.revision,
        applyGoogleSourceValues(mutation, write),
        actor,
      );
      await tx.query(
        "UPDATE source_operations SET status='succeeded',preimage=$3,postwrite=$4,completed_at=NOW() WHERE dataset_id=$1 AND operation_id=$2",
        [
          did,
          job.operation_id,
          asJson(write.preimage),
          asJson(write.postwrite),
        ],
      );
      return result;
    }
    const payload = job.payload as {
      values: Record<string, CellValue>;
      appendConsent: true;
      developerMetadataConsent: true;
    };
    const record = createRecord(
      dataset,
      payload.values,
      `google-op-${sha256(job.operation_id).slice(0, 32)}`,
    );
    const created = await google.connector.createRow(
      dataset,
      {
        operationId: job.operation_id,
        record,
        appendConsent: payload.appendConsent,
        developerMetadataConsent: payload.developerMetadataConsent,
      },
      actor,
    );
    const next = validateDataset({
      ...dataset,
      source: created.source,
      records: [...dataset.records, created.record],
      revision: dataset.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await tx.query(
      "UPDATE datasets SET snapshot=$1,revision=$2,updated_at=NOW() WHERE id=$3",
      [asJson(next), next.revision, did],
    );
    const result = { record: created.record, datasetRevision: next.revision };
    await tx.query(
      "INSERT INTO dataset_operations (dataset_id,operation_id,actor_id,result) VALUES ($1,$2,$3,$4)",
      [did, job.operation_id, actor, asJson(result)],
    );
    return result;
  }
  const sourceQueue = db
    ? new SourceQueue(db, {
        prepare: async (job) => prepareGoogleClient(job.actor_id),
        execute: executeSourceJob,
        failed: async (job, error, retry) => {
          const code =
            error instanceof HttpError ? error.code : "SOURCE_FAILURE";
          const message =
            error instanceof HttpError
              ? error.message
              : "Source request needs review.";
          await db.query(
            "UPDATE source_operations SET status=$3,error_code=$4,error_message=$5,completed_at=CASE WHEN $3='queued' THEN NULL ELSE NOW() END WHERE dataset_id=$1 AND operation_id=$2",
            [
              job.dataset_id,
              job.operation_id,
              retry
                ? "queued"
                : error instanceof HttpError && error.statusCode === 409
                  ? "conflicted"
                  : "failed",
              code,
              message,
            ],
          );
        },
        committed: (job, value) => {
          const result = value as { datasetRevision: number };
          events.emit(job.dataset_id, {
            type: "revision",
            revision: result.datasetRevision,
          });
        },
      })
    : undefined;
  app.decorate("sourceQueue", sourceQueue);
  if (sourceQueue) {
    if (options.sourceWorker ?? !options.sessionResolver)
      app.addHook("onReady", async () => {
        sourceQueue.start();
      });
    app.addHook("onClose", async () => {
      await sourceQueue.stop();
    });
  }
  async function submitSourceJob(
    input: Parameters<SourceQueue["enqueue"]>[0],
  ): Promise<unknown> {
    if (!sourceQueue) throw unavailable();
    const job = await sourceQueue.enqueue(input);
    return sourceJobResult(await sourceQueue.run(job.id));
  }

  app.get("/api/workspaces/:wid/datasets/:did/source-jobs", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    const access = await workspaceAccess(request, wid);
    await loadDataset(sql, wid, did);
    return (
      await sql.query(
        'SELECT operation_id AS "operationId",kind,status,attempts,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",actor_id=$2 AS "canRetry" FROM source_jobs WHERE dataset_id=$1 ORDER BY sequence DESC LIMIT 50',
        [did, access.user.id],
      )
    ).rows;
  });

  app.post(
    "/api/workspaces/:wid/datasets/:did/source-jobs/retry",
    async (request) => {
      const sql = await requireDb();
      const { wid, did } = params(request);
      const access = await workspaceAccess(request, wid, true);
      await loadDataset(sql, wid, did);
      const body = jsonBody(request, z.object({ operationId }).strict());
      const job = await sql.query<{ id: string; actor_id: string }>(
        "SELECT id,actor_id FROM source_jobs WHERE dataset_id=$1 AND operation_id=$2",
        [did, body.operationId],
      );
      if (!job.rows[0] || job.rows[0].actor_id !== access.user.id)
        throw forbidden("Only the requesting editor can retry this save.");
      return sourceJobResult(
        await sourceQueue?.retry(job.rows[0].id, access.user.id),
      );
    },
  );

  app.get(
    "/api/workspaces/:wid/datasets/:did/google/identity-preview",
    async (request) => {
      const sql = await requireDb();
      const { wid, did } = params(request);
      const access = await workspaceAccess(request, wid, true);
      if (!googleReader) throw setupNeeded("Google Sheets is not configured.");
      const { dataset } = await loadDataset(sql, wid, did);
      return prepareGoogleIdentityPreview(
        dataset,
        googleReader,
        access.user.id,
      );
    },
  );

  app.post(
    "/api/workspaces/:wid/datasets/:did/google/identity",
    async (request) => {
      const sql = await requireDb();
      const { wid, did } = params(request);
      const access = await workspaceAccess(request, wid, true);
      const body = jsonBody(
        request,
        z
          .object({
            operationId,
            consent: z.literal(true),
            previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      );
      if (!googleConnector || !googleReader)
        throw setupNeeded("Google Sheets is not configured.");
      // Token lookup/refresh (and its durable rotation) must complete before
      // the dataset transaction takes a Pool client.
      const google = await prepareGoogleClient(access.user.id);
      if (!google.reader || !google.connector)
        throw setupNeeded("Google Sheets is not configured.");
      const preparedConnector = google.connector;
      const observed = await loadDataset(sql, wid, did);
      const preview = await prepareGoogleIdentityPreview(
        observed.dataset,
        google.reader,
        access.user.id,
      );
      assertGoogleIdentityPreviewFingerprint(
        body.previewFingerprint,
        preview.fingerprint,
      );
      const result = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const { dataset } = await loadDataset(tx, wid, did, true);
        if (dataset.revision !== observed.dataset.revision)
          throw conflict(
            "The dataset changed while Google row identity was being verified.",
          );
        const pending = await tx.query(
          "SELECT id FROM source_jobs WHERE dataset_id=$1 AND status IN ('queued','running') LIMIT 1",
          [did],
        );
        if (pending.rows.length)
          throw conflict(
            "Wait for pending source saves before changing row identity.",
          );
        // The bound connector can only return the actor token prepared above;
        // it cannot perform another pool lookup while this transaction is open.
        const enabled = await preparedConnector.enableMetadataIdentity(
          preview.dataset,
          body,
          access.user.id,
        );
        const next = validateDataset({
          ...preview.dataset,
          source: enabled.source,
          records: enabled.records,
          revision: dataset.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        await tx.query(
          "UPDATE datasets SET snapshot=$1,revision=$2,updated_at=NOW() WHERE id=$3",
          [asJson(next), next.revision, did],
        );
        return next;
      });
      events.emit(did, { type: "revision", revision: result.revision });
      return result;
    },
  );

  app.get("/api/workspaces/:wid/datasets/:did/versions", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    await workspaceAccess(request, wid);
    await loadDataset(sql, wid, did);
    return (
      await sql.query(
        'SELECT revision,created_at AS "createdAt",jsonb_array_length(COALESCE(snapshot->\'records\',\'[]\'::jsonb)) AS "recordCount",source_upload_id IS NOT NULL AS "canExportXlsx" FROM dataset_versions WHERE dataset_id=$1 ORDER BY revision DESC LIMIT 100',
        [did],
      )
    ).rows;
  });
  app.get(
    "/api/workspaces/:wid/datasets/:did/versions/:revision",
    async (request, reply) => {
      const sql = await requireDb();
      const { wid, did, revision } = params(request);
      await workspaceAccess(request, wid);
      await loadDataset(sql, wid, did);
      if (!/^\d+$/.test(revision!))
        throw new HttpError(400, "INVALID_REVISION", "Invalid revision.");
      const versions = await sql.query<{
        snapshot: unknown;
        source_upload_id?: string;
      }>(
        "SELECT snapshot,source_upload_id FROM dataset_versions WHERE dataset_id=$1 AND revision=$2",
        [did, Number(revision)],
      );
      const version = versions.rows[0];
      if (!version)
        throw new HttpError(404, "VERSION_NOT_FOUND", "Version was not found.");
      const snapshot = parseJson<Dataset>(version.snapshot);
      if ((request.query as { format?: string }).format !== "xlsx")
        return snapshot;
      if (snapshot.source.kind !== "xlsx" || !version.source_upload_id)
        throw new HttpError(
          409,
          "VERSION_XLSX_UNAVAILABLE",
          "This version has no original XLSX file.",
        );
      const upload = await sql.query<{ content: Uint8Array }>(
        "SELECT content FROM uploads WHERE id=$1 AND workspace_id=$2",
        [version.source_upload_id, wid],
      );
      if (!upload.rows[0])
        throw new HttpError(
          404,
          "SOURCE_NOT_FOUND",
          "Original workbook was not found.",
        );
      const bytes = await xlsx.export(
        new Uint8Array(upload.rows[0].content),
        snapshot,
      );
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="workbook-revision-${Number(revision)}.xlsx"`,
        )
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .send(Buffer.from(bytes));
    },
  );

  async function finishSourceOperation(
    datasetId: string,
    operation: string,
    status: "succeeded" | "conflicted" | "failed",
    data?: { preimage?: unknown; postwrite?: unknown; error?: unknown },
  ): Promise<void> {
    if (!db) return;
    const error = data?.error as
      { code?: unknown; message?: unknown } | undefined;
    await db.query(
      `UPDATE source_operations
       SET status = $3, preimage = COALESCE($4::jsonb, preimage), postwrite = COALESCE($5::jsonb, postwrite),
           error_code = $6, error_message = $7, completed_at = NOW()
       WHERE dataset_id = $1 AND operation_id = $2`,
      [
        datasetId,
        operation,
        status,
        data?.preimage === undefined ? null : asJson(data.preimage),
        data?.postwrite === undefined ? null : asJson(data.postwrite),
        typeof error?.code === "string" ? error.code : null,
        typeof error?.message === "string" ? error.message : null,
      ],
    );
  }

  app.get("/api/workspaces", async (request) => {
    const sql = await requireDb();
    const user = await currentUser(request);
    const result = await sql.query<{ id: string; name: string; role: Role }>(
      `SELECT w.id, w.name, m.role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at ASC`,
      [user.id],
    );
    return result.rows;
  });

  app.post(
    "/api/workspaces",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const sql = await requireDb();
      const user = await currentUser(request);
      const body = jsonBody(
        request,
        z.object({ name: z.string().trim().min(1).max(120) }).strict(),
      );
      const id = randomUUID();
      await withActorTransaction(sql, user.id, async (tx) => {
        await tx.query(
          "INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)",
          [id, body.name, user.id],
        );
        await tx.query(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
          [id, user.id],
        );
      });
      return { id, name: body.name, role: "owner" as const };
    },
  );

  app.get("/api/workspaces/:wid/invitations", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    await workspaceAccess(request, wid, false, true);
    const result = await sql.query<{
      id: string;
      email: string;
      role: Role;
      expires_at: string;
      accepted_at: string | null;
      created_at: string;
    }>(
      "SELECT id, email, role, expires_at, accepted_at, created_at FROM invitations WHERE workspace_id = $1 ORDER BY created_at DESC",
      [wid],
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
    }));
  });

  app.post("/api/workspaces/:wid/invitations", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    const access = await workspaceAccess(request, wid, true, true);
    const body = jsonBody(
      request,
      z
        .object({ email: z.string().trim().email().max(320), role: roleSchema })
        .strict(),
    );
    const invitationToken = newInvitationToken();
    const id = randomUUID();
    const email = body.email.toLowerCase();
    await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id, true, true);
      await tx.query(
        `INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '${INVITATION_TTL_DAYS} days')`,
        [id, wid, email, body.role, sha256(invitationToken), access.user.id],
      );
    });
    // Sending email is intentionally not part of this server. The caller may
    // display/copy this one-time token; only its hash is persisted.
    return {
      id,
      email,
      role: body.role,
      token: invitationToken,
      expiresInDays: INVITATION_TTL_DAYS,
    };
  });

  app.post("/api/invitations/:token/accept", async (request) => {
    const sql = await requireDb();
    const user = await currentUser(request);
    if (!user.emailVerified)
      throw new HttpError(
        403,
        "EMAIL_NOT_VERIFIED",
        "Verify the signed-in email before accepting an invitation.",
      );
    const invitationToken = z
      .string()
      .min(20)
      .max(200)
      .parse(params(request).token);
    const tokenHash = sha256(invitationToken);
    // A read-only hint establishes the workspace lock order. The locked row
    // below is rechecked, so a token cannot be rebound between these queries.
    const hint = await sql.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM invitations WHERE token_hash = $1",
      [tokenHash],
    );
    const workspaceId = hint.rows[0]?.workspace_id;
    if (!workspaceId)
      throw new HttpError(404, "INVITATION_NOT_FOUND", "Invitation is invalid or expired.");
    return withActorTransaction(sql, user.id, async (tx) => {
      const workspace = await tx.query(
        "SELECT id FROM workspaces WHERE id = $1 FOR SHARE",
        [workspaceId],
      );
      if (!workspace.rows[0])
        throw new HttpError(404, "INVITATION_NOT_FOUND", "Invitation is invalid or expired.");
      const found = await tx.query<{
        id: string;
        workspace_id: string;
        email: string;
        role: Role;
        expires_at: string | Date;
        accepted_at: string | Date | null;
        accepted_by: string | null;
      }>(
        "SELECT id, workspace_id, email, role, expires_at, accepted_at, accepted_by FROM invitations WHERE token_hash = $1 FOR UPDATE",
        [tokenHash],
      );
      const invitation = found.rows[0];
      if (!invitation || new Date(invitation.expires_at).getTime() < Date.now())
        throw new HttpError(
          404,
          "INVITATION_NOT_FOUND",
          "Invitation is invalid or expired.",
        );
      if (invitation.workspace_id !== workspaceId)
        throw new HttpError(404, "INVITATION_NOT_FOUND", "Invitation is invalid or expired.");
      if (invitation.email.toLowerCase() !== user.email.toLowerCase())
        throw forbidden(
          "This invitation is bound to a different verified email.",
        );
      if (invitation.accepted_at) {
        if (invitation.accepted_by !== user.id)
          throw conflict("This invitation was already accepted.");
        return {
          workspaceId: invitation.workspace_id,
          role: invitation.role,
          accepted: true,
        };
      }
      await tx.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING",
        [invitation.workspace_id, user.id, invitation.role],
      );
      await tx.query(
        "UPDATE invitations SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1 AND accepted_at IS NULL",
        [invitation.id, user.id],
      );
      return {
        workspaceId: invitation.workspace_id,
        role: invitation.role,
        accepted: true,
      };
    });
  });

  app.get("/api/workspaces/:wid/datasets", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    await workspaceAccess(request, wid);
    const result = await sql.query<DatasetRow>(
      "SELECT id, workspace_id, snapshot, revision, source_kind, source_upload_id, updated_at FROM datasets WHERE workspace_id = $1 ORDER BY updated_at DESC",
      [wid],
    );
    return result.rows.map((row) => datasetSummary(rowDataset(row)));
  });

  app.post("/api/workspaces/:wid/datasets", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const body = jsonBody(
      request,
      z
        .object({
          name: z.string().trim().min(1).max(120),
          fields: z.array(fieldSchema).min(1).max(100).optional(),
          mapping: mappingSchema.optional(),
          locale: z.enum(["en", "ko"]).optional(),
          timeZone: z.string().min(1).max(100).optional(),
          dateOrder: z.enum(["ymd", "dmy", "mdy"]).optional(),
          weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
          completedStatuses: z
            .array(z.string().min(1).max(120))
            .max(100)
            .optional(),
        })
        .strict(),
    );
    const fields = (body.fields ?? [
      { key: "title", label: "Title", type: "text", required: true },
    ]) as Field[];
    const mapping = (body.mapping ?? { title: fields[0]!.key }) as Mapping;
    if (!fields.some((field) => field.key === mapping.title))
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Mapping title must reference a field.",
      );
    const now = new Date().toISOString();
    const dataset: Dataset = validateDataset({
      id: randomUUID(),
      name: body.name,
      source: { kind: "xlsx", fileName: "Untitled workbook" },
      fields,
      mapping,
      records: [],
      revision: 0,
      locale: body.locale ?? "en",
      timeZone: body.timeZone ?? "UTC",
      dateOrder: body.dateOrder ?? "ymd",
      weekStartsOn: body.weekStartsOn ?? 1,
      updatedAt: now,
      completedStatuses: body.completedStatuses ?? [],
    });
    await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id);
      await tx.query(
        "INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          dataset.id,
          wid,
          asJson(dataset),
          dataset.revision,
          dataset.source.kind,
          access.user.id,
        ],
      );
    });
    return dataset;
  });

  app.get("/api/workspaces/:wid/datasets/:did", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    await workspaceAccess(request, wid);
    return (await loadDataset(sql, wid, did)).dataset;
  });

  app.post("/api/workspaces/:wid/datasets/:did/patch", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const patch = jsonBody(request, patchSchema) as RecordPatch;

    // A Google source has a durable operation record even when remote checks
    // fail. This is an audit/repair trail, never a successful local mutation.
    const sourceLookup = await loadDataset(sql, wid, did);
    const googleSource = sourceLookup.dataset.source.kind === "google";
    if (googleSource) {
      const queued = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const current = await loadDataset(tx, wid, did, true);
        if (current.dataset.source.kind !== "google")
          throw conflict("The dataset source changed before this save was queued.");
        await createSourceOperation(tx, did, patch.operationId, access.user.id);
        const recorded = await tx.query(
          "SELECT id FROM source_jobs WHERE dataset_id=$1 AND operation_id=$2",
          [did, patch.operationId],
        );
        if (!recorded.rows.length) {
          const previous = await priorOperation(
            tx,
            did,
            patch.operationId,
            access.user.id,
          );
          if (previous) return { previous };
          applyRecordPatch(current.dataset, patch, access.user.id);
        }
        if (!sourceQueue) throw unavailable();
        return {
          job: await sourceQueue.enqueue(
            {
              workspace_id: wid,
              dataset_id: did,
              actor_id: access.user.id,
              operation_id: patch.operationId,
              kind: "patch",
              payload: patch,
            },
            tx,
          ),
        };
      });
      if ("previous" in queued) return queued.previous;
      return sourceJobResult(await sourceQueue?.run(queued.job.id));
    }

    let googleResult: GoogleWriteResult | undefined;
    try {
      const output = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const existing = await priorOperation(
          tx,
          did,
          patch.operationId,
          access.user.id,
        );
        if (existing) return existing;
        const { row, dataset } = await loadDataset(tx, wid, did, true);
        // Canonical validation and record-revision conflict detection must run
        // before touching Google. A rejected local patch must never become a
        // successful remote write with no matching local history entry.
        const mutation = applyRecordPatch(dataset, patch, access.user.id);
        if (dataset.source.kind === "google")
          throw conflict("Google source saves must run through the durable source queue.");
        return persistMutation(
          tx,
          row,
          dataset.revision,
          applyGoogleSourceValues(mutation, googleResult),
          access.user.id,
        );
      });
      if (googleSource)
        await finishSourceOperation(
          did,
          patch.operationId,
          "succeeded",
          googleResult,
        );
      events.emit(did, {
        type: "revision",
        revision: output.datasetRevision,
        entry: output.entry,
      });
      return output;
    } catch (error) {
      if (googleSource) {
        const code = error instanceof HttpError ? error.code : undefined;
        await finishSourceOperation(
          did,
          patch.operationId,
          code?.includes("CONFLICT") || code?.includes("UNSAFE")
            ? "conflicted"
            : "failed",
          { error },
        );
      }
      throw error;
    }
  });

  app.get("/api/workspaces/:wid/datasets/:did/history", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    await workspaceAccess(request, wid);
    await loadDataset(sql, wid, did);
    const result = await sql.query<ChangeRow>(
      "SELECT id, operation_id, actor_id, entry, record, dataset_revision FROM dataset_changes WHERE dataset_id = $1 ORDER BY dataset_revision ASC",
      [did],
    );
    return result.rows.map((row) => parseJson<ChangeEntry>(row.entry));
  });

  app.post("/api/workspaces/:wid/datasets/:did/undo", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    const access = await workspaceAccess(request, wid, true);
    // ChangeEntry.id is the originating operation ID, not necessarily a UUID
    // (the core also uses it for deterministic imported/source operations).
    const body = jsonBody(
      request,
      z.object({ entryId: operationId, operationId }).strict(),
    );
    const sourceLookup = await loadDataset(sql, wid, did);
    const googleSource = sourceLookup.dataset.source.kind === "google";
    if (googleSource) {
      const queued = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const current = await loadDataset(tx, wid, did, true);
        if (current.dataset.source.kind !== "google")
          throw conflict("The dataset source changed before this undo was queued.");
        await createSourceOperation(tx, did, body.operationId, access.user.id);
        const recorded = await tx.query(
          "SELECT id FROM source_jobs WHERE dataset_id=$1 AND operation_id=$2",
          [did, body.operationId],
        );
        if (!recorded.rows.length) {
          const previous = await priorOperation(
            tx,
            did,
            body.operationId,
            access.user.id,
          );
          if (previous) return { previous };
        }
        const history = await tx.query<{ entry: unknown }>(
          "SELECT entry FROM dataset_changes WHERE dataset_id=$1 AND operation_id=$2",
          [did, body.entryId],
        );
        if (!history.rows[0])
          throw new HttpError(404, "CHANGE_NOT_FOUND", "History entry was not found.");
        const entry = parseJson<ChangeEntry>(history.rows[0].entry);
        if (!recorded.rows.length)
          undoChange(current.dataset, entry, body.operationId, access.user.id);
        if (!sourceQueue) throw unavailable();
        return {
          job: await sourceQueue.enqueue(
            {
              workspace_id: wid,
              dataset_id: did,
              actor_id: access.user.id,
              operation_id: body.operationId,
              kind: "patch",
              payload: {
                operationId: body.operationId,
                recordId: entry.recordId,
                baseRevision: entry.revision,
                changes: entry.before,
                undoEntryId: body.entryId,
              },
            },
            tx,
          ),
        };
      });
      if ("previous" in queued) return queued.previous;
      return sourceJobResult(await sourceQueue?.run(queued.job.id));
    }
    let googleResult: GoogleWriteResult | undefined;
    try {
      const output = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const existing = await priorOperation(
          tx,
          did,
          body.operationId,
          access.user.id,
        );
        if (existing) return existing;
        const { row, dataset } = await loadDataset(tx, wid, did, true);
        // ChangeEntry.id is its operation ID. Archive restore assigns a new
        // database primary key to avoid cross-workspace collisions, so lookup
        // must use the per-dataset operation key rather than storage row ID.
        const history = await tx.query<{ entry: unknown }>(
          "SELECT entry FROM dataset_changes WHERE operation_id = $1 AND dataset_id = $2",
          [body.entryId, did],
        );
        const entry = history.rows[0]
          ? parseJson<ChangeEntry>(history.rows[0].entry)
          : undefined;
        if (!entry)
          throw new HttpError(
            404,
            "CHANGE_NOT_FOUND",
            "History entry was not found.",
          );
        // `undoChange` proves the target still has the exact revision and
        // values represented by this entry before any source write occurs.
        const mutation = undoChange(
          dataset,
          entry,
          body.operationId,
          access.user.id,
        );
        if (dataset.source.kind === "google")
          throw conflict("Google source saves must run through the durable source queue.");
        return persistMutation(
          tx,
          row,
          dataset.revision,
          applyGoogleSourceValues(mutation, googleResult),
          access.user.id,
        );
      });
      if (googleSource)
        await finishSourceOperation(
          did,
          body.operationId,
          "succeeded",
          googleResult,
        );
      events.emit(did, {
        type: "revision",
        revision: output.datasetRevision,
        entry: output.entry,
      });
      return output;
    } catch (error) {
      if (googleSource) {
        const code = error instanceof HttpError ? error.code : undefined;
        await finishSourceOperation(
          did,
          body.operationId,
          code?.includes("CONFLICT") || code?.includes("UNSAFE")
            ? "conflicted"
            : "failed",
          { error },
        );
      }
      throw error;
    }
  });

  app.post("/api/workspaces/:wid/datasets/:did/settings", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const body = jsonBody(
      request,
      z
        .object({
          baseRevision: z.number().int().nonnegative(),
          name: z.string().trim().min(1).max(160).optional(),
          locale: z.enum(["en", "ko"]).optional(),
          timeZone: z.string().min(1).max(100).optional(),
          weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
          completedStatuses: z
            .array(z.string().min(1).max(120))
            .max(100)
            .optional(),
          fields: z
            .array(
              z
                .object({
                  key: z.string().min(1).max(120),
                  label: z.string().min(1).max(120),
                  required: z.boolean().optional(),
                  options: z
                    .array(z.string().min(1).max(120))
                    .max(100)
                    .optional(),
                })
                .strict(),
            )
            .min(1)
            .max(100)
            .optional(),
          categoryColors: z
            .record(z.string().min(1).max(120), z.number().int().min(0).max(7))
            .optional(),
        })
        .strict()
        .refine(
          (value) => Object.keys(value).some((key) => key !== "baseRevision"),
          "Choose at least one setting to change.",
        ),
    );
    const output = await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id);
      const { row, dataset } = await loadDataset(tx, wid, did, true);
      if (dataset.revision !== body.baseRevision)
        throw conflict("Dataset settings changed. Reload before saving.", {
          currentRevision: dataset.revision,
        });
      const updated = validateDataset({
        ...dataset,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.locale === undefined ? {} : { locale: body.locale }),
        ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
        ...(body.weekStartsOn === undefined
          ? {}
          : { weekStartsOn: body.weekStartsOn }),
        ...(body.completedStatuses === undefined
          ? {}
          : { completedStatuses: body.completedStatuses }),
        ...(body.fields === undefined
          ? {}
          : { fields: applyEditableFields(dataset.fields, body.fields) }),
        ...(body.categoryColors === undefined
          ? {}
          : { categoryColors: normalizeCategoryColors(body.categoryColors) }),
        revision: dataset.revision + 1,
        updatedAt: new Date().toISOString(),
      } as DatasetWithPresentation);
      const saved = await tx.query(
        "UPDATE datasets SET snapshot = $1, revision = $2, updated_at = NOW() WHERE id = $3 AND revision = $4",
        [asJson(updated), updated.revision, row.id, dataset.revision],
      );
      if (saved.rowCount !== 1)
        throw conflict(
          "The dataset changed while settings were being applied.",
        );
      return updated;
    });
    events.emit(did, {
      type: "revision",
      revision: output.revision,
      settingChange: true,
    });
    return output;
  });

  app.post("/api/workspaces/:wid/datasets/:did/records", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const body = jsonBody(
      request,
      z
        .object({
          operationId,
          values: z.record(z.string().min(1).max(120), cellValue),
          appendConsent: z.literal(true).optional(),
          developerMetadataConsent: z.literal(true).optional(),
        })
        .strict(),
    );
    const sourceLookup = await loadDataset(sql, wid, did);
    if (sourceLookup.dataset.source.kind === "google") {
      if (!body.appendConsent || !body.developerMetadataConsent)
        throw new HttpError(
          400,
          "GOOGLE_APPEND_CONSENT_REQUIRED",
          "Confirm insertion of a new row and hidden operation marker in the connected Google source.",
        );
      const queued = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const current = await loadDataset(tx, wid, did, true);
        if (current.dataset.source.kind !== "google")
          throw conflict("The dataset source changed before this row was queued.");
        const recorded = await tx.query(
          "SELECT id FROM source_jobs WHERE dataset_id=$1 AND operation_id=$2",
          [did, body.operationId],
        );
        if (!recorded.rows.length) createRecord(current.dataset, body.values);
        if (!sourceQueue) throw unavailable();
        return sourceQueue.enqueue(
          {
            workspace_id: wid,
            dataset_id: did,
            actor_id: access.user.id,
            operation_id: body.operationId,
            kind: "create",
            payload: {
              values: body.values,
              appendConsent: true,
              developerMetadataConsent: true,
            },
          },
          tx,
        );
      });
      return sourceJobResult(await sourceQueue?.run(queued.id));
    }
    const output = await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id);
      const repeated = await priorDatasetOperation<{
        record: WorkRecord;
        datasetRevision: number;
      }>(tx, did, body.operationId, access.user.id);
      if (repeated) return repeated;
      const { row, dataset } = await loadDataset(tx, wid, did, true);
      if (dataset.source.kind === "google") {
        throw new HttpError(
          409,
          "GOOGLE_APPEND_UNSUPPORTED",
          "Google row append is disabled until a verified immutable identity strategy is configured.",
        );
      }
      if (dataset.source.kind !== "xlsx" || !row.source_upload_id) {
        throw new HttpError(
          409,
          "XLSX_APPEND_UNSUPPORTED",
          "This XLSX source cannot safely append a row yet. No local change was made.",
        );
      }
      const source = await tx.query<{ id: string }>(
        "SELECT id FROM uploads WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [row.source_upload_id, wid],
      );
      if (!source.rows[0])
        throw new HttpError(
          409,
          "XLSX_APPEND_UNSUPPORTED",
          "The original XLSX source workbook is unavailable.",
        );
      // The XLSX adapter owns the guarded XML append at export time. New rows
      // deliberately have no sourceRow; adapter validation rejects occupied,
      // merged, formula, or out-of-selection targets rather than guessing.
      const record = createRecord(dataset, body.values);
      const next = validateDataset({
        ...dataset,
        records: [...dataset.records, record],
        revision: dataset.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      const saved = await tx.query(
        "UPDATE datasets SET snapshot = $1, revision = $2, updated_at = NOW() WHERE id = $3 AND revision = $4",
        [asJson(next), next.revision, row.id, dataset.revision],
      );
      if (saved.rowCount !== 1)
        throw conflict("The dataset changed while adding a record.");
      const result = { record, datasetRevision: next.revision };
      await tx.query(
        "INSERT INTO dataset_operations (dataset_id, operation_id, actor_id, result) VALUES ($1, $2, $3, $4)",
        [did, body.operationId, access.user.id, asJson(result)],
      );
      return result;
    });
    events.emit(did, {
      type: "revision",
      revision: output.datasetRevision,
      record: output.record,
      created: true,
    });
    return output;
  });

  app.post(
    "/api/workspaces/:wid/datasets/:did/reimport/preview",
    async (request) => {
      const sql = await requireDb();
      const { wid, did } = params(request);
      const access = await workspaceAccess(request, wid, true);
      const body = jsonBody(
        request,
        z.object({ uploadId: z.string().uuid() }).strict(),
      );
      const { dataset } = await loadDataset(sql, wid, did);
      if (
        dataset.source.kind !== "xlsx" ||
        !dataset.source.sheetName ||
        !dataset.source.headerRow ||
        !dataset.source.startColumn ||
        !dataset.source.endColumn ||
        !dataset.source.endRow
      ) {
        throw new HttpError(
          409,
          "REIMPORT_UNAVAILABLE",
          "This dataset does not have a complete XLSX source selection.",
        );
      }
      const uploaded = await sql.query<{
        content: Uint8Array;
        file_name: string;
        storage_consent: boolean;
      }>(
        "SELECT content, file_name, storage_consent FROM uploads WHERE id = $1 AND workspace_id = $2",
        [body.uploadId, wid],
      );
      const upload = uploaded.rows[0];
      if (!upload || !upload.storage_consent)
        throw new HttpError(
          404,
          "UPLOAD_NOT_FOUND",
          "Uploaded workbook was not found with storage consent.",
        );
      const reimport = await xlsx.reimport(
        dataset,
        new Uint8Array(upload.content),
        {
          sheetName: dataset.source.sheetName,
          headerRow: dataset.source.headerRow,
          startColumn: dataset.source.startColumn,
          endColumn: dataset.source.endColumn,
          endRow: dataset.source.endRow,
          mapping: dataset.mapping,
          name: dataset.name,
          fileName: safeFileName(upload.file_name),
          dateOrder: dataset.dateOrder,
          locale: dataset.locale,
          timeZone: dataset.timeZone,
          weekStartsOn: dataset.weekStartsOn,
        },
      );
      const candidate = reimport.dataset
        ? prepareReimportCandidate(
            dataset,
            reimport.dataset,
            safeFileName(upload.file_name),
          )
        : undefined;
      const changes = candidate ? reimportDiff(dataset, candidate) : [];
      const previewId = randomUUID();
      await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const current = await loadDataset(tx, wid, did, true);
        if (current.dataset.revision !== dataset.revision)
          throw conflict("Dataset changed while re-import was being prepared.");
        await tx.query(
          `INSERT INTO reimport_previews (id, workspace_id, dataset_id, upload_id, user_id, base_revision, candidate, changes, conflicts, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL '30 minutes')`,
          [
            previewId,
            wid,
            did,
            body.uploadId,
            access.user.id,
            dataset.revision,
            candidate === undefined ? null : asJson(candidate),
            asJson(changes),
            asJson(reimport.conflicts),
          ],
        );
      });
      return {
        previewId,
        baseRevision: dataset.revision,
        changes,
        conflicts: reimport.conflicts,
        expiresInMinutes: 30,
      };
    },
  );

  app.post(
    "/api/workspaces/:wid/datasets/:did/reimport/confirm",
    async (request) => {
      const sql = await requireDb();
      const { wid, did } = params(request);
      const access = await workspaceAccess(request, wid, true);
      const body = jsonBody(
        request,
        z
          .object({
            previewId: z.string().uuid(),
            baseRevision: z.number().int().nonnegative(),
            operationId,
          })
          .strict(),
      );
      const output = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id);
        const repeated = await priorDatasetOperation<{
          dataset: Dataset;
          datasetRevision: number;
        }>(tx, did, body.operationId, access.user.id);
        if (repeated) return repeated;
        const previewRows = await tx.query<{
          upload_id: string;
          user_id: string;
          base_revision: number;
          candidate: unknown;
          conflicts: unknown;
          expires_at: string | Date;
          consumed_at: string | Date | null;
        }>(
          "SELECT upload_id, user_id, base_revision, candidate, conflicts, expires_at, consumed_at FROM reimport_previews WHERE id = $1 AND workspace_id = $2 AND dataset_id = $3 FOR UPDATE",
          [body.previewId, wid, did],
        );
        const preview = previewRows.rows[0];
        if (
          !preview ||
          preview.user_id !== access.user.id ||
          preview.consumed_at ||
          new Date(preview.expires_at).getTime() < Date.now()
        ) {
          throw new HttpError(
            404,
            "REIMPORT_PREVIEW_NOT_FOUND",
            "Re-import preview is invalid, expired, or already used.",
          );
        }
        const conflicts = parseJson<unknown[]>(preview.conflicts);
        if (conflicts.length || !preview.candidate)
          throw new HttpError(
            409,
            "REIMPORT_CONFLICT",
            "Resolve re-import conflicts before confirming.",
          );
        const { row, dataset } = await loadDataset(tx, wid, did, true);
        if (
          dataset.revision !== body.baseRevision ||
          dataset.revision !== Number(preview.base_revision)
        ) {
          throw conflict(
            "Dataset changed after this preview. Create a new re-import preview.",
            { currentRevision: dataset.revision },
          );
        }
        const candidate = parseJson<Dataset>(preview.candidate);
        const next = validateDataset({
          ...candidate,
          id: dataset.id,
          revision: dataset.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        const saved = await tx.query(
          "UPDATE datasets SET snapshot = $1, revision = $2, source_upload_id = $3, updated_at = NOW() WHERE id = $4 AND revision = $5",
          [
            asJson(next),
            next.revision,
            preview.upload_id,
            row.id,
            dataset.revision,
          ],
        );
        if (saved.rowCount !== 1)
          throw conflict(
            "The dataset changed while re-import was being confirmed.",
          );
        await tx.query(
          "UPDATE reimport_previews SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
          [body.previewId],
        );
        const result = { dataset: next, datasetRevision: next.revision };
        await tx.query(
          "INSERT INTO dataset_operations (dataset_id, operation_id, actor_id, result) VALUES ($1, $2, $3, $4)",
          [did, body.operationId, access.user.id, asJson(result)],
        );
        return result;
      });
      events.emit(did, {
        type: "revision",
        revision: output.datasetRevision,
        reimported: true,
      });
      return output;
    },
  );

  app.get(
    "/api/workspaces/:wid/datasets/:did/events",
    async (request, reply) => {
      const { wid, did } = params(request);
      await workspaceAccess(request, wid);
      await loadDataset(await requireDb(), wid, did);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write("retry: 3000\n\n");
      let stopped = false;
      let unsubscribe: () => void = () => undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (keepAlive) clearInterval(keepAlive);
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      // Serialize authorization checks so a burst of local revisions cannot
      // write to a stream after a session expires or membership is revoked.
      let pending = Promise.resolve();
      const deliver = (payload?: unknown, heartbeat = false) => {
        pending = pending.then(async () => {
          if (stopped || reply.raw.writableEnded || reply.raw.destroyed) return;
          try {
            await workspaceAccess(request, wid);
            await loadDataset(await requireDb(), wid, did);
            if (heartbeat) {
              reply.raw.write(": ping\n\n");
              return;
            }
            const revision =
              payload &&
              typeof payload === "object" &&
              typeof (payload as { revision?: unknown }).revision === "number"
                ? (payload as { revision: number }).revision
                : undefined;
            // Consumers re-fetch the authorized snapshot. Do not disclose a
            // ChangeEntry's before/after values over a long-lived stream.
            if (revision !== undefined)
              reply.raw.write(
                `event: revision\ndata: ${JSON.stringify({ type: "revision", revision })}\n\n`,
              );
          } catch {
            stop();
          }
        });
      };
      unsubscribe = events.subscribe(did, (payload) => {
        deliver(payload);
      });
      keepAlive = setInterval(() => {
        deliver(undefined, true);
      }, 25_000);
      request.raw.once("close", stop);
    },
  );

  app.post("/api/workspaces/:wid/uploads", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const file = await request.file();
    if (!file)
      throw new HttpError(400, "UPLOAD_REQUIRED", "Attach one .xlsx workbook.");
    const fileName = safeFileName(file.filename);
    if (!fileName.toLowerCase().endsWith(".xlsx"))
      throw new HttpError(
        415,
        "UNSUPPORTED_FILE",
        "Only .xlsx workbooks are accepted.",
      );
    const fields = file.fields as Record<string, { value?: unknown }>;
    const consent =
      fields.storageConsent?.value === true ||
      fields.storageConsent?.value === "true";
    if (!consent)
      throw new HttpError(
        400,
        "STORAGE_CONSENT_REQUIRED",
        "Explicit storage consent is required before uploading a workbook.",
      );
    const bytes = await file.toBuffer();
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_UPLOAD_BYTES ||
      !isZip(bytes)
    )
      throw new HttpError(
        415,
        "UNSUPPORTED_FILE",
        "The upload is not a valid .xlsx ZIP container.",
      );
    const inspection = await xlsx.inspect(bytes, fileName);
    const id = randomUUID();
    await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id);
      await tx.query(
        `INSERT INTO uploads (id, workspace_id, uploader_id, file_name, mime_type, byte_count, content, inspection, storage_consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
        [
          id,
          wid,
          access.user.id,
          fileName,
          file.mimetype ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          bytes.byteLength,
          Buffer.from(bytes),
          asJson(inspection),
        ],
      );
    });
    return { uploadId: id, inspection };
  });

  app.post("/api/workspaces/:wid/import", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const body = jsonBody(
      request,
      z
        .object({
          uploadId: z.string().uuid(),
          sheetName: z.string().min(1).max(200),
          headerRow: z.number().int().min(1).max(1_048_576),
          startColumn: z.number().int().min(1).max(16_384),
          endColumn: z.number().int().min(1).max(16_384),
          endRow: z.number().int().min(1).max(1_048_576),
          mapping: mappingSchema,
          name: z.string().trim().min(1).max(120),
          dateOrder: z.enum(["ymd", "dmy", "mdy"]),
          locale: z.enum(["en", "ko"]),
          timeZone: z.string().min(1).max(100),
          weekStartsOn: z.union([z.literal(0), z.literal(1)]),
        })
        .strict()
        .refine(
          (value) =>
            value.startColumn <= value.endColumn &&
            value.headerRow <= value.endRow,
          "Import range is invalid.",
        ),
    );
    const uploaded = await sql.query<{
      content: Uint8Array;
      file_name: string;
      storage_consent: boolean;
    }>(
      "SELECT content, file_name, storage_consent FROM uploads WHERE id = $1 AND workspace_id = $2",
      [body.uploadId, wid],
    );
    const upload = uploaded.rows[0];
    if (!upload || !upload.storage_consent)
      throw new HttpError(
        404,
        "UPLOAD_NOT_FOUND",
        "Uploaded workbook was not found with storage consent.",
      );
    const imported = await xlsx.import(new Uint8Array(upload.content), {
      ...body,
      fileName: safeFileName(upload.file_name),
    });
    // The parser derives every cell from the original uploaded bytes. Client
    // input only selects a bounded range and mapping, never supplies records.
    const dataset = validateDataset({
      ...imported,
      id: randomUUID(),
      name: body.name,
      source: {
        ...imported.source,
        kind: "xlsx",
        fileName: safeFileName(upload.file_name),
        sheetName: body.sheetName,
        headerRow: body.headerRow,
        startColumn: body.startColumn,
        endColumn: body.endColumn,
        endRow: body.endRow,
      },
      mapping: body.mapping,
      locale: body.locale,
      timeZone: body.timeZone,
      dateOrder: body.dateOrder,
      weekStartsOn: body.weekStartsOn,
      revision: 0,
      updatedAt: new Date().toISOString(),
    });
    await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id);
      const upload = await tx.query<{ id: string }>(
        "SELECT id FROM uploads WHERE id=$1 AND workspace_id=$2 FOR SHARE",
        [body.uploadId, wid],
      );
      if (!upload.rows[0]) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Uploaded workbook was not found with storage consent.");
      await tx.query(
        "INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, source_upload_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          dataset.id,
          wid,
          asJson(dataset),
          dataset.revision,
          dataset.source.kind,
          body.uploadId,
          access.user.id,
        ],
      );
    });
    return dataset;
  });

  app.get(
    "/api/workspaces/:wid/datasets/:did/export",
    async (request, reply) => {
      const sql = await requireDb();
      const { wid, did } = params(request);
      await workspaceAccess(request, wid);
      const loaded = await loadDataset(sql, wid, did);
      const dataset = loaded.dataset;
      if (dataset.source.kind !== "xlsx" || !loaded.row.source_upload_id)
        throw new HttpError(
          409,
          "EXPORT_UNAVAILABLE",
          "This dataset has no preserved XLSX source workbook.",
        );
      const source = await sql.query<{ content: Uint8Array }>(
        "SELECT content FROM uploads WHERE id = $1 AND workspace_id = $2",
        [loaded.row.source_upload_id, wid],
      );
      if (!source.rows[0])
        throw new HttpError(
          409,
          "EXPORT_UNAVAILABLE",
          "The original XLSX source workbook is unavailable.",
        );
      const bytes = await xlsx.export(
        new Uint8Array(source.rows[0].content),
        dataset,
      );
      const name = `${safeFileName(dataset.name).replace(/\.xlsx$/i, "") || "sheet-workbench"}.xlsx`;
      reply.header(
        "content-type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      reply.header("content-disposition", `attachment; filename="${name}"`);
      return reply.send(Buffer.from(bytes));
    },
  );

  app.get("/api/google/start", async (request) => {
    await requireDb();
    const user = await currentUser(request);
    if (!googleCredentials)
      throw setupNeeded("Google Sheets is not configured.");
    return googleCredentials.begin(user.id);
  });

  app.get("/api/google/picker-config", async (request) => {
    await requireDb();
    const user = await currentUser(request);
    if (!googleCredentials)
      throw setupNeeded("Google Sheets is not configured.");
    const picker = googlePickerConfiguration(options.google?.config);
    if (!picker)
      throw setupNeeded(
        "Google Picker is not configured. Set GOOGLE_PICKER_DEVELOPER_KEY and GOOGLE_APP_ID.",
      );
    // The access token is deliberately short-lived and scoped to drive.file.
    // Refresh credentials remain encrypted in the server database.
    return {
      accessToken: await googleCredentials.accessToken(user.id),
      developerKey: picker.developerKey,
      appId: picker.appId,
    };
  });

  app.post("/api/workspaces/:wid/google/inspect", async (request) => {
    await requireDb();
    const { wid } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const body = jsonBody(
      request,
      z
        .object({
          spreadsheetId: z
            .string()
            .min(3)
            .max(200)
            .regex(/^[A-Za-z0-9_-]+$/),
        })
        .strict(),
    );
    if (!googleReader) throw setupNeeded("Google Sheets is not configured.");
    return googleReader.inspect(body.spreadsheetId, access.user.id);
  });

  app.post("/api/workspaces/:wid/google/import", async (request) => {
    const sql = await requireDb();
    const { wid } = params(request);
    const access = await workspaceAccess(request, wid, true);
    const body = jsonBody(
      request,
      z
        .object({
          spreadsheetId: z
            .string()
            .min(3)
            .max(200)
            .regex(/^[A-Za-z0-9_-]+$/),
          sheetId: z.number().int().nonnegative(),
          headerRow: z.number().int().min(1).max(1_048_576),
          startColumn: z.number().int().min(1).max(16_384),
          endColumn: z.number().int().min(1).max(16_384),
          endRow: z.number().int().min(2).max(1_048_576),
          mapping: mappingSchema,
          identityField: z.string().min(1).max(120).optional(),
          name: z.string().trim().min(1).max(160),
          locale: z.enum(["en", "ko"]),
          timeZone: z.string().min(1).max(100),
          dateOrder: z.enum(["ymd", "dmy", "mdy"]),
          weekStartsOn: z.union([z.literal(0), z.literal(1)]),
          consent: z.literal(true),
        })
        .strict()
        .refine(
          (value) =>
            value.startColumn <= value.endColumn &&
            value.headerRow < value.endRow,
          "Google import range is invalid.",
        ),
    );
    if (!googleReader) throw setupNeeded("Google Sheets is not configured.");
    const imported = await googleReader.importSelection(body, access.user.id);
    const importedSource = imported.dataset.source;
    const dataset = validateDataset({
      ...imported.dataset,
      source: {
        ...importedSource,
        // Refreshes deliberately use the credential set that authorized this
        // source, never whichever collaborator happened to press Refresh.
        connectedBy: access.user.id,
        ...(imported.dataset.mapping.identity &&
        importedSource.sourceColumns?.[imported.dataset.mapping.identity]
          ? {
              identityColumn:
                importedSource.sourceColumns[imported.dataset.mapping.identity],
            }
          : {}),
      },
    });
    await withActorTransaction(sql, access.user.id, async (tx) => {
      await lockWorkspaceAccess(tx, wid, access.user.id);
      await tx.query(
        "INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          dataset.id,
          wid,
          asJson(dataset),
          dataset.revision,
          dataset.source.kind,
          access.user.id,
        ],
      );
    });
    return {
      dataset,
      capabilities: {
        read: true,
        write: !imported.readOnly,
        append: false,
        preservesFormulas: true,
      },
      readOnly: imported.readOnly,
      ...(imported.readOnlyReason
        ? { readOnlyReason: imported.readOnlyReason }
        : {}),
    };
  });

  app.post("/api/workspaces/:wid/datasets/:did/refresh", async (request) => {
    const sql = await requireDb();
    const { wid, did } = params(request);
    // Refresh is a bounded read of the connected source using its stored
    // credential. Viewers may trigger it for current reports; it never writes
    // Google and all source mutations remain editor/owner-only.
    const access = await workspaceAccess(request, wid);
    if (!googleReader) throw setupNeeded("Google Sheets is not configured.");
    try {
      const observed = await loadDataset(sql, wid, did);
      if (observed.dataset.source.kind !== "google")
        throw new HttpError(
          409,
          "REFRESH_UNAVAILABLE",
          "Only Google Sheets datasets can be refreshed from source.",
        );
      const observedSource = observed.dataset.source as StoredGoogleSource;
      if (!observedSource.connectedBy) {
        throw new HttpError(
          409,
          "GOOGLE_RECONNECT_REQUIRED",
          "This Google source has no stored connector identity. Reconnect it before refreshing.",
        );
      }
      // Resolve and durably rotate an expired token before the transaction.
      // The reader below is isolated to this connected source identity.
      const google = await prepareGoogleClient(observedSource.connectedBy);
      if (!google.reader) throw setupNeeded("Google Sheets is not configured.");
      const imported = await google.reader.importSelection(
        googleSelectionFromDataset(observed.dataset),
        observedSource.connectedBy,
      );
      const importedDataset = validateDataset({
        ...imported.dataset,
        source: {
          ...imported.dataset.source,
          connectedBy: observedSource.connectedBy,
          ...(observedSource.identityColumn
            ? { identityColumn: observedSource.identityColumn }
            : {}),
        },
      });
      const output = await withActorTransaction(sql, access.user.id, async (tx) => {
        await lockWorkspaceAccess(tx, wid, access.user.id, false);
        const { row, dataset } = await loadDataset(tx, wid, did, true);
        if (dataset.source.kind !== "google")
          throw new HttpError(
            409,
            "REFRESH_UNAVAILABLE",
            "Only Google Sheets datasets can be refreshed from source.",
          );
        const source = dataset.source as StoredGoogleSource;
        if (
          dataset.revision !== observed.dataset.revision ||
          source.connectedBy !== observedSource.connectedBy
        )
          throw conflict(
            "The dataset source changed while Google refresh was being read.",
          );
        const pending = await tx.query(
          "SELECT id FROM source_jobs WHERE dataset_id=$1 AND status IN ('queued','running') LIMIT 1",
          [did],
        );
        if (pending.rows.length)
          throw new HttpError(
            409,
            "SOURCE_WRITE_PENDING",
            "A source save is pending. The last confirmed data remains visible until it finishes.",
          );
        // The complete remote snapshot was read before locking a database
        // client. Revision and connector identity above bind it to this exact
        // locked dataset before any local state is changed.
        if (
          !sameGoogleHeaderSchema(
            source,
            importedDataset.source as StoredGoogleSource,
          )
        ) {
          throw new HttpError(
            409,
            "GOOGLE_SCHEMA_CHANGED",
            "Google source headers changed or cannot be verified. Review a re-import before refreshing.",
          );
        }
        const oldKeys = dataset.fields.map((field) => field.key).join("|");
        const incomingKeys = importedDataset.fields
          .map((field) => field.key)
          .join("|");
        if (oldKeys !== incomingKeys)
          throw new HttpError(
            409,
            "GOOGLE_REFRESH_CONFLICT",
            "Selected Google columns changed; create a reviewed re-import instead.",
          );
        const hasStableIdentity =
          hasUniqueRecordIdentity(dataset) &&
          hasUniqueRecordIdentity(importedDataset);
        let next: Dataset;
        let added: number;
        let updated: number;
        let removed: number;
        if (hasStableIdentity) {
          // A read-only downgrade (for example revoked canEdit) still has stable
          // IDs, so it can safely merge source changes for reports and reads.
          const merged = mergeGoogleRefresh(dataset, importedDataset);
          added = merged.added;
          updated = merged.updated;
          removed = merged.removed;
          next =
            merged.dataset === dataset
              ? dataset
              : validateDataset({
                  ...merged.dataset,
                  source: importedDataset.source,
                });
        } else {
          // No identity means no edit/writeback, but a fully read bounded
          // snapshot is still safe for a read-only projection. Nothing is
          // pruned until `importSelection` completed and validated every row.
          added = importedDataset.records.length;
          updated = 0;
          removed = dataset.records.length;
          next = validateDataset({
            ...importedDataset,
            id: dataset.id,
            revision: dataset.revision + 1,
            updatedAt: new Date().toISOString(),
          });
        }
        const sourceChanged =
          JSON.stringify(dataset.source) !== JSON.stringify(next.source);
        const contentChanged = added + updated + removed > 0;
        const checked = {
          ...next,
          lastCheckedAt: new Date().toISOString(),
          lastSyncError: undefined,
        } as DatasetWithPresentation;
        if (!contentChanged && !sourceChanged) {
          await tx.query(
            "UPDATE datasets SET snapshot = $1 WHERE id = $2 AND revision = $3",
            [asJson(checked), row.id, dataset.revision],
          );
          return {
            dataset: checked,
            datasetRevision: dataset.revision,
            added,
            updated,
            removed,
            changed: false,
          };
        }
        if (next === dataset || next.revision === dataset.revision) {
          next = validateDataset({
            ...checked,
            revision: dataset.revision + 1,
            updatedAt: new Date().toISOString(),
          });
        } else {
          next = validateDataset({ ...checked });
        }
        const saved = await tx.query(
          "UPDATE datasets SET snapshot = $1, revision = $2, updated_at = NOW() WHERE id = $3 AND revision = $4",
          [asJson(next), next.revision, row.id, dataset.revision],
        );
        if (saved.rowCount !== 1)
          throw conflict(
            "The dataset changed while refresh was being applied.",
          );
        return {
          dataset: next,
          datasetRevision: next.revision,
          added,
          updated,
          removed,
          changed: true,
        };
      });
      if (output.changed)
        events.emit(did, {
          type: "revision",
          revision: output.datasetRevision,
          refreshed: true,
        });
      return output;
    } catch (error) {
      await recordGoogleRefreshFailure(sql, wid, did, error);
      throw error;
    }
  });

  app.get("/api/google/callback", async (request, reply) => {
    await requireDb();
    const user = await currentUser(request);
    if (!googleCredentials)
      throw setupNeeded("Google Sheets is not configured.");
    const query = request.query as {
      state?: unknown;
      code?: unknown;
      error?: unknown;
    };
    if (typeof query.error === "string")
      throw new HttpError(
        400,
        "GOOGLE_OAUTH_DENIED",
        "Google authorization was denied.",
      );
    if (typeof query.state !== "string" || typeof query.code !== "string")
      throw new HttpError(
        400,
        "INVALID_OAUTH_CALLBACK",
        "Google callback is missing state or code.",
      );
    await googleCredentials.complete(user.id, query.state, query.code);
    return reply
      .type("text/html; charset=utf-8")
      .send(
        "<!doctype html><title>Google connected</title><p>Google Sheets is connected. You may close this window.</p>",
      );
  });

  if (db) {
    registerAdministration(app, db, {
      currentUser,
      workspaceAccess,
      deleteCurrentAccount: async (request, password) => {
        if (!auth) throw setupNeeded("Account deletion is not configured.");
        return auth.api.deleteUser({
          body: password ? { password } : {},
          headers: headersFromRequest(request),
        });
      },
      emitDataset: (id, payload) => events.emit(id, payload),
    });
    registerPortability(app, {
      db,
      currentUser,
      workspaceAccess,
      inspectXlsx: (bytes) => xlsx.inspect(bytes, "restored-workbook.xlsx"),
    });
  }

  return app;
}
