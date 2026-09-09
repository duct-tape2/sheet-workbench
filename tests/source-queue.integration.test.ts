import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Dataset } from "../packages/core/src/types.ts";
import { migrate } from "../apps/server/src/schema.ts";
import type { SqlClient } from "../apps/server/src/db.ts";
import { createServer, type XlsxService } from "../apps/server/src/server.ts";
import { SourceQueue } from "../apps/server/src/source-queue.ts";
import { HttpError } from "../apps/server/src/errors.ts";
import type {
  GoogleSheetsConnector,
  GoogleWriteResult,
} from "../apps/server/src/google.ts";

let db: PGlite;
let app: ReturnType<typeof createServer>;
let applyPatch: ReturnType<typeof vi.fn>;
let recoverPatch: ReturnType<typeof vi.fn>;
let xlsxExport: ReturnType<typeof vi.fn>;

const owner = {
  id: "source-queue-owner",
  email: "source-queue@example.test",
  emailVerified: true,
};
const otherEditor = {
  id: "source-queue-other-editor",
  email: "source-queue-other@example.test",
  emailVerified: true,
};
const workspaceId = "source-queue-workspace";
const datasetId = "source-queue-dataset";
const recordId = "google-source-queue-record";

const googleDataset = (): Dataset => ({
  id: datasetId,
  name: "Queued Google source",
  source: {
    kind: "google",
    spreadsheetId: "sheet-source-queue",
    sheetId: 0,
    sheetName: "Tasks",
    headerRow: 1,
    startColumn: 1,
    endColumn: 2,
    endRow: 2,
    sourceColumns: { g_id: "A", g_title: "B" },
    sourceHeaders: { g_id: "ID", g_title: "Title" },
    identityColumn: "A",
    connectedBy: owner.id,
    readOnly: false,
  },
  fields: [
    { key: "g_id", label: "ID", type: "text" },
    { key: "g_title", label: "Title", type: "text", required: true },
  ],
  mapping: { title: "g_title", identity: "g_id" },
  records: [
    {
      id: recordId,
      revision: 0,
      sourceRow: 2,
      values: { g_id: "source-row-1", g_title: "Before" },
    },
  ],
  revision: 0,
  locale: "en",
  timeZone: "UTC",
  dateOrder: "ymd",
  weekStartsOn: 1,
  updatedAt: new Date().toISOString(),
  completedStatuses: [],
});

const write: GoogleWriteResult = {
  preimage: { g_title: "Before" },
  postwrite: { g_title: "After" },
};

function patchRequest(operationId: string, baseRevision = 0) {
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`,
    headers: { "x-test-user": owner.id },
    payload: {
      operationId,
      recordId,
      baseRevision,
      changes: { g_title: "After" },
    },
  });
}

function sourceQueue(): SourceQueue {
  return app.getDecorator<SourceQueue>("sourceQueue");
}

async function makeRetryDue(operationId: string): Promise<void> {
  await db.query(
    "UPDATE source_jobs SET next_attempt_at = NOW() WHERE dataset_id = $1 AND operation_id = $2",
    [datasetId, operationId],
  );
}

async function storedDataset(id = datasetId): Promise<Dataset> {
  const response = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceId}/datasets/${id}`,
    headers: { "x-test-user": owner.id },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Dataset;
}

beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  await db.query(
    'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
    [owner.id, "Source queue owner", owner.email],
  );
  await db.query(
    'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
    [otherEditor.id, "Other source queue editor", otherEditor.email],
  );
  await db.query(
    "INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)",
    [workspaceId, "Source queue workspace", owner.id],
  );
  await db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [workspaceId, owner.id],
  );
  await db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')",
    [workspaceId, otherEditor.id],
  );
  await db.query(
    `INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, created_by)
     VALUES ($1, $2, $3, 0, 'google', $4)`,
    [datasetId, workspaceId, JSON.stringify(googleDataset()), owner.id],
  );

  applyPatch = vi.fn();
  recoverPatch = vi.fn();
  xlsxExport = vi.fn(async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  const connector = {
    applyPatch,
    recoverPatch,
  } as unknown as GoogleSheetsConnector;
  const xlsx = {
    inspect: vi.fn(),
    import: vi.fn(),
    export: xlsxExport,
    reimport: vi.fn(),
  } as unknown as XlsxService;
  app = createServer({
    db: db as unknown as SqlClient,
    sessionResolver: async (request) => {
      if (request.headers["x-test-user"] === owner.id) return owner;
      if (request.headers["x-test-user"] === otherEditor.id) return otherEditor;
      return null;
    },
    google: { connector },
    xlsx,
    sourceWorker: false,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

describe("server-backed Google source queue", () => {
  it("schedules a transient 503, drains it once, and records one canonical change", async () => {
    const operationId = "google_queue_retry_0001";
    applyPatch
      .mockRejectedValueOnce(
        new HttpError(503, "GOOGLE_UNAVAILABLE", "Temporary Google outage."),
      )
      .mockResolvedValueOnce(write);
    recoverPatch.mockResolvedValueOnce({ outcome: "not-applied" });

    const scheduled = await patchRequest(operationId);
    expect(scheduled.statusCode).toBe(503);
    expect(scheduled.json()).toMatchObject({
      code: "SOURCE_RETRY_SCHEDULED",
      details: { operationId, status: "queued" },
    });
    expect(applyPatch).toHaveBeenCalledTimes(1);

    await makeRetryDue(operationId);
    await sourceQueue().drain();

    expect(recoverPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledTimes(2);
    const job = await db.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM source_jobs WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operationId],
    );
    expect(job.rows[0]).toEqual({ status: "succeeded", attempts: 2 });
    const operation = await db.query<{ status: string }>(
      "SELECT status FROM source_operations WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operationId],
    );
    expect(operation.rows[0]?.status).toBe("succeeded");
    expect((await storedDataset()).records[0]?.values.g_title).toBe("After");

    const history = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/history`,
      headers: { "x-test-user": owner.id },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(1);
    expect(history.json()[0]).toMatchObject({
      operationId,
      after: { g_title: "After" },
    });
    const report = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/source-jobs`,
      headers: { "x-test-user": owner.id },
    });
    expect(report.json()[0]).toMatchObject({
      operationId,
      status: "succeeded",
      attempts: 2,
    });
  });

  it("recovers a lost source response without issuing a second remote patch", async () => {
    const operationId = "google_queue_lost_response_01";
    applyPatch.mockRejectedValueOnce(
      new HttpError(503, "GOOGLE_TIMEOUT", "The remote response was lost."),
    );
    recoverPatch.mockResolvedValueOnce({ outcome: "applied", write });

    expect((await patchRequest(operationId)).statusCode).toBe(503);
    await makeRetryDue(operationId);
    await sourceQueue().drain();

    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(recoverPatch).toHaveBeenCalledTimes(1);
    expect((await storedDataset()).revision).toBe(1);
    expect((await storedDataset()).records[0]?.values.g_title).toBe("After");
    expect(
      (
        await db.query(
          "SELECT id FROM dataset_changes WHERE dataset_id = $1 AND operation_id = $2",
          [datasetId, operationId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("returns the same canonical result when an operation is replayed", async () => {
    const operationId = "google_queue_replay_0001";
    applyPatch.mockResolvedValueOnce(write);

    const first = await patchRequest(operationId);
    expect(first.statusCode).toBe(200);
    const replay = await patchRequest(operationId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const changedReplay = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`,
      headers: { "x-test-user": owner.id },
      payload: {
        operationId,
        recordId,
        baseRevision: 0,
        changes: { g_title: "Different request" },
      },
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json().message).toMatch(/different request/);
    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query(
          "SELECT id FROM source_jobs WHERE dataset_id = $1 AND operation_id = $2",
          [datasetId, operationId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT id FROM dataset_changes WHERE dataset_id = $1 AND operation_id = $2",
          [datasetId, operationId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("fails a due retry when membership is revoked before it can write again", async () => {
    const operationId = "google_queue_revoked_0001";
    applyPatch.mockRejectedValueOnce(
      new HttpError(503, "GOOGLE_UNAVAILABLE", "Temporary Google outage."),
    );

    expect((await patchRequest(operationId)).statusCode).toBe(503);
    await db.query(
      "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, owner.id],
    );
    await makeRetryDue(operationId);
    await sourceQueue().drain();

    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(recoverPatch).not.toHaveBeenCalled();
    const job = await db.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM source_jobs WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operationId],
    );
    expect(job.rows[0]).toEqual({ status: "failed", error_code: "FORBIDDEN" });
    const operation = await db.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM source_operations WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operationId],
    );
    expect(operation.rows[0]).toEqual({
      status: "failed",
      error_code: "FORBIDDEN",
    });
    const row = await db.query<{ snapshot: Dataset }>(
      "SELECT snapshot FROM datasets WHERE id = $1",
      [datasetId],
    );
    const snapshot =
      typeof row.rows[0]?.snapshot === "string"
        ? (JSON.parse(row.rows[0].snapshot) as Dataset)
        : row.rows[0]?.snapshot;
    expect(snapshot?.records[0]?.values.g_title).toBe("Before");
    expect(
      (
        await db.query("SELECT id FROM dataset_changes WHERE dataset_id = $1", [
          datasetId,
        ])
      ).rows,
    ).toHaveLength(0);
  });

  it("permits only the requesting editor to manually retry and reconciles before another write", async () => {
    const operationId = "google_queue_manual_recovery_01";
    applyPatch.mockRejectedValueOnce(
      new HttpError(
        502,
        "GOOGLE_POSTWRITE_UNCERTAIN",
        "Google did not confirm the postwrite.",
      ),
    );

    const failed = await patchRequest(operationId);
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({
      code: "GOOGLE_POSTWRITE_UNCERTAIN",
    });
    const failedOperation = await db.query<{ status: string }>(
      "SELECT status FROM source_operations WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operationId],
    );
    expect(failedOperation.rows[0]?.status).toBe("failed");

    const denied = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/source-jobs/retry`,
      headers: { "x-test-user": otherEditor.id },
      payload: { operationId },
    });
    expect(denied.statusCode).toBe(403);
    expect(recoverPatch).not.toHaveBeenCalled();

    recoverPatch.mockResolvedValueOnce({ outcome: "applied", write });
    const recovered = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/source-jobs/retry`,
      headers: { "x-test-user": owner.id },
      payload: { operationId },
    });
    expect(recovered.statusCode).toBe(200);
    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(recoverPatch).toHaveBeenCalledTimes(1);
    expect((await storedDataset()).records[0]?.values.g_title).toBe("After");
    const operation = await db.query<{ status: string }>(
      "SELECT status FROM source_operations WHERE dataset_id = $1 AND operation_id = $2",
      [datasetId, operationId],
    );
    expect(operation.rows[0]?.status).toBe("succeeded");
  });
});

describe("dataset version APIs", () => {
  it("lists a historical XLSX snapshot and exports that exact snapshot", async () => {
    const uploadId = "source-queue-version-upload";
    const versionDatasetId = "source-queue-version-dataset";
    const before: Dataset = {
      ...googleDataset(),
      id: versionDatasetId,
      name: "Historical workbook",
      source: {
        kind: "xlsx",
        fileName: "historical.xlsx",
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 2,
        endRow: 2,
      },
      records: [
        {
          id: "xlsx-source-queue-record",
          revision: 0,
          sourceRow: 2,
          values: { g_id: "source-row-1", g_title: "Before" },
        },
      ],
    };
    const after: Dataset = {
      ...before,
      revision: 1,
      records: [
        {
          ...before.records[0]!,
          revision: 1,
          values: { ...before.records[0]!.values, g_title: "After" },
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);
    await db.query(
      `INSERT INTO uploads (id, workspace_id, uploader_id, file_name, mime_type, byte_count, content, inspection, storage_consent)
       VALUES ($1, $2, $3, 'historical.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', $4, $5, '{}'::jsonb, TRUE)`,
      [uploadId, workspaceId, owner.id, original.length, Buffer.from(original)],
    );
    await db.query(
      `INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, source_upload_id, created_by)
       VALUES ($1, $2, $3, 0, 'xlsx', $4, $5)`,
      [
        versionDatasetId,
        workspaceId,
        JSON.stringify(before),
        uploadId,
        owner.id,
      ],
    );
    await db.query(
      "UPDATE datasets SET snapshot = $1, revision = 1 WHERE id = $2",
      [JSON.stringify(after), versionDatasetId],
    );

    const versions = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/datasets/${versionDatasetId}/versions`,
      headers: { "x-test-user": owner.id },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toEqual([
      expect.objectContaining({
        revision: 1,
        recordCount: 1,
        canExportXlsx: true,
      }),
      expect.objectContaining({
        revision: 0,
        recordCount: 1,
        canExportXlsx: true,
      }),
    ]);

    const snapshot = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/datasets/${versionDatasetId}/versions/0`,
      headers: { "x-test-user": owner.id },
    });
    expect(snapshot.statusCode).toBe(200);
    expect((snapshot.json() as Dataset).records[0]?.values.g_title).toBe(
      "Before",
    );

    const exported = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/datasets/${versionDatasetId}/versions/0?format=xlsx`,
      headers: { "x-test-user": owner.id },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toBe(
      'attachment; filename="workbook-revision-0.xlsx"',
    );
    expect(exported.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(new Uint8Array(exported.rawPayload)).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(xlsxExport).toHaveBeenCalledWith(
      original,
      expect.objectContaining({
        revision: 0,
        records: [
          expect.objectContaining({
            values: { g_id: "source-row-1", g_title: "Before" },
          }),
        ],
      }),
    );
  });
});
