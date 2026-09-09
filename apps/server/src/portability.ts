import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DomainError,
  validateDataset,
  validateValues,
  type CellValue,
  type ChangeEntry,
  type Dataset,
  type Role,
  type WorkRecord,
} from "../../../packages/core/src/index.ts";
import { inspectWorkbook } from "../../../packages/xlsx/src/index.ts";
import { asJson, inTransaction, parseJson, type SqlClient } from "./db.ts";
import { forbidden, HttpError } from "./errors.ts";
import type { SessionUser } from "./auth.ts";
import {
  lockActiveActor,
  lockWorkspaceAccess,
  withActorTransaction,
} from "./write-access.ts";

/** The only archive revision currently accepted by restore. */
export const PORTABLE_WORKSPACE_VERSION = 1 as const;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_DATASETS = 100;
const MAX_CHANGES_PER_DATASET = 50_000;
const stableArchiveId = z.string().uuid();
const stableDatasetId = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/);
const stableOperationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/;
const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "must not contain control characters",
    );

const archiveChangeSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    actorId: z.string().min(1).max(200),
    entry: z.unknown(),
    record: z.unknown(),
    datasetRevision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();

const archiveUploadSchema = z
  .object({
    id: stableArchiveId,
    fileName: boundedText(160),
    mimeType: boundedText(200),
    byteCount: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentBase64: z.string().max(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4),
    inspection: z.unknown(),
    storageConsent: z.literal(true),
    createdAt: z.string().datetime(),
  })
  .strict();

const portableArchiveSchema = z
  .object({
    version: z.literal(PORTABLE_WORKSPACE_VERSION),
    exportedAt: z.string().datetime(),
    workspace: z.object({ name: boundedText(120) }).strict(),
    uploads: z.array(archiveUploadSchema).max(MAX_DATASETS),
    datasets: z
      .array(
        z
          .object({
            // Imported Google/XLSX dataset IDs are deterministic provider IDs, not
            // necessarily UUIDs. Upload IDs stay UUIDs because they are SQL rows.
            id: stableDatasetId,
            snapshotVersion: z.literal(PORTABLE_WORKSPACE_VERSION),
            snapshot: z.unknown(),
            revision: z.number().int().nonnegative(),
            sourceUploadId: stableArchiveId.nullable(),
            changes: z.array(archiveChangeSchema).max(MAX_CHANGES_PER_DATASET),
          })
          .strict(),
      )
      .max(MAX_DATASETS),
  })
  .strict();

export type PortableWorkspaceArchive = z.infer<typeof portableArchiveSchema>;

/** Minimal dependency boundary so `server.ts` can register routes without a circular import. */
export interface PortabilityContext {
  db: SqlClient;
  currentUser(request: FastifyRequest): Promise<SessionUser>;
  workspaceAccess(
    request: FastifyRequest,
    workspaceId: string,
    write?: boolean,
    ownerOnly?: boolean,
  ): Promise<{ user: SessionUser; role: Role }>;
  /** Test seam; production defaults to the safe XLSX inspector. */
  inspectXlsx?(bytes: Uint8Array): unknown | Promise<unknown>;
}

interface WorkspaceRow {
  id: string;
  name: string;
}
interface DatasetRow {
  id: string;
  snapshot: unknown;
  revision: number;
  source_upload_id: string | null;
}
interface ChangeRow {
  operation_id: string;
  actor_id: string;
  entry: unknown;
  record: unknown;
  dataset_revision: number;
  created_at: string | Date;
}
interface UploadRow {
  id: string;
  file_name: string;
  mime_type: string;
  byte_count: number;
  content: Uint8Array;
  inspection: unknown;
  storage_consent: boolean;
  created_at: string | Date;
}

function invalidArchive(message: string, details?: unknown): HttpError {
  return new HttpError(422, "INVALID_PORTABLE_ARCHIVE", message, details);
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw invalidArchive("Stored archive data has an invalid timestamp.");
  return date.toISOString();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeJson(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw invalidArchive("Archive contains a non-finite number.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, seen);
    return;
  }
  if (!value || typeof value !== "object")
    throw invalidArchive("Archive contains a non-JSON value.");
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null)
    throw invalidArchive("Archive contains a non-plain object.");
  if (seen.has(object))
    throw invalidArchive("Archive contains a cyclic object.");
  seen.add(object);
  for (const [key, child] of Object.entries(object)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw invalidArchive("Archive contains an unsafe object key.");
    assertSafeJson(child, seen);
  }
}

