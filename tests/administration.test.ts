import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Dataset, Role } from "../packages/core/src/index.ts";
import type { SqlClient } from "../apps/server/src/db.ts";
import { HttpError, forbidden } from "../apps/server/src/errors.ts";
import {
  DELETED_ACTOR_ID,
  prepareAccountErasure,
  registerAdministration,
} from "../apps/server/src/administration.ts";
import { passwordResetEnabled } from "../apps/server/src/auth.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { createServer } from "../apps/server/src/server.ts";

const people = {
  owner: {
    id: "admin-owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
  },
  editor: {
    id: "admin-editor",
    name: "Editor",
    email: "editor@example.test",
    emailVerified: true,
  },
  viewer: {
    id: "admin-viewer",
    name: "Viewer",
    email: "viewer@example.test",
    emailVerified: true,
  },
  outsider: {
    id: "admin-outsider",
    name: "Outsider",
    email: "outsider@example.test",
    emailVerified: true,
  },
  erased: {
    id: "admin-erased",
    name: "Erase me",
    email: "erase@example.test",
    emailVerified: true,
  },
};

let db: PGlite;
let app: ReturnType<typeof Fastify>;
let workspaceId: string;
let emitted: Array<{ datasetId: string; payload: unknown }>;

function userFor(request: FastifyRequest) {
  const id = request.headers["x-test-user"];
  for (const person of Object.values(people))
    if (person.id === id) return Promise.resolve(person);
  throw new HttpError(401, "UNAUTHENTICATED", "Sign in is required.");
}

async function workspaceAccess(
  request: FastifyRequest,
  workspace: string,
  write = false,
  ownerOnly = false,
) {
  const user = await userFor(request);
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
  person: (typeof people)[keyof typeof people],
  url: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; payload?: unknown } = {},
) {
  return app.inject({
    method: options.method ?? "GET",
    url,
    headers: { "x-test-user": person.id },
    payload: options.payload,
  });
}

async function addMember(
  userId: string,
  role: Role,
  targetWorkspace = workspaceId,
) {
  await db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [targetWorkspace, userId, role],
  );
}

function datasetSnapshot(
  id: string,
  name: string,
  source: Dataset["source"],
): Dataset {
  return {
    id,
    name,
    source,
    fields: [{ key: "title", label: "Title", type: "text" }],
    mapping: { title: "title" },
    records: [],
    revision: 0,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: new Date().toISOString(),
    completedStatuses: [],
  };
}

async function seedDataset(
  name: string,
  source: Dataset["source"],
  options: { creator?: string; uploadId?: string | null } = {},
) {
  const id = randomUUID();
  const snapshot = datasetSnapshot(id, name, source);
  await db.query(
    `INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, source_upload_id, created_by)
     VALUES ($1, $2, $3, 0, $4, $5, $6)`,
    [
      id,
      workspaceId,
      JSON.stringify(snapshot),
      source.kind,
      options.uploadId ?? null,
      options.creator ?? people.owner.id,
    ],
  );
  return { id, snapshot };
}

async function seedUpload(ownerId = people.owner.id) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO uploads (id, workspace_id, uploader_id, file_name, mime_type, byte_count, content, inspection, storage_consent)
     VALUES ($1, $2, $3, 'source.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 4, $4, '{}'::jsonb, TRUE)`,
    [id, workspaceId, ownerId, Buffer.from([1, 2, 3, 4])],
  );
  return id;
}

beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  for (const person of Object.values(people))
    await db.query(
      'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
      [person.id, person.name, person.email],
    );
  workspaceId = randomUUID();
  await db.query(
    "INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Administration space', $2)",
    [workspaceId, people.owner.id],
  );
  await addMember(people.owner.id, "owner");
  await addMember(people.editor.id, "editor");
  await addMember(people.viewer.id, "viewer");
  emitted = [];
  app = Fastify();
  app.setErrorHandler(
    (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError)
        return reply.status(error.statusCode).send({
          code: error.code,
          message: error.message,
        });
      return reply.status(500).send({
        code: "INTERNAL_ERROR",
        message: error.message,
      });
    },
  );
  registerAdministration(app, db as unknown as SqlClient, {
    currentUser: userFor,
    workspaceAccess,
    deleteCurrentAccount: async (_request, password) => ({
      success: true,
      passwordWasSupplied: Boolean(password),
    }),
    emitDataset: (datasetId, payload) => emitted.push({ datasetId, payload }),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

describe("workspace member administration", () => {
  it("limits the member list and mutations to owners and rejects a revoked member", async () => {
    const outsider = await requestAs(
      people.outsider,
      `/api/workspaces/${workspaceId}/members`,
    );
    expect(outsider.statusCode).toBe(403);
    const viewer = await requestAs(
      people.viewer,
      `/api/workspaces/${workspaceId}/members/${people.editor.id}`,
      { method: "PATCH", payload: { role: "viewer" } },
    );
    expect(viewer.statusCode).toBe(403);
    const list = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/members`,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: people.owner.id, role: "owner" }),
        expect.objectContaining({ id: people.editor.id, role: "editor" }),
      ]),
    );
    const removed = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/members/${people.viewer.id}`,
      { method: "DELETE" },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const revoked = await requestAs(
      people.viewer,
      `/api/workspaces/${workspaceId}/members`,
    );
    expect(revoked.statusCode).toBe(403);
  });

  it("serializes concurrent last-owner role changes", async () => {
    await db.query(
      "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, people.editor.id],
    );
    const [owner, editor] = await Promise.all([
      requestAs(
        people.owner,
        `/api/workspaces/${workspaceId}/members/${people.owner.id}`,
        { method: "PATCH", payload: { role: "editor" } },
      ),
      requestAs(
        people.editor,
        `/api/workspaces/${workspaceId}/members/${people.editor.id}`,
        { method: "PATCH", payload: { role: "editor" } },
      ),
    ]);
    expect([owner.statusCode, editor.statusCode].sort()).toEqual([200, 409]);
    const owners = await db.query<{ user_id: string }>(
      "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
      [workspaceId],
    );
    expect(owners.rows).toHaveLength(1);
  });
});

describe("dataset deletion", () => {
  it("retains a source upload while another dataset version still references it", async () => {
    const uploadId = await seedUpload();
    const deleting = await seedDataset(
      "Delete after confirmation",
      {
        kind: "xlsx",
        fileName: "source.xlsx",
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 1,
        endRow: 1,
      },
      { uploadId },
    );
    const historyAnchor = await seedDataset(
      "Historical upload reference",
      { kind: "demo" },
      { uploadId },
    );
    // The version trigger retained the original upload reference. The current
    // row no longer needs it, which makes the version check the only guard.
    await db.query(
      "UPDATE datasets SET source_upload_id = NULL WHERE id = $1",
      [historyAnchor.id],
    );
    const removed = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/datasets/${deleting.id}`,
      { method: "DELETE", payload: { confirmName: deleting.snapshot.name } },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().sourceUploadRemoved).toBe(false);
    expect(
      (
        await db.query(
          "SELECT dataset_id FROM dataset_versions WHERE dataset_id = $1 AND source_upload_id = $2",
          [historyAnchor.id, uploadId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query("SELECT id FROM uploads WHERE id = $1", [uploadId])
      ).rows,
    ).toHaveLength(1);
  });

  it("removes an otherwise orphaned original upload retained only by the deleted dataset's old revision", async () => {
    const originalUploadId = await seedUpload();
    const currentUploadId = await seedUpload();
    const reimported = await seedDataset(
      "Re-imported source",
      {
        kind: "xlsx",
        fileName: "source.xlsx",
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 1,
        endRow: 1,
      },
      { uploadId: originalUploadId },
    );
    // Revision 0 retains the original upload; this current re-import writes a
    // different upload and creates revision 1 through the database trigger.
    await db.query(
      "UPDATE datasets SET snapshot = $1, revision = 1, source_upload_id = $2 WHERE id = $3",
      [
        JSON.stringify({
          ...reimported.snapshot,
          revision: 1,
          updatedAt: new Date().toISOString(),
        }),
        currentUploadId,
        reimported.id,
      ],
    );
    const removed = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/datasets/${reimported.id}`,
      { method: "DELETE", payload: { confirmName: reimported.snapshot.name } },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().sourceUploadRemoved).toBe(true);
    for (const uploadId of [originalUploadId, currentUploadId])
      expect(
        (await db.query("SELECT id FROM uploads WHERE id = $1", [uploadId]))
          .rows,
      ).toHaveLength(0);
  });

  it("requires exact dataset confirmation, deletes only local data, and removes an unused upload", async () => {
    const uploadId = await seedUpload();
    const first = await seedDataset(
      "Quarterly source",
      {
        kind: "xlsx",
        fileName: "source.xlsx",
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 1,
        endRow: 1,
      },
      { uploadId },
    );
    const second = await seedDataset(
      "Second local copy",
      {
        kind: "xlsx",
        fileName: "source.xlsx",
        sheetName: "Tasks",
        headerRow: 1,
        startColumn: 1,
        endColumn: 1,
        endRow: 1,
      },
      { uploadId },
    );
    const mismatch = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/datasets/${first.id}`,
      { method: "DELETE", payload: { confirmName: "quarterly source" } },
    );
    expect(mismatch.statusCode).toBe(400);
    const firstDelete = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/datasets/${first.id}`,
      { method: "DELETE", payload: { confirmName: first.snapshot.name } },
    );
    expect(firstDelete.statusCode, firstDelete.body).toBe(200);
    expect(firstDelete.json().sourceUploadRemoved).toBe(false);
    expect(
      (
        await db.query("SELECT id FROM uploads WHERE id = $1", [uploadId])
      ).rows,
    ).toHaveLength(1);
    const secondDelete = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/datasets/${second.id}`,
      { method: "DELETE", payload: { confirmName: second.snapshot.name } },
    );
    expect(secondDelete.statusCode, secondDelete.body).toBe(200);
    expect(secondDelete.json().sourceUploadRemoved).toBe(true);
    expect(
      (
        await db.query("SELECT id FROM uploads WHERE id = $1", [uploadId])
      ).rows,
    ).toHaveLength(0);
    expect(emitted.map((event) => event.datasetId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("does not require or invoke a Google source to delete its local dataset", async () => {
    const google = await seedDataset("Google mirror", {
      kind: "google",
      spreadsheetId: "never-contacted-sheet",
      sheetName: "Tasks",
    });
    await db.query(
      "INSERT INTO google_credentials (user_id, encrypted_payload, expires_at, updated_at) VALUES ($1, 'untouched', NOW(), NOW())",
      [people.owner.id],
    );
    const removed = await requestAs(
      people.owner,
      `/api/workspaces/${workspaceId}/datasets/${google.id}`,
      { method: "DELETE", payload: { confirmName: google.snapshot.name } },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      (
        await db.query("SELECT user_id FROM google_credentials WHERE user_id = $1", [
          people.owner.id,
        ])
      ).rows,
    ).toHaveLength(1);
  });
});

describe("account erasure preparation", () => {
  it("blocks a sole owner before anonymizing anything", async () => {
    const ownedWorkspace = randomUUID();
    await db.query(
      "INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Must transfer', $2)",
      [ownedWorkspace, people.erased.id],
    );
    await addMember(people.erased.id, "owner", ownedWorkspace);
    await expect(
      prepareAccountErasure(db as unknown as SqlClient, people.erased.id),
    ).rejects.toMatchObject({ code: "ACCOUNT_HAS_SOLE_OWNER_WORKSPACE" });
    expect(
      (
        await db.query(
          "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
          [ownedWorkspace, people.erased.id],
        )
    ).rows,
    ).toHaveLength(1);
  });

  it("scrubs a historical Google credential reference after membership was already revoked", async () => {
    const archived = await seedDataset(
      "Historical credential reference",
      {
        kind: "google",
        spreadsheetId: "history-only-sheet",
        sheetName: "Tasks",
        connectedBy: people.erased.id,
      } as Dataset["source"],
    );
    // The stored current snapshot no longer has a connection. Its revision-0
    // history intentionally still does, which is the erasure boundary this
    // test protects even though the account has no active membership.
    await db.query("UPDATE datasets SET snapshot = $1 WHERE id = $2", [
      JSON.stringify(
        datasetSnapshot(archived.id, archived.snapshot.name, { kind: "demo" }),
      ),
      archived.id,
    ]);

    await prepareAccountErasure(db as unknown as SqlClient, people.erased.id);

    const version = await db.query<{ snapshot: Dataset }>(
      "SELECT snapshot FROM dataset_versions WHERE dataset_id = $1 AND revision = 0",
      [archived.id],
    );
    const source = version.rows[0].snapshot.source as Dataset["source"] & {
      connectedBy?: string;
      readOnly?: boolean;
    };
    expect(source.connectedBy).toBeUndefined();
    expect(source.readOnly).toBe(true);
  });

  it("retains team data while removing membership and all personal attribution needed for a raw auth delete", async () => {
    await addMember(people.erased.id, "owner");
    await db.query(
      "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, people.editor.id],
    );
    await db.query("UPDATE workspaces SET created_by = $1 WHERE id = $2", [
      people.erased.id,
      workspaceId,
    ]);
    const google = await seedDataset(
      "Account-bound Google mirror",
      {
        kind: "google",
        spreadsheetId: "retained-team-data",
        sheetName: "Tasks",
        connectedBy: people.erased.id,
      } as Dataset["source"],
      { creator: people.erased.id },
    );
    await db.query(
      `INSERT INTO dataset_changes (id, dataset_id, operation_id, actor_id, entry, record, dataset_revision)
       VALUES ($1, $2, 'account-erasure-change', $3, $4, '{}'::jsonb, 0)`,
      [
        randomUUID(),
        google.id,
        people.erased.id,
        JSON.stringify({ actor: people.erased.id, operationId: "account-erasure-change" }),
      ],
    );
    await db.query(
      `INSERT INTO dataset_operations (dataset_id, operation_id, actor_id, result)
       VALUES ($1, 'account-erasure-operation', $2, '{}'::jsonb)`,
      [google.id, people.erased.id],
    );
    await db.query(
      `INSERT INTO source_operations (id, dataset_id, operation_id, actor_id, status)
       VALUES ($1, $2, 'account-erasure-source-operation', $3, 'queued')`,
      [randomUUID(), google.id, people.erased.id],
    );
    const uploadId = await seedUpload(people.erased.id);
    await db.query(
      `INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'invitee@example.test', 'viewer', 'unique-hash', $3, NOW() + INTERVAL '1 day')`,
      [randomUUID(), workspaceId, people.erased.id],
    );
    await db.query(
      'INSERT INTO verification (id, identifier, value, "expiresAt") VALUES ($1, $2, $3, NOW() + INTERVAL \'1 day\')',
      [randomUUID(), people.erased.email, people.erased.id],
    );
    await db.query(
      `INSERT INTO source_jobs (id, workspace_id, dataset_id, actor_id, operation_id, kind, payload, fingerprint)
       VALUES ($1, $2, $3, $4, 'account-erasure-job', 'patch', '{"personal":"remove"}'::jsonb, 'account-erasure-fingerprint')`,
      [randomUUID(), workspaceId, google.id, people.erased.id],
    );

    await prepareAccountErasure(db as unknown as SqlClient, people.erased.id);

    const membership = await db.query(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, people.erased.id],
    );
    expect(membership.rows).toHaveLength(0);
    const dataset = await db.query<{ snapshot: unknown; created_by: string }>(
      "SELECT snapshot, created_by FROM datasets WHERE id = $1",
      [google.id],
    );
    const source = (dataset.rows[0].snapshot as Dataset).source as Dataset["source"] & {
      connectedBy?: string;
      readOnly?: boolean;
    };
    expect(dataset.rows[0].created_by).toBe(DELETED_ACTOR_ID);
    expect(source).toMatchObject({ kind: "google", readOnly: true });
    expect(source.connectedBy).toBeUndefined();
    const historicalSources = await db.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM dataset_versions WHERE dataset_id = $1 ORDER BY revision ASC",
      [google.id],
    );
    expect(historicalSources.rows.length).toBeGreaterThan(0);
    for (const version of historicalSources.rows) {
      const historical = (version.snapshot as Dataset).source as Dataset["source"] & {
        connectedBy?: string;
        readOnly?: boolean;
      };
      expect(historical.connectedBy).toBeUndefined();
      expect(historical.readOnly).toBe(true);
    }
    const history = await db.query<{ actor_id: string; entry: { actor: string } }>(
      "SELECT actor_id, entry FROM dataset_changes WHERE dataset_id = $1",
      [google.id],
    );
    expect(history.rows[0].actor_id).toBe(DELETED_ACTOR_ID);
    expect(history.rows[0].entry.actor).toBe("Deleted account");
    for (const query of [
      "SELECT created_by AS actor FROM workspaces WHERE id = $1",
      "SELECT actor_id AS actor FROM dataset_operations WHERE dataset_id = $1",
      "SELECT actor_id AS actor FROM source_operations WHERE dataset_id = $1",
      "SELECT uploader_id AS actor FROM uploads WHERE id = $1",
      "SELECT invited_by AS actor FROM invitations WHERE workspace_id = $1",
    ]) {
      const value = await db.query<{ actor: string }>(query, [
        query.includes("uploads") ? uploadId : query.includes("dataset") ? google.id : workspaceId,
      ]);
      expect(value.rows[0].actor).toBe(DELETED_ACTOR_ID);
    }
    expect(
      (
        await db.query("SELECT id FROM verification WHERE value = $1", [
          people.erased.id,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query("SELECT id FROM source_jobs WHERE actor_id = $1", [
          people.erased.id,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(
      db.query('DELETE FROM "user" WHERE id = $1', [people.erased.id]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe("account deletion route", () => {
  it("requires exact profile confirmation and delegates password/fresh-session enforcement to Better Auth", async () => {
    const mismatch = await requestAs(people.owner, "/api/account/delete", {
      method: "POST",
      payload: {
        confirmName: people.owner.name,
        confirmEmail: "wrong@example.test",
      },
    });
    expect(mismatch.statusCode).toBe(400);
    const accepted = await requestAs(people.owner, "/api/account/delete", {
      method: "POST",
      payload: {
        confirmName: people.owner.name,
        confirmEmail: people.owner.email,
        password: "current-password-is-checked-by-better-auth",
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ success: true, passwordWasSupplied: true });
  });
});

describe("real Better Auth account deletion", () => {
  it("rejects a bad password without scrubbing, then removes auth state and scrubs team references", async () => {
    const raw = await PGlite.create();
    const wire = new PGLiteSocketServer({
      db: raw,
      host: "127.0.0.1",
      port: 0,
    });
    await wire.start();
    const pool = new Pool({
      connectionString: `postgresql://postgres@${wire.getServerConn()}/postgres`,
      max: 1,
    });
    await migrate(pool);
    const baseURL = "http://localhost:3001";
    const live = createServer({
      db: pool,
      authConfig: {
        secret: randomBytes(48).toString("base64url"),
        baseURL,
        trustedOrigins: [baseURL],
      },
      sourceWorker: false,
    });
    await live.ready();
    try {
      expect(passwordResetEnabled({})).toBe(false);
      expect(
        passwordResetEnabled({
          passwordResetWebhookURL: "https://mail.example.test/reset",
        }),
      ).toBe(true);
      const resetUnavailable = await live.inject({
        method: "POST",
        url: "/api/auth/request-password-reset",
        headers: { origin: baseURL, host: "localhost:3001" },
        payload: {
          email: "delete-real-auth@example.test",
          redirectTo: `${baseURL}/?reset-password=1`,
        },
      });
      expect(resetUnavailable.statusCode, resetUnavailable.body).toBe(400);
      expect(resetUnavailable.json()).toMatchObject({
        code: "RESET_PASSWORD_DISABLED",
      });

      let resetDelivery: unknown;
      const mailProvider = Fastify();
      mailProvider.post("/reset", async (request, reply) => {
        resetDelivery = request.body;
        return reply.code(204).send();
      });
      await mailProvider.listen({ host: "127.0.0.1", port: 0 });
      const providerAddress = mailProvider.server.address();
      if (!providerAddress || typeof providerAddress === "string")
        throw new Error("The local reset-delivery test server did not start.");
      const configuredReset = createServer({
        db: pool,
        authConfig: {
          secret: randomBytes(48).toString("base64url"),
          baseURL,
          trustedOrigins: [baseURL],
          passwordResetWebhookURL: `http://127.0.0.1:${providerAddress.port}/reset`,
        },
        sourceWorker: false,
      });
      await configuredReset.ready();
      try {
        expect((await configuredReset.inject({ url: "/api/config" })).json()).toMatchObject({
          passwordResetEnabled: true,
        });
        const resetUser = await configuredReset.inject({
          method: "POST",
          url: "/api/auth/sign-up/email",
          headers: { origin: baseURL, host: "localhost:3001" },
          payload: {
            name: "Reset callback tester",
            email: "reset-callback@example.test",
            password: "Test-only-reset-password-19182",
          },
        });
        expect(resetUser.statusCode, resetUser.body).toBe(200);
        const resetRequested = await configuredReset.inject({
          method: "POST",
          url: "/api/auth/request-password-reset",
          headers: { origin: baseURL, host: "localhost:3001" },
          payload: {
            email: "reset-callback@example.test",
            redirectTo: `${baseURL}/?reset-password=1`,
          },
        });
        expect(resetRequested.statusCode, resetRequested.body).toBe(200);
        expect(resetDelivery).toMatchObject({
          type: "sheet-workbench.reset-password",
          user: { email: "reset-callback@example.test" },
        });
        expect(
          (resetDelivery as { resetUrl: string }).resetUrl,
        ).toContain(`${baseURL}/api/auth/reset-password/`);
      } finally {
        await configuredReset.close();
        await mailProvider.close();
      }

      const name = "Real deletion tester";
      const email = "delete-real-auth@example.test";
      const password = "Test-only-current-password-48151";
      const signup = await live.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { origin: baseURL, host: "localhost:3001" },
        payload: { name, email, password },
      });
      expect(signup.statusCode, signup.body).toBe(200);
      const userId = signup.json().user.id as string;
      const cookie = (
        Array.isArray(signup.headers["set-cookie"])
          ? signup.headers["set-cookie"]
          : [signup.headers["set-cookie"]]
      )
        .filter(Boolean)
        .map((value) => String(value).split(";")[0])
        .join("; ");
      expect(cookie).toContain("session_token");
      const headers = { cookie, origin: baseURL, host: "localhost:3001" };
      const workspace = await live.inject({
        method: "POST",
        url: "/api/workspaces",
        headers,
        payload: { name: "Retained team workspace" },
      });
      expect(workspace.statusCode, workspace.body).toBe(200);
      const liveWorkspaceId = workspace.json().id as string;
      const remainingOwner = "remaining-owner";
      await pool.query(
        'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
        [remainingOwner, "Remaining owner", "remaining-owner@example.test"],
      );
      await pool.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [liveWorkspaceId, remainingOwner],
      );
      const datasetId = randomUUID();
      const snapshot = datasetSnapshot(datasetId, "Retained Google dataset", {
        kind: "google",
        spreadsheetId: "never-contacted-sheet",
        sheetName: "Tasks",
        connectedBy: userId,
      } as Dataset["source"]);
      await pool.query(
        `INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, created_by)
         VALUES ($1, $2, $3, 0, 'google', $4)`,
        [datasetId, liveWorkspaceId, JSON.stringify(snapshot), userId],
      );
      await pool.query(
        `INSERT INTO dataset_changes (id, dataset_id, operation_id, actor_id, entry, record, dataset_revision)
         VALUES ($1, $2, 'real-delete-change', $3, $4, '{}'::jsonb, 0)`,
        [
          randomUUID(),
          datasetId,
          userId,
          JSON.stringify({ actor: userId, operationId: "real-delete-change" }),
        ],
      );

      const wrongPassword = await live.inject({
        method: "POST",
        url: "/api/account/delete",
        headers,
        payload: { confirmName: name, confirmEmail: email, password: "wrong" },
      });
      expect(wrongPassword.statusCode, wrongPassword.body).toBe(400);
      expect(
        (await pool.query('SELECT id FROM "user" WHERE id = $1', [userId]))
          .rows,
      ).toHaveLength(1);
      const unsanitized = await pool.query<{ snapshot: Dataset }>(
        "SELECT snapshot FROM datasets WHERE id = $1",
        [datasetId],
      );
      expect(
        (unsanitized.rows[0].snapshot.source as Dataset["source"] & {
          connectedBy?: string;
        }).connectedBy,
      ).toBe(userId);

      const deleted = await live.inject({
        method: "POST",
        url: "/api/account/delete",
        headers,
        payload: { confirmName: name, confirmEmail: email, password },
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(
        (await pool.query('SELECT id FROM "user" WHERE id = $1', [userId]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await pool.query('SELECT id FROM "session" WHERE "userId" = $1', [userId]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await pool.query('SELECT id FROM account WHERE "userId" = $1', [userId]))
          .rows,
      ).toHaveLength(0);
      const scrubbed = await pool.query<{
        snapshot: Dataset;
        created_by: string;
      }>("SELECT snapshot, created_by FROM datasets WHERE id = $1", [datasetId]);
      const source = scrubbed.rows[0].snapshot.source as Dataset["source"] & {
        connectedBy?: string;
        readOnly?: boolean;
      };
      expect(scrubbed.rows[0].created_by).toBe(DELETED_ACTOR_ID);
      expect(source.connectedBy).toBeUndefined();
      expect(source.readOnly).toBe(true);
      const change = await pool.query<{
        actor_id: string;
        entry: { actor: string };
      }>("SELECT actor_id, entry FROM dataset_changes WHERE dataset_id = $1", [
        datasetId,
      ]);
      expect(change.rows[0]).toEqual({
        actor_id: DELETED_ACTOR_ID,
        entry: { actor: "Deleted account", operationId: "real-delete-change" },
      });
    } finally {
      await live.close();
      await pool.end();
      await wire.stop();
      await raw.close();
    }
  }, 30000);
});
