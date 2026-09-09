import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import type { Dataset } from "../packages/core/src/types.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { createServer } from "../apps/server/src/server.ts";
import {
  GoogleSheetsConnector,
  GoogleSheetsReader,
  PostgresGoogleCredentials,
} from "../apps/server/src/google.ts";

it(
  "prepares Google credentials before max-one pg pool identity, source, and refresh transactions",
  async () => {
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
      // Old code holds this only client before the credential lookup. A short
      // timeout makes that regression fail instead of leaving the test hung.
      connectionTimeoutMillis: 500,
    });
    await migrate(pool);

    const userId = "pool-google-user";
    const workspaceId = "pool-google-workspace";
    const datasetId = "pool-google-dataset";
    const recordId = "pool-google-record";
    let refreshes = 0;
    let remoteTitle = "Before";
    let sawPreparedBearer = false;
    const oauthFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      if (url.includes("/token") && body.includes("authorization_code"))
        return new Response(
          JSON.stringify({
            access_token: "initial-expired-token",
            refresh_token: "rotating-refresh-secret",
            expires_in: 0,
          }),
        );
      if (url.includes("/token") && body.includes("refresh_token")) {
        refreshes += 1;
        return new Response(
          JSON.stringify({
            access_token: "prepared-fresh-token",
            refresh_token: "rotated-refresh-secret",
            expires_in: 3600,
          }),
        );
      }
      if (url.includes("/userinfo"))
        return new Response(JSON.stringify({ email: "pool@example.test" }));
      return new Response("unexpected OAuth request", { status: 500 });
    };
    const sheetsFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      // Do not include a token in an assertion message or test output.
      if (authorization?.startsWith("Bearer ")) sawPreparedBearer = true;
      if (url.includes("/drive/v3/files/"))
        return new Response(JSON.stringify({ capabilities: { canEdit: true } }));
      if (url.includes("includeGridData=false"))
        return new Response(
          JSON.stringify({
            properties: { title: "Pool workbook" },
            sheets: [
              { properties: { sheetId: 0, title: "Tasks", sheetType: "GRID" } },
            ],
          }),
        );
      if (url.includes("includeGridData=true")) {
        const cell = (value: string) => ({ effectiveValue: { stringValue: value } });
        return new Response(
          JSON.stringify({
            sheets: [
              {
                properties: { sheetId: 0, title: "Tasks", sheetType: "GRID" },
                data: [
                  {
                    startRow: 0,
                    startColumn: 0,
                    rowData: [
                      { values: [cell("ID"), cell("Title")] },
                      { values: [cell("remote-id"), cell(remoteTitle)] },
                    ],
                    rowMetadata: [
                      {},
                      {
                        developerMetadata: [
                          {
                            metadataId: 73,
                            metadataKey: `sheet-workbench.row.v1:${datasetId}`,
                            metadataValue: `record:${recordId}`,
                            visibility: "DOCUMENT",
                            location: {
                              locationType: "ROW",
                              dimensionRange: {
                                sheetId: 0,
                                dimension: "ROWS",
                                startIndex: 1,
                                endIndex: 2,
                              },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      }
      if (url.includes("/values:batchGet?")) {
        const option = new URL(url).searchParams.get("valueRenderOption");
        return new Response(
          JSON.stringify({
            valueRanges:
              option === "FORMULA"
                ? [{ values: [[]] }, { values: [[]] }]
                : [{ values: [["ID"]] }, { values: [["Title"]] }],
          }),
        );
      }
      if (url.includes("/developerMetadata:search"))
        return new Response(
          JSON.stringify({
            matchedDeveloperMetadata: [
              {
                developerMetadata: {
                  metadataId: 73,
                  metadataKey: `sheet-workbench.row.v1:${datasetId}`,
                  metadataValue: `record:${recordId}`,
                  visibility: "DOCUMENT",
                  location: {
                    locationType: "ROW",
                    dimensionRange: {
                      sheetId: 0,
                      dimension: "ROWS",
                      startIndex: 1,
                      endIndex: 2,
                    },
                  },
                },
              },
            ],
          }),
        );
      if (url.includes("/values:batchGetByDataFilter")) {
        const option = JSON.parse(String(init?.body)).valueRenderOption;
        return new Response(
          JSON.stringify({
            valueRanges: [
              {
                valueRange: {
                  values:
                    option === "FORMULA" ? [[]] : [["remote-id", remoteTitle]],
                },
              },
            ],
          }),
        );
      }
      if (url.includes("/values:batchUpdateByDataFilter")) {
        const body = JSON.parse(String(init?.body));
        remoteTitle = body.data[0].values[0][1];
        return new Response("{}");
      }
      return new Response("unexpected Sheets request", { status: 500 });
    };

    const credentials = new PostgresGoogleCredentials(pool, {
      clientId: "test-client",
      clientSecret: "test-secret",
      tokenEncryptionKey: "test-encryption-key",
      baseURL: "http://localhost:3001",
      fetch: oauthFetch,
    });
    const connector = new GoogleSheetsConnector(credentials, sheetsFetch);
    const reader = new GoogleSheetsReader(credentials, sheetsFetch);
    const app = createServer({
      db: pool,
      sourceWorker: false,
      sessionResolver: async () => ({
        id: userId,
        email: "pool@example.test",
        emailVerified: true,
      }),
      google: { credentials, connector, reader },
    });
    try {
      await pool.query(
        'INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,TRUE)',
        [userId, "Pool Google User", "pool@example.test"],
      );
      await pool.query(
        "INSERT INTO workspaces (id,name,created_by) VALUES ($1,$2,$3)",
        [workspaceId, "Pool Google Workspace", userId],
      );
      await pool.query(
        "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')",
        [workspaceId, userId],
      );
      const dataset: Dataset = {
        id: datasetId,
        name: "Pool Google source",
        source: {
          kind: "google",
          spreadsheetId: "pool-sheet",
          sheetId: 0,
          sheetName: "Tasks",
          headerRow: 1,
          startColumn: 1,
          endColumn: 2,
          endRow: 2,
          sourceColumns: { g_A: "A", g_B: "B" },
          sourceHeaders: { g_A: "ID", g_B: "Title" },
          connectedBy: userId,
          readOnly: true,
          readOnlyReason: "Row identity requires review.",
        },
        fields: [
          { key: "g_A", label: "ID", type: "text" },
          { key: "g_B", label: "Title", type: "text", required: true },
        ],
        mapping: { title: "g_B", identity: "g_A" },
        records: [
          {
            id: recordId,
            revision: 0,
            sourceRow: 2,
            sourceIdentity: `record:${recordId}`,
            values: { g_A: "remote-id", g_B: "Before" },
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
      await pool.query(
        "INSERT INTO datasets (id,workspace_id,snapshot,revision,source_kind,created_by) VALUES ($1,$2,$3,0,'google',$4)",
        [datasetId, workspaceId, JSON.stringify(dataset), userId],
      );
      const oauth = await credentials.begin(userId);
      await credentials.complete(userId, oauth.state, "test-code");
      await app.ready();

      const preview = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/google/identity-preview`,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const enabled = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/google/identity`,
        payload: {
          operationId: "pool_google_identity_0001",
          consent: true,
          previewFingerprint: preview.json().fingerprint,
        },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      // The initial expired credential was read and durably refreshed before
      // identity enablement acquired its transaction client.
      expect(refreshes).toBe(1);

      const response = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/patch`,
        payload: {
          operationId: "pool_google_patch_0001",
          recordId,
          baseRevision: 1,
          changes: { g_B: "After" },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(refreshes).toBe(1);
      expect(sawPreparedBearer).toBe(true);
      expect(remoteTitle).toBe("After");
      const refreshed = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${datasetId}/refresh`,
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json()).toHaveProperty("datasetRevision");
      const stored = await pool.query<{ encrypted_payload: string }>(
        "SELECT encrypted_payload FROM google_credentials WHERE user_id=$1",
        [userId],
      );
      expect(stored.rows[0]?.encrypted_payload).not.toContain(
        "prepared-fresh-token",
      );
    } finally {
      await app.close();
      await pool.end();
      await wire.stop();
      await raw.close();
    }
  },
  10_000,
);