function decodeBase64(value: string, expectedLength: number): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw invalidArchive("Upload content is not canonical base64.");
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (
    bytes.length !== expectedLength ||
    Buffer.from(bytes).toString("base64") !== value
  )
    throw invalidArchive(
      "Upload byte count does not match its base64 content.",
    );
  return bytes;
}

function archiveBody(value: unknown): PortableWorkspaceArchive {
  const parsed = portableArchiveSchema.safeParse(value);
  if (!parsed.success)
    throw invalidArchive(
      "Portable archive schema is invalid.",
      parsed.error.flatten(),
    );
  assertSafeJson(parsed.data);
  return parsed.data;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertStableHistoryId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !stableOperationId.test(value))
    throw invalidArchive(`${label} is not a stable identifier.`);
}

function cellsEqual(
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

/** Validate history as a replayable record patch, never as opaque JSON. */
function validateHistoryChange(
  change: PortableWorkspaceArchive["datasets"][number]["changes"][number],
  snapshot: Dataset,
): void {
  assertStableHistoryId(change.operationId, "Change operation ID");
  if (!boundedText(200).safeParse(change.actorId).success)
    throw invalidArchive("Change actor ID is invalid.");
  if (!isPlainRecord(change.entry) || !isPlainRecord(change.record))
    throw invalidArchive(
      "Change history requires plain entry and record objects.",
    );
  const entry = change.entry as unknown as ChangeEntry;
  const record = change.record as unknown as WorkRecord;
  assertStableHistoryId(entry.id, "Change entry ID");
  assertStableHistoryId(entry.operationId, "Change entry operation ID");
  assertStableHistoryId(entry.recordId, "Change entry record ID");
  assertStableHistoryId(record.id, "Change record ID");
  if (
    entry.id !== change.operationId ||
    entry.operationId !== change.operationId ||
    entry.recordId !== record.id
  ) {
    throw invalidArchive(
      "Change history operation and record identities do not agree.",
    );
  }
  if (!boundedText(200).safeParse(entry.actor).success)
    throw invalidArchive("Change entry actor is invalid.");
  if (
    typeof entry.at !== "string" ||
    Number.isNaN(Date.parse(entry.at)) ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0 ||
    entry.revision !== record.revision
  ) {
    throw invalidArchive("Change entry revision or timestamp is invalid.");
  }
  if (!isPlainRecord(entry.before) || !isPlainRecord(entry.after))
    throw invalidArchive("Change entry values are invalid.");
  const before = entry.before as Record<string, CellValue>;
  const after = entry.after as Record<string, CellValue>;
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (
    !afterKeys.length ||
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key, index) => key !== afterKeys[index])
  )
    throw invalidArchive("Change entry before/after fields do not agree.");
  try {
    validateValues(snapshot.fields, before, true);
    validateValues(snapshot.fields, after, true);
    validateDataset({ ...snapshot, records: [record] });
  } catch (error) {
    throw invalidArchive(
      "Change history contains invalid field or record values.",
      error instanceof DomainError ? error.code : undefined,
    );
  }
  if (
    change.datasetRevision > snapshot.revision ||
    record.revision > snapshot.revision ||
    afterKeys.some((key) => !cellsEqual(record.values[key], after[key]))
  ) {
    throw invalidArchive("Change history does not match its recorded result.");
  }
}

