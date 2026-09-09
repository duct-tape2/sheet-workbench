import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Dataset } from "../packages/core/src/types.ts";
import type { SqlClient } from "../apps/server/src/db.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { createServer } from "../apps/server/src/server.ts";
import type {
  GoogleSheetsConnector,
  GoogleSheetsReader,
} from "../apps/server/src/google.ts";

let db: PGlite;
let app: ReturnType<typeof createServer>;
let fresh: Dataset;
let enable: ReturnType<typeof vi.fn>;
const user = {
  id: "preview-owner",
  email: "preview@example.test",
  emailVerified: true,
};
const base =
  "/api/workspaces/preview-workspace/datasets/preview-dataset/google";
function sample(): Dataset {
  return {
    id: "preview-dataset",
    name: "Reviewed source",
    revision: 0,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: "2026-09-08T00:00:00.000Z",
    completedStatuses: [],
    source: {
      kind: "google",
      spreadsheetId: "preview-sheet",
      sheetId: 0,
      sheetName: "Tasks",
      headerRow: 1,
      startColumn: 1,
      endColumn: 1,
      endRow: 2,
      sourceColumns: { title: "A" },
      sourceHeaders: { title: "Task" },
      readOnly: true,
      readOnlyReason: "Row identity requires review.",
      connectedBy: user.id,
    },
    fields: [{ key: "title", label: "Task", type: "text" }],
    mapping: { title: "title" },
    records: [
      {
        id: "google-row-0-2",
        revision: 0,
        sourceRow: 2,
        values: { title: "Reviewed row" },
      },
    ],
  };
}
beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  await db.query(
    'INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,$1,$2,TRUE)',
    [user.id, user.email],
  );
  await db.query(
    "INSERT INTO workspaces(id,name,created_by) VALUES ('preview-workspace','Preview',$1)",
    [user.id],
  );
  await db.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ('preview-workspace',$1,'owner')",
    [user.id],
  );
  await db.query(
    "INSERT INTO datasets(id,workspace_id,snapshot,source_kind,created_by) VALUES ('preview-dataset','preview-workspace',$1,'google',$2)",
    [JSON.stringify(sample()), user.id],
  );
  fresh = sample();
  enable = vi.fn(async (dataset: Dataset) => ({
    source: { ...dataset.source, readOnly: false },
    records: dataset.records.map((r) => ({
      ...r,
      sourceIdentity: `record:${r.id}`,
    })),
    replayed: false,
  }));
  app = createServer({
    db: db as unknown as SqlClient,
    sessionResolver: async () => user,
    sourceWorker: false,
    google: {
      reader: {
        importSelection: async () => ({
          dataset: structuredClone(fresh),
          readOnly: true,
        }),
      } as unknown as GoogleSheetsReader,
      connector: {
        enableMetadataIdentity: enable,
      } as unknown as GoogleSheetsConnector,
    },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await db.close();
});

it("previews without writes and requires the exact fresh preview before enabling", async () => {
  const preview = await app.inject({
    method: "GET",
    url: `${base}/identity-preview`,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json().added).toBe(1);
  expect(enable).not.toHaveBeenCalled();
  const missing = await app.inject({
    method: "POST",
    url: `${base}/identity`,
    payload: { operationId: "identity_preview_001", consent: true },
  });
  expect(missing.statusCode).toBe(400);
  const accepted = await app.inject({
    method: "POST",
    url: `${base}/identity`,
    payload: {
      operationId: "identity_preview_001",
      consent: true,
      previewFingerprint: preview.json().fingerprint,
    },
  });
  expect(accepted.statusCode).toBe(200);
  expect(enable).toHaveBeenCalledTimes(1);
  expect(accepted.json().revision).toBe(1);
  expect(accepted.json().records[0].sourceIdentity).toBe(
    "record:google-row-0-2",
  );
  const versions = await db.query(
    "SELECT revision FROM dataset_versions WHERE dataset_id='preview-dataset' ORDER BY revision",
  );
  expect(versions.rows).toEqual([{ revision: 0 }, { revision: 1 }]);
});

it("rejects changed source content after preview without any metadata write", async () => {
  const preview = await app.inject({
    method: "GET",
    url: `${base}/identity-preview`,
  });
  fresh.records[0].values.title = "Externally changed after review";
  const result = await app.inject({
    method: "POST",
    url: `${base}/identity`,
    payload: {
      operationId: "identity_preview_002",
      consent: true,
      previewFingerprint: preview.json().fingerprint,
    },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe("GOOGLE_IDENTITY_PREVIEW_STALE");
  expect(enable).not.toHaveBeenCalled();
  expect(
    (await db.query("SELECT revision FROM datasets WHERE id='preview-dataset'"))
      .rows[0],
  ).toEqual({ revision: 0 });
});

it("blocks viewer consent and prevents identity changes during pending source saves", async () => {
  const preview = await app.inject({
    method: "GET",
    url: `${base}/identity-preview`,
  });
  const payload = {
    operationId: "identity_preview_003",
    consent: true,
    previewFingerprint: preview.json().fingerprint,
  };
  await db.query("UPDATE workspace_members SET role='viewer'");
  expect(
    (await app.inject({ method: "GET", url: `${base}/identity-preview` }))
      .statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: "POST", url: `${base}/identity`, payload }))
      .statusCode,
  ).toBe(403);
  await db.query("UPDATE workspace_members SET role='owner'");
  await db.query(
    "INSERT INTO source_jobs(id,workspace_id,dataset_id,actor_id,operation_id,kind,payload,fingerprint) VALUES ('pending','preview-workspace','preview-dataset',$1,'pending-op','patch','{}','test')",
    [user.id],
  );
  expect(
    (await app.inject({ method: "POST", url: `${base}/identity`, payload }))
      .statusCode,
  ).toBe(409);
  expect(enable).not.toHaveBeenCalled();
});
