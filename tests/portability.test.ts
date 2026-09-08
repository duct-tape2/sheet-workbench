import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Dataset, Role } from "../packages/core/src/types.ts";
import type { SqlClient } from "../apps/server/src/db.ts";
import { HttpError, forbidden } from "../apps/server/src/errors.ts";
import { registerPortability } from "../apps/server/src/portability.ts";
import { migrate } from "../apps/server/src/schema.ts";

const owner = {
  id: "portable-owner",
  email: "owner@example.test",
  emailVerified: true,
};
const stranger = {
  id: "portable-stranger",
  email: "stranger@example.test",
  emailVerified: true,
};
let db: PGlite;
let app: ReturnType<typeof Fastify>;
let workspaceId: string;

function sampleWorkbook(): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL("../samples/team.xlsx", import.meta.url)),
  );
}

function currentUser(request: FastifyRequest) {
  const id = request.headers["x-test-user"];
  if (id === owner.id) return Promise.resolve(owner);
  if (id === stranger.id) return Promise.resolve(stranger);
  throw new HttpError(401, "UNAUTHENTICATED", "Sign in is required.");
}

async function workspaceAccess(
  request: FastifyRequest,
  workspace: string,
  write = false,
  ownerOnly = false,
) {
  const user = await currentUser(request);
  const result = await db.query<{ role: Role }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspace, user.id],
  );
  const role = result.rows[0]?.role;
  if (!role || (write && role === "viewer") || (ownerOnly && role !== "owner"))
    throw forbidden();
  return { user, role };
}

function requestAs(
  user: typeof owner,
  url: string,
  options: { method?: string; payload?: unknown } = {},
) {
  return app.inject({
    method: options.method ?? "GET",
    url,
    headers: { "x-test-user": user.id },
    payload: options.payload,
  });
}

async function seedWorkspace(): Promise<void> {
  workspaceId = randomUUID();
  await db.query(
    "INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)",
    [workspaceId, "Portable source", owner.id],
  );
  await db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [workspaceId, owner.id],
  );
  const uploadId = randomUUID();
  const bytes = sampleWorkbook();
  await db.query(
    `INSERT INTO uploads (id, workspace_id, uploader_id, file_name, mime_type, byte_count, content, inspection, storage_consent)
     VALUES ($1, $2, $3, 'team.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', $4, $5, '{}'::jsonb, TRUE)`,
    [uploadId, workspaceId, owner.id, bytes.length, Buffer.from(bytes)],
  );
  const xlsxId = randomUUID();
  const xlsx: Dataset = {
    id: xlsxId,
    name: "Portable XLSX",
    source: {
      kind: "xlsx",
      fileName: "team.xlsx",
      sheetName: "Tasks",
      headerRow: 1,
      startColumn: 1,
      endColumn: 2,
      endRow: 2,
    },
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["Todo", "Done"],
      },
    ],
    mapping: { title: "title", status: "status" },
    records: [
      {
        id: "xlsx-record",
        revision: 1,
        sourceRow: 2,
        values: { title: "Updated", status: "Done" },
      },
    ],
    revision: 1,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: new Date().toISOString(),
    completedStatuses: ["Done"],
  };
  const googleId = "google-1f3a5c7e9b2d4f6a";
  const google: Dataset = {
    id: googleId,
    name: "Portable Google",
    source: {
      kind: "google",
      spreadsheetId: "spreadsheet-id",
      sheetName: "Tasks",
      sourceColumns: { key: "A", title: "B" },
      connectedBy: owner.id,
    },
    fields: [
      { key: "key", label: "Key", type: "text" },
      { key: "title", label: "Title", type: "text" },
    ],
    mapping: { title: "title", identity: "key" },
    records: [
      {
        id: "google-record",
        revision: 0,
        sourceRow: 2,
        values: { key: "source-key", title: "Google row" },
        sourceValues: { title: "09/07/2026" },
      },
    ],
    revision: 0,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: new Date().toISOString(),
    completedStatuses: [],
  };
  await db.query(
    `INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, source_upload_id, created_by)
     VALUES ($1, $2, $3, 1, 'xlsx', $4, $5), ($6, $2, $7, 0, 'google', NULL, $5)`,
    [
      xlsxId,
      workspaceId,
      JSON.stringify(xlsx),
      uploadId,
      owner.id,
      googleId,
      JSON.stringify(google),
    ],
  );
  await db.query(
    `INSERT INTO dataset_changes (id, dataset_id, operation_id, actor_id, entry, record, dataset_revision)
     VALUES ($1, $2, 'portable-change', $3, $4, $5, 1)`,
    [
      randomUUID(),
      xlsxId,
      owner.id,
      JSON.stringify({
        id: "portable-change",
        operationId: "portable-change",
        recordId: "xlsx-record",
        actor: owner.id,
        at: new Date().toISOString(),
        before: { title: "Draft" },
        after: { title: "Updated" },
        revision: 1,
      }),
      JSON.stringify(xlsx.records[0]),
    ],
  );
  await db.query(
    "INSERT INTO google_credentials (user_id, encrypted_payload, expires_at, updated_at) VALUES ($1, 'credential-must-not-export', NOW(), NOW())",
    [owner.id],
  );
}

beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  for (const user of [owner, stranger])
    await db.query(
      'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
      [user.id, user.id, user.email],
    );
  app = Fastify({ bodyLimit: 45 * 1024 * 1024 });
  app.setErrorHandler(
    (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError)
        return reply
          .status(error.statusCode)
          .send({ code: error.code, message: error.message });
      return reply.status(500).send({ code: "INTERNAL_ERROR" });
    },
  );
  registerPortability(app, {
    db: db as unknown as SqlClient,
    currentUser,
    workspaceAccess,
  });
  await app.ready();
  await seedWorkspace();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

describe("workspace portability", () => {
  it("exports verified snapshots/uploads/history and restores them into a new isolated workspace", async () => {
    const exported = await requestAs(
      owner,
      `/api/workspaces/${workspaceId}/export`,
    );
    expect(exported.statusCode).toBe(200);
    const archive = exported.json();
    expect(archive).toMatchObject({
      version: 1,
      workspace: { name: "Portable source" },
    });
    expect(archive.datasets).toHaveLength(2);
    expect(archive.uploads).toHaveLength(1);
    expect(
      archive.datasets.find(
        (dataset: { snapshot: { source: { kind: string } } }) =>
          dataset.snapshot.source.kind === "xlsx",
      ).changes,
    ).toHaveLength(1);
    expect(
      archive.datasets.find(
        (dataset: { snapshot: { source: { kind: string } } }) =>
          dataset.snapshot.source.kind === "google",
      ).id,
    ).toBe("google-1f3a5c7e9b2d4f6a");
    expect(JSON.stringify(archive)).not.toContain("credential-must-not-export");
    const restored = await requestAs(owner, "/api/workspaces/restore", {
      method: "POST",
      payload: { archive, newWorkspaceName: "Restored copy" },
    });
    expect(restored.statusCode).toBe(200);
    const copy = restored.json() as {
      id: string;
      datasetCount: number;
      uploadCount: number;
    };
    expect(copy.id).not.toBe(workspaceId);
    expect(copy).toMatchObject({ datasetCount: 2, uploadCount: 1 });
    expect(
      (
        await db.query("SELECT id FROM datasets WHERE workspace_id = $1", [
          copy.id,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await db.query("SELECT id FROM uploads WHERE workspace_id = $1", [
          copy.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT id FROM dataset_changes WHERE dataset_id IN (SELECT id FROM datasets WHERE workspace_id = $1)",
          [copy.id],
        )
      ).rowCount,
    ).toBe(1);
    const restoredChange = await db.query<{
      id: string;
      operation_id: string;
      entry: { id: string; operationId: string };
    }>(
      "SELECT id, operation_id, entry FROM dataset_changes WHERE dataset_id IN (SELECT id FROM datasets WHERE workspace_id = $1)",
      [copy.id],
    );
    expect(restoredChange.rows[0]).toMatchObject({
      operation_id: "portable-change",
      entry: { id: "portable-change", operationId: "portable-change" },
    });
    expect(restoredChange.rows[0]?.id).not.toBe("portable-change");
    const restoredGoogle = await db.query<{ snapshot: Dataset }>(
      "SELECT snapshot FROM datasets WHERE workspace_id = $1 AND source_kind = 'google'",
      [copy.id],
    );
    expect(restoredGoogle.rows[0]?.snapshot.source).toMatchObject({
      kind: "google",
      readOnly: true,
      readOnlyReason: expect.stringContaining("disconnected"),
    });
    expect(restoredGoogle.rows[0]?.snapshot.source.connectedBy).toBeUndefined();
  });

  it("rejects history whose entry does not prove the recorded operation and record", async () => {
    const exported = await requestAs(
      owner,
      `/api/workspaces/${workspaceId}/export`,
    );
    const archive = exported.json();
    const xlsx = archive.datasets.find(
      (dataset: { snapshot: { source: { kind: string } } }) =>
        dataset.snapshot.source.kind === "xlsx",
    );
    xlsx.changes[0].entry.recordId = "other-record";
    const restored = await requestAs(owner, "/api/workspaces/restore", {
      method: "POST",
      payload: { archive },
    });
    expect(restored.statusCode).toBe(422);
    expect(restored.json().code).toBe("INVALID_PORTABLE_ARCHIVE");
    expect((await db.query("SELECT id FROM workspaces")).rowCount).toBe(1);
  });

  it("blocks a non-member from another tenant from exporting the workspace", async () => {
    const response = await requestAs(
      stranger,
      `/api/workspaces/${workspaceId}/export`,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN");
  });

  it("requires the exact owner workspace name and deletes only after that confirmation", async () => {
    const wrong = await requestAs(owner, `/api/workspaces/${workspaceId}`, {
      method: "DELETE",
      payload: { confirmName: "portable source" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(
      (await db.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId]))
        .rowCount,
    ).toBe(1);
    const deleted = await requestAs(owner, `/api/workspaces/${workspaceId}`, {
      method: "DELETE",
      payload: { confirmName: "Portable source" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      (await db.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT id FROM datasets WHERE workspace_id = $1", [
          workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
  });
});