function archiveDataset(
  row: DatasetRow,
  changes: ChangeRow[],
): PortableWorkspaceArchive["datasets"][number] {
  const snapshot = parseJson<Dataset>(row.snapshot);
  try {
    validateDataset(snapshot);
  } catch (error) {
    throw invalidArchive(
      "Stored dataset snapshot is invalid and cannot be exported.",
      error instanceof DomainError ? error.code : undefined,
    );
  }
  if (snapshot.id !== row.id || snapshot.revision !== Number(row.revision))
    throw invalidArchive(
      "Stored dataset identity or revision is inconsistent.",
    );
  return {
    id: row.id,
    snapshotVersion: PORTABLE_WORKSPACE_VERSION,
    snapshot,
    revision: Number(row.revision),
    sourceUploadId: row.source_upload_id,
    changes: changes.map((change) => ({
      operationId: change.operation_id,
      actorId: change.actor_id,
      entry: parseJson(change.entry),
      record: parseJson(change.record),
      datasetRevision: Number(change.dataset_revision),
      createdAt: iso(change.created_at),
    })),
  };
}

/** Build a portable, credentials-free snapshot for an owner-authorized workspace. */
export async function exportWorkspaceArchive(
  db: SqlClient,
  workspaceId: string,
  actorId?: string,
): Promise<PortableWorkspaceArchive> {
  return inTransaction(db, async (tx) => {
    if (actorId) {
      await lockActiveActor(tx, actorId);
      await lockWorkspaceAccess(tx, workspaceId, actorId, false, true);
    }
    // Every server mutation locks its dataset row before snapshot/history
    // updates. Shared locks make the snapshot plus its change log coherent
    // and also prevent a workspace delete from racing this export.
    const workspace = await tx.query<WorkspaceRow>(
      "SELECT id, name FROM workspaces WHERE id = $1 FOR SHARE",
      [workspaceId],
    );
    const current = workspace.rows[0];
    if (!current)
      throw new HttpError(
        404,
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
      );
    const datasets = await tx.query<DatasetRow>(
      "SELECT id, snapshot, revision, source_upload_id FROM datasets WHERE workspace_id = $1 ORDER BY created_at ASC FOR SHARE",
      [workspaceId],
    );
    const uploads = await tx.query<UploadRow>(
      "SELECT id, file_name, mime_type, byte_count, content, inspection, storage_consent, created_at FROM uploads WHERE workspace_id = $1 ORDER BY created_at ASC FOR SHARE",
      [workspaceId],
    );
    const archiveDatasets: PortableWorkspaceArchive["datasets"] = [];
    for (const dataset of datasets.rows) {
      const changes = await tx.query<ChangeRow>(
        "SELECT operation_id, actor_id, entry, record, dataset_revision, created_at FROM dataset_changes WHERE dataset_id = $1 ORDER BY dataset_revision ASC, created_at ASC FOR SHARE",
        [dataset.id],
      );
      archiveDatasets.push(archiveDataset(dataset, changes.rows));
    }
    let totalUploadBytes = 0;
    const archiveUploads: PortableWorkspaceArchive["uploads"] =
      uploads.rows.map((upload) => {
        const content = new Uint8Array(upload.content);
        if (
          content.length !== Number(upload.byte_count) ||
          !upload.storage_consent
        )
          throw invalidArchive("Stored upload metadata is inconsistent.");
        totalUploadBytes += content.length;
        if (totalUploadBytes > MAX_UPLOAD_BYTES)
          throw invalidArchive(
            "Workspace uploads exceed the 25 MiB portable archive limit.",
          );
        return {
          id: upload.id,
          fileName: upload.file_name,
          mimeType: upload.mime_type,
          byteCount: content.length,
          sha256: sha256(content),
          contentBase64: Buffer.from(content).toString("base64"),
          inspection: parseJson(upload.inspection),
          storageConsent: true,
          createdAt: iso(upload.created_at),
        };
      });
    const archive: PortableWorkspaceArchive = {
      version: PORTABLE_WORKSPACE_VERSION,
      exportedAt: new Date().toISOString(),
      workspace: { name: current.name },
      uploads: archiveUploads,
      datasets: archiveDatasets,
    };
    return archiveBody(archive);
  });
}

interface PreparedUpload {
  archiveId: string;
  newId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  inspection: unknown;
}
interface PreparedDataset {
  archiveId: string;
  dataset: Dataset;
  sourceUploadId: string | null;
  changes: PortableWorkspaceArchive["datasets"][number]["changes"];
}

