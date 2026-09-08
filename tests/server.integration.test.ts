import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { InjectOptions } from "light-my-request";
import type { Dataset } from "../packages/core/src/types.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { createServer } from "../apps/server/src/server.ts";
import type { SqlClient } from "../apps/server/src/db.ts";

let db: PGlite;
let app: ReturnType<typeof createServer>;

const owner = {
  id: "user-owner",
  email: "owner@example.test",
  emailVerified: true,
};
const editor = {
  id: "user-editor",
  email: "editor@example.test",
  emailVerified: true,
};
const viewer = {
  id: "user-viewer",
  email: "viewer@example.test",
  emailVerified: true,
};

async function insertUser(user: typeof owner): Promise<void> {
  await db.query(
    'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)',
    [user.id, user.id, user.email, user.emailVerified],
  );
}

function requestAs(
  user: typeof owner,
  path: string,
  options: Pick<InjectOptions, "method" | "headers" | "payload"> = {},
) {
  const request: InjectOptions = {
    method: options.method ?? "GET",
    url: path,
    headers: { "x-test-user": user.id, ...(options.headers ?? {}) },
    payload: options.payload,
  };
  return app.inject(request);
}

async function workspaceFor(user = owner): Promise<string> {
  const response = await requestAs(user, "/api/workspaces", {
    method: "POST",
    payload: { name: "Test workspace" },
  });
  expect(response.statusCode).toBe(200);
  return response.json().id as string;
}

async function seedDataset(
  workspaceId: string,
): Promise<{ id: string; recordId: string }> {
  const id = randomUUID();
  // XLSX imports use deterministic non-UUID IDs. Exercise the same server
  // patch/undo validators rather than masking them with a UUID-only fixture.
  const recordId = `xlsx-${randomUUID().replaceAll("-", "")}`;
  const dataset: Dataset = {
    id,
    name: "Roadmap",
    source: {
      kind: "xlsx",
      fileName: "roadmap.xlsx",
      sheetName: "Sheet1",
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
        id: recordId,
        revision: 0,
        values: { title: "Draft", status: "Todo" },
        sourceRow: 2,
      },
    ],
    revision: 0,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: new Date().toISOString(),
    completedStatuses: ["Done"],
  };
  await db.query(
    "INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, created_by) VALUES ($1, $2, $3, 0, 'xlsx', $4)",
    [id, workspaceId, JSON.stringify(dataset), owner.id],
  );
  return { id, recordId };
}

beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  await insertUser(owner);
  await insertUser(editor);
  await insertUser(viewer);
  app = createServer({
    db: db as unknown as SqlClient,
    sessionResolver: async (request) => {
      const id = request.headers["x-test-user"];
      if (id === owner.id) return owner;
      if (id === editor.id) return editor;
      if (id === viewer.id) return viewer;
      return null;
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

describe("server workspace and dataset isolation", () => {
  it("fails closed without a database while still exposing configuration", async () => {
    const noDatabase = createServer();
    await noDatabase.ready();
    const config = await noDatabase.inject("/api/config");
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      teamMode: false,
      googleEnabled: false,
    });
    const workspaces = await noDatabase.inject("/api/workspaces");
    expect(workspaces.statusCode).toBe(503);
    expect(workspaces.json().code).toBe("DATABASE_UNAVAILABLE");
    await noDatabase.close();
  });

  it("enforces member roles and retries a record patch idempotently", async () => {
    const workspaceId = await workspaceFor();
    const { id: datasetId, recordId } = await seedDataset(workspaceId);
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')",
      [workspaceId, editor.id, viewer.id],
    );

    const patch = {
      operationId: `patch_${randomUUID()}`,
      recordId,
      baseRevision: 0,
      changes: { title: "Ready" },
    };
    const first = await requestAs(
      editor,
      `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`,
      { method: "POST", payload: patch },
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      datasetRevision: 1,
      record: { revision: 1, values: { title: "Ready" } },
    });

    const repeat = await requestAs(
      editor,
      `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`,
      { method: "POST", payload: patch },
    );
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual(first.json());

    const denied = await requestAs(
      viewer,
      `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`,
      {
        method: "POST",
        payload: {
          ...patch,
          operationId: `viewer_${randomUUID()}`,
          baseRevision: 1,
        },
      },
    );
    expect(denied.statusCode).toBe(403);
  });

  it("uses the record revision as its concurrency guard", async () => {
    const workspaceId = await workspaceFor();
    const { id: datasetId, recordId } = await seedDataset(workspaceId);
    const path = `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`;
    const [left, right] = await Promise.all([
      requestAs(owner, path, {
        method: "POST",
        payload: {
          operationId: `left_${randomUUID()}`,
          recordId,
          baseRevision: 0,
          changes: { title: "First" },
        },
      }),
      requestAs(owner, path, {
        method: "POST",
        payload: {
          operationId: `right_${randomUUID()}`,
          recordId,
          baseRevision: 0,
          changes: { title: "Second" },
        },
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
  });

  it("binds invitations to the verified recipient email", async () => {
    const workspaceId = await workspaceFor();
    const invite = await requestAs(
      owner,
      `/api/workspaces/${workspaceId}/invitations`,
      {
        method: "POST",
        payload: { email: editor.email, role: "editor" },
      },
    );
    expect(invite.statusCode).toBe(200);
    const token = invite.json().token as string;

    const wrongUser = await requestAs(
      viewer,
      `/api/invitations/${token}/accept`,
      { method: "POST" },
    );
    expect(wrongUser.statusCode).toBe(403);
    const accepted = await requestAs(
      editor,
      `/api/invitations/${token}/accept`,
      { method: "POST" },
    );
    expect(accepted.statusCode).toBe(200);
    const replay = await requestAs(editor, `/api/invitations/${token}/accept`, {
      method: "POST",
    });
    expect(replay.statusCode).toBe(200);
  });

  it("rejects a cookie-authenticated state change with no Origin", async () => {
    const response = await requestAs(owner, "/api/workspaces", {
      method: "POST",
      payload: { name: "blocked" },
      headers: { cookie: "better-auth.session_token=test" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("CSRF_ORIGIN_REJECTED");
  });
});