async function prepareRestore(
  archive: PortableWorkspaceArchive,
  inspectXlsx: (bytes: Uint8Array) => unknown | Promise<unknown>,
): Promise<{ uploads: PreparedUpload[]; datasets: PreparedDataset[] }> {
  const uploadIds = new Set<string>();
  const uploadMap = new Map<string, PreparedUpload>();
  let totalUploadBytes = 0;
  for (const upload of archive.uploads) {
    if (uploadIds.has(upload.id))
      throw invalidArchive("Archive contains duplicate upload IDs.");
    uploadIds.add(upload.id);
    totalUploadBytes += upload.byteCount;
    if (totalUploadBytes > MAX_UPLOAD_BYTES)
      throw invalidArchive(
        "Portable archive uploads exceed the 25 MiB restore limit.",
      );
    const bytes = decodeBase64(upload.contentBase64, upload.byteCount);
    if (sha256(bytes) !== upload.sha256)
      throw invalidArchive(
        `Upload checksum does not match for ${upload.fileName}.`,
      );
    let inspection: unknown;
    try {
      inspection = await inspectXlsx(bytes);
    } catch {
      throw invalidArchive(
        `Upload ${upload.fileName} is not a safe XLSX workbook.`,
      );
    }
    assertSafeJson(inspection);
    const prepared = {
      archiveId: upload.id,
      newId: randomUUID(),
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      bytes,
      inspection,
    };
    uploadMap.set(upload.id, prepared);
  }

  const datasetIds = new Set<string>();
  const datasets: PreparedDataset[] = [];
  for (const archived of archive.datasets) {
    if (datasetIds.has(archived.id))
      throw invalidArchive("Archive contains duplicate dataset IDs.");
    datasetIds.add(archived.id);
    assertSafeJson(archived.snapshot);
    let snapshot: Dataset;
    try {
      snapshot = validateDataset(archived.snapshot as Dataset);
    } catch (error) {
      throw invalidArchive(
        "Dataset snapshot failed canonical validation.",
        error instanceof DomainError ? error.code : undefined,
      );
    }
    if (snapshot.id !== archived.id || snapshot.revision !== archived.revision)
      throw invalidArchive(
        "Dataset archive identity or revision is inconsistent.",
      );
    if (snapshot.source.kind === "xlsx") {
      if (!archived.sourceUploadId || !uploadMap.has(archived.sourceUploadId))
        throw invalidArchive(
          "XLSX dataset does not reference an archived original upload.",
        );
    } else if (archived.sourceUploadId !== null) {
      throw invalidArchive(
        "Only XLSX datasets may reference an original upload.",
      );
    }
    const operationIds = new Set<string>();
    for (const change of archived.changes) {
      assertSafeJson(change.entry);
      assertSafeJson(change.record);
      if (operationIds.has(change.operationId))
        throw invalidArchive(
          "Dataset change history contains duplicate operation IDs.",
        );
      operationIds.add(change.operationId);
      validateHistoryChange(change, snapshot);
    }
    const source =
      snapshot.source.kind === "google"
        ? {
            ...snapshot.source,
            connectedBy: undefined,
            readOnly: true,
            readOnlyReason:
              "Restored Google source is disconnected. Reconnect it before editing.",
          }
        : snapshot.source;
    datasets.push({
      archiveId: archived.id,
      dataset: validateDataset({ ...snapshot, id: randomUUID(), source }),
      sourceUploadId: archived.sourceUploadId,
      changes: archived.changes,
    });
  }
  return { uploads: [...uploadMap.values()], datasets };
}

/** Restore creates an entirely new workspace; it never updates archive-origin rows. */
export async function restoreWorkspaceArchive(
  db: SqlClient,
  user: SessionUser,
  value: unknown,
  requestedName: string | undefined,
  inspectXlsx: (
    bytes: Uint8Array,
  ) => unknown | Promise<unknown> = inspectWorkbook,
): Promise<{
  id: string;
  name: string;
  datasetCount: number;
  uploadCount: number;
}> {
  const archive = archiveBody(value);
  const workspaceName = requestedName ?? archive.workspace.name;
  if (!boundedText(120).safeParse(workspaceName).success)
    throw invalidArchive("New workspace name is invalid.");
  const prepared = await prepareRestore(archive, inspectXlsx);
  const workspaceId = randomUUID();
  await withActorTransaction(db, user.id, async (tx) => {
    await tx.query(
      "INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)",
      [workspaceId, workspaceName, user.id],
    );
    await tx.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, user.id],
    );
    const uploadIds = new Map(
      prepared.uploads.map((upload) => [upload.archiveId, upload.newId]),
    );
    for (const upload of prepared.uploads) {
      await tx.query(
        `INSERT INTO uploads (id, workspace_id, uploader_id, file_name, mime_type, byte_count, content, inspection, storage_consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
        [
          upload.newId,
          workspaceId,
          user.id,
          upload.fileName,
          upload.mimeType,
          upload.bytes.length,
          Buffer.from(upload.bytes),
          asJson(upload.inspection),
        ],
      );
    }
    for (const preparedDataset of prepared.datasets) {
      const sourceUploadId = preparedDataset.sourceUploadId
        ? uploadIds.get(preparedDataset.sourceUploadId)
        : null;
      if (preparedDataset.sourceUploadId && !sourceUploadId)
        throw invalidArchive(
          "Dataset upload reference changed during restore.",
        );
      const dataset = preparedDataset.dataset;
      await tx.query(
        `INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, source_upload_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          dataset.id,
          workspaceId,
          asJson(dataset),
          dataset.revision,
          dataset.source.kind,
          sourceUploadId,
          user.id,
        ],
      );
      for (const change of preparedDataset.changes) {
        await tx.query(
          `INSERT INTO dataset_changes (id, dataset_id, operation_id, actor_id, entry, record, dataset_revision, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            dataset.id,
            change.operationId,
            user.id,
            asJson(change.entry),
            asJson(change.record),
            change.datasetRevision,
            change.createdAt,
          ],
        );
      }
    }
  });
  return {
    id: workspaceId,
    name: workspaceName,
    datasetCount: prepared.datasets.length,
    uploadCount: prepared.uploads.length,
  };
}

/** Register owner-only archive/export/delete routes against the server's auth boundary. */
export function registerPortability(
  app: FastifyInstance,
  context: PortabilityContext,
): void {
  app.get("/api/workspaces/:wid/export", async (request) => {
    const workspaceId = (request.params as { wid: string }).wid;
    const access = await context.workspaceAccess(
      request,
      workspaceId,
      false,
      true,
    );
    return exportWorkspaceArchive(context.db, workspaceId, access.user.id);
  });

  app.post(
    "/api/workspaces/restore",
    { bodyLimit: MAX_ARCHIVE_BYTES },
    async (request) => {
      const body = z
        .object({
          archive: z.unknown(),
          newWorkspaceName: boundedText(120).optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Restore request body is invalid.",
          body.error.flatten(),
        );
      const user = await context.currentUser(request);
      return restoreWorkspaceArchive(
        context.db,
        user,
        body.data.archive,
        body.data.newWorkspaceName,
        context.inspectXlsx,
      );
    },
  );

  app.delete("/api/workspaces/:wid", async (request) => {
    const workspaceId = (request.params as { wid: string }).wid;
    const access = await context.workspaceAccess(
      request,
      workspaceId,
      true,
      true,
    );
    const body = z
      .object({ confirmName: z.string().max(120) })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Workspace deletion confirmation is invalid.",
        body.error.flatten(),
      );
    await withActorTransaction(context.db, access.user.id, async (tx) => {
      const workspace = await tx.query<WorkspaceRow>(
        "SELECT id, name FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      const row = workspace.rows[0];
      if (!row)
        throw new HttpError(
          404,
          "WORKSPACE_NOT_FOUND",
          "Workspace was not found.",
        );
      await lockWorkspaceAccess(tx, workspaceId, access.user.id, true, true);
      if (body.data.confirmName !== row.name)
        throw new HttpError(
          400,
          "CONFIRMATION_MISMATCH",
          "Enter the exact workspace name to delete it.",
        );
      const removed = await tx.query("DELETE FROM workspaces WHERE id = $1", [
        workspaceId,
      ]);
      if (removed.rowCount !== 1)
        throw new HttpError(
          409,
          "CONFLICT",
          "Workspace changed while deletion was being confirmed.",
        );
    });
    return { deleted: true };
  });
}
