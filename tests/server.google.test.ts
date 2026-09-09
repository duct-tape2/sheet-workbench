import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Dataset, RecordPatch } from "../packages/core/src/types.ts";
import { migrate } from "../apps/server/src/schema.ts";
import type { SqlClient } from "../apps/server/src/db.ts";
import { createServer } from "../apps/server/src/server.ts";
import {
  GoogleSheetsConnector,
  GoogleSheetsReader,
  PostgresGoogleCredentials,
  type GoogleCredentialStore,
} from "../apps/server/src/google.ts";

let db: PGlite;
const userId = "google-user";

const credentialStore: GoogleCredentialStore = {
  enabled: () => true,
  begin: async () => ({ state: "unused", url: "https://example.test" }),
  complete: async () => undefined,
  accessToken: async () => "access-token",
};

const googleSelection = {
  spreadsheetId: "spreadsheet-1",
  sheetId: 0,
  headerRow: 1,
  startColumn: 1,
  endColumn: 3,
  endRow: 3,
  mapping: { title: "g_C", date: "g_B" },
  identityField: "g_A",
  name: "Imported roadmap",
  locale: "en" as const,
  timeZone: "UTC",
  dateOrder: "ymd" as const,
  weekStartsOn: 1 as const,
};

function gridCell(value: string | number | boolean | null, formula?: string) {
  const effectiveValue =
    value === null
      ? undefined
      : typeof value === "string"
        ? { stringValue: value }
        : typeof value === "number"
          ? { numberValue: value }
          : { boolValue: value };
  return {
    effectiveValue,
    ...(formula ? { userEnteredValue: { formulaValue: formula } } : {}),
  };
}

function readerFetch(
  rows: Array<Array<string | number | boolean | null>>,
  canEdit = true,
  formula?: { row: number; column: number; value: string },
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/drive/v3/files/"))
      return new Response(JSON.stringify({ capabilities: { canEdit } }));
    if (url.includes("includeGridData=false")) {
      return new Response(
        JSON.stringify({
          properties: { title: "Source workbook" },
          sheets: [
            { properties: { sheetId: 0, title: "Roadmap", sheetType: "GRID" } },
          ],
        }),
      );
    }
    if (url.includes("includeGridData=true")) {
      return new Response(
        JSON.stringify({
          sheets: [
            {
              data: [
                {
                  rowData: rows.map((row, rowIndex) => ({
                    values: row.map((value, columnIndex) =>
                      gridCell(
                        value,
                        formula &&
                          formula.row === rowIndex &&
                          formula.column === columnIndex
                          ? formula.value
                          : undefined,
                      ),
                    ),
                  })),
                },
              ],
            },
          ],
        }),
      );
    }
    return new Response(
      JSON.stringify({ error: { message: `Unexpected Google URL: ${url}` } }),
      { status: 500 },
    );
  };
}

beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  await db.query(
    'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
    [userId, "Google user", "google@example.test"],
  );
});

afterEach(async () => {
  await db.close();
});

describe("Google credential and writeback guards", () => {
  it("encrypts per-user OAuth credentials and refreshes them before the 60-second safety window", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (
        url.includes("/token") &&
        String(init?.body).includes("authorization_code")
      ) {
        return new Response(
          JSON.stringify({
            access_token: "initial-access",
            refresh_token: "refresh-secret",
            expires_in: 10,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/userinfo"))
        return new Response("userinfo must not be requested", { status: 500 });
      if (
        url.includes("/token") &&
        String(init?.body).includes("refresh_token")
      ) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const credentials = new PostgresGoogleCredentials(
      db as unknown as SqlClient,
      {
        clientId: "client",
        clientSecret: "secret",
        tokenEncryptionKey: "encryption-key",
        baseURL: "http://localhost:3001",
        fetch: fetchMock,
      },
    );
    const { state, url } = await credentials.begin(userId);
    expect(new URL(url).searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive.file",
    );
    await credentials.complete(userId, state, "code");
    await expect(credentials.complete(userId, state, "code")).rejects.toMatchObject({
      code: "INVALID_OAUTH_STATE",
    });
    expect(await credentials.accessToken(userId)).toBe("refreshed-access");
    expect(calls.filter((call) => call.includes("/token"))).toHaveLength(2);
    const stored = await db.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM google_credentials WHERE user_id = $1",
      [userId],
    );
    expect(stored.rows[0]?.encrypted_payload).not.toContain("initial-access");
    expect(stored.rows[0]?.encrypted_payload).not.toContain("refresh-secret");
  });

  it("imports bounded typed Google rows with stable IDs but keeps column-only writeback read-only", async () => {
    const reader = new GoogleSheetsReader(
      credentialStore,
      readerFetch([
        ["ID", "Due", "Title"],
        ["row-b", 45200, "Second"],
        ["row-a", "2024-02-29", "First"],
      ]),
    );
    const imported = await reader.importSelection(googleSelection, userId);
    expect(imported.readOnly).toBe(true);
    expect(imported.dataset.source.readOnly).toBe(true);
    expect(imported.readOnlyReason).toMatch(/metadata/i);
    expect(imported.dataset.records.map((record) => record.values.g_A)).toEqual(
      ["row-b", "row-a"],
    );
    expect(
      new Set(imported.dataset.records.map((record) => record.id)).size,
    ).toBe(2);
    expect(
      imported.dataset.records.every((record) =>
        record.id.startsWith("google-"),
      ),
    ).toBe(true);
    expect(imported.dataset.records[0]?.sourceValues).toEqual({ g_B: 45200 });
    expect(imported.dataset.records[0]?.lockedFields ?? []).not.toContain(
      "g_B",
    );
    expect(imported.dataset.records[1]?.sourceValues).toEqual({
      g_B: "2024-02-29",
    });
  });

  it("keeps formula or ambiguous date cells locked and makes no-ID and no-edit imports read-only", async () => {
    const formulaReader = new GoogleSheetsReader(
      credentialStore,
      readerFetch(
        [
          ["ID", "Due", "Title"],
          ["row-a", 45200, "First"],
        ],
        true,
        { row: 1, column: 1, value: "=TODAY()" },
      ),
    );
    const formulaDraft = await formulaReader.importSelection(
      { ...googleSelection, endRow: 2 },
      userId,
    );
    expect(formulaDraft.dataset.records[0]?.lockedFields).toContain("g_B");

    const noIdReader = new GoogleSheetsReader(
      credentialStore,
      readerFetch(
        [
          ["ID", "Due", "Title"],
          ["row-a", null, "First"],
        ],
        false,
      ),
    );
    const noIdDraft = await noIdReader.importSelection(
      {
        ...googleSelection,
        endRow: 2,
        mapping: { title: "g_C", date: "g_B" },
        identityField: undefined,
      },
      userId,
    );
    expect(noIdDraft.readOnly).toBe(true);
    expect(noIdDraft.readOnlyReason).toMatch(/unique ID/i);
    expect(noIdDraft.dataset.source.readOnly).toBe(true);
  });

  it("refreshes a read-only stable-ID source with its stored connector and rejects disconnected restores", async () => {
    const connectorUsers: string[] = [];
    const storedCredentials: GoogleCredentialStore = {
      ...credentialStore,
      accessToken: async (requestedUser) => {
        connectorUsers.push(requestedUser);
        return "access-token";
      },
    };
    const reader = new GoogleSheetsReader(
      storedCredentials,
      readerFetch(
        [
          ["ID", "Title"],
          ["row-a", "Changed remotely"],
          ["row-b", "Added remotely"],
        ],
        false,
      ),
    );
    const workspaceId = "google-refresh-workspace";
    const viewerId = "google-refresh-viewer";
    const dataset: Dataset = {
      id: "google-refresh-dataset",
      name: "Refresh source",
      source: {
        kind: "google",
        spreadsheetId: "spreadsheet-1",
        sheetId: 0,
        sheetName: "Roadmap",
        headerRow: 1,
        startColumn: 1,
        endColumn: 2,
        endRow: 3,
        sourceColumns: { g_A: "A", g_B: "B" },
        sourceHeaders: { g_A: "ID", g_B: "Title" },
        identityColumn: "A",
        connectedBy: userId,
        readOnly: true,
        readOnlyReason:
          "The connected Google account cannot edit this spreadsheet.",
      },
      fields: [
        { key: "g_A", label: "ID", type: "text" },
        { key: "g_B", label: "Title", type: "text" },
      ],
      mapping: { title: "g_B", identity: "g_A" },
      records: [
        {
          id: "google-row-a",
          revision: 0,
          sourceRow: 2,
          values: { g_A: "row-a", g_B: "Before" },
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
      "INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)",
      [workspaceId, "Refresh workspace", userId],
    );
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    );
    await db.query(
      'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, TRUE)',
      [viewerId, "Viewer", "viewer@example.test"],
    );
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [workspaceId, viewerId],
    );
    await db.query(
      "INSERT INTO datasets (id, workspace_id, snapshot, revision, source_kind, created_by) VALUES ($1, $2, $3, 0, 'google', $4)",
      [dataset.id, workspaceId, JSON.stringify(dataset), userId],
    );
    const app = createServer({
      db: db as unknown as SqlClient,
      sessionResolver: async (request) =>
        request.headers["x-test-user"] === viewerId
          ? { id: viewerId, email: "viewer@example.test", emailVerified: true }
          : { id: userId, email: "google@example.test", emailVerified: true },
      google: { credentials: storedCredentials, reader },
    });
    await app.ready();
    try {
      const refreshed = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${dataset.id}/refresh`,
        headers: { "x-test-user": viewerId },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({
        added: 1,
        updated: 1,
        removed: 0,
        changed: true,
      });
      expect(connectorUsers).toEqual([userId]);
      const stored = await db.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM datasets WHERE id = $1",
        [dataset.id],
      );
      const snapshot = stored.rows[0]?.snapshot;
      const refreshedDataset = (
        typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot
      ) as Dataset;
      expect(refreshedDataset.source.connectedBy).toBe(userId);
      expect(refreshedDataset.source.readOnly).toBe(true);
      expect(
        refreshedDataset.records.find((record) => record.values.g_A === "row-a")
          ?.values.g_B,
      ).toBe("Changed remotely");

      const disconnected = {
        ...refreshedDataset,
        source: { ...refreshedDataset.source, connectedBy: undefined },
      };
      await db.query("UPDATE datasets SET snapshot = $1 WHERE id = $2", [
        JSON.stringify(disconnected),
        dataset.id,
      ]);
      const rejected = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${dataset.id}/refresh`,
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({
        code: "GOOGLE_RECONNECT_REQUIRED",
      });
    } finally {
      await app.close();
    }
  });

  it("imports, patches, and refreshes a real Google-ID dataset through the HTTP routes", async () => {
    const rows = [{ id: "row-a", title: "Before" }];
    let writes = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/drive/v3/files/"))
        return new Response(
          JSON.stringify({ capabilities: { canEdit: true } }),
        );
      if (url.includes("includeGridData=false")) {
        return new Response(
          JSON.stringify({
            properties: { title: "Source workbook" },
            sheets: [
              {
                properties: { sheetId: 0, title: "Roadmap", sheetType: "GRID" },
              },
            ],
          }),
        );
      }
      if (url.includes("includeGridData=true")) {
        const rowData = [
          ["ID", "Title"],
          ...rows.map((row) => [row.id, row.title]),
        ].map((row) => ({ values: row.map((value) => gridCell(value)) }));
        return new Response(
          JSON.stringify({ sheets: [{ data: [{ rowData }] }] }),
        );
      }
      if (url.includes("/values/")) {
        return new Response(
          JSON.stringify({ values: [[...rows.map((row) => row.id)]] }),
        );
      }
      if (url.includes("values:batchGet")) {
        const ranges = new URL(url).searchParams.getAll("ranges");
        return new Response(
          JSON.stringify({
            valueRanges: ranges.map((range) => {
              const match = /!([AB])(\d+)$/.exec(range);
              const rowNumber = Number(match?.[2]);
              const row = match ? rows[rowNumber - 2] : undefined;
              const value =
                rowNumber === 1
                  ? match?.[1] === "A"
                    ? "ID"
                    : "Title"
                  : match?.[1] === "A"
                    ? row?.id
                    : row?.title;
              return value === undefined ? {} : { values: [[value]] };
            }),
          }),
        );
      }
      if (url.includes("values:batchUpdate")) {
        writes += 1;
        const body = JSON.parse(String(init?.body)) as {
          data: Array<{ range: string; values: [[string]] }>;
        };
        const update = body.data[0]!;
        const match = /!B(\d+)$/.exec(update.range);
        if (!match || !rows[Number(match[1]) - 2])
          return new Response("{}", { status: 400 });
        rows[Number(match[1]) - 2]!.title = update.values[0]![0]!;
        return new Response("{}");
      }
      return new Response("{}", { status: 404 });
    };
    const workspaceId = "google-route-workspace";
    await db.query(
      "INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)",
      [workspaceId, "Google route workspace", userId],
    );
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    );
    const reader = new GoogleSheetsReader(credentialStore, fetchMock);
    const connector = new GoogleSheetsConnector(credentialStore, fetchMock);
    const app = createServer({
      db: db as unknown as SqlClient,
      sessionResolver: async () => ({
        id: userId,
        email: "google@example.test",
        emailVerified: true,
      }),
      google: { credentials: credentialStore, reader, connector },
    });
    await app.ready();
    try {
      const imported = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/google/import`,
        payload: {
          spreadsheetId: "spreadsheet-1",
          sheetId: 0,
          headerRow: 1,
          startColumn: 1,
          endColumn: 2,
          endRow: 3,
          mapping: { title: "g_B" },
          identityField: "g_A",
          name: "Route import",
          locale: "en",
          timeZone: "UTC",
          dateOrder: "ymd",
          weekStartsOn: 1,
          consent: true,
        },
      });
      expect(imported.statusCode).toBe(200);
      const draft = imported.json() as { dataset: Dataset; readOnly: boolean };
      expect(draft.readOnly).toBe(true);
      expect(draft.dataset.source.connectedBy).toBe(userId);
      const importedRecord = draft.dataset.records[0]!;
      expect(importedRecord.id).toMatch(/^google-/);

      const stale = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${draft.dataset.id}/patch`,
        payload: {
          operationId: "google_route_stale_01",
          recordId: importedRecord.id,
          baseRevision: 1,
          changes: { g_B: "Stale" },
        },
      });
      expect(stale.statusCode).toBe(409);
      const invalid = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${draft.dataset.id}/patch`,
        payload: {
          operationId: "google_route_invalid_01",
          recordId: importedRecord.id,
          baseRevision: 0,
          changes: { g_B: { invalid: true } },
        },
      });
      expect(invalid.statusCode).toBe(400);
      const identity = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${draft.dataset.id}/patch`,
        payload: {
          operationId: "google_route_identity_01",
          recordId: importedRecord.id,
          baseRevision: 0,
          changes: { g_A: "row-other" },
        },
      });
      expect(identity.statusCode).toBe(400);
      expect(writes).toBe(0);

      const blockedWithoutMetadata = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/datasets/${draft.dataset.id}/patch`,
        payload: {
          operationId: "google_route_patch_01",
          recordId: importedRecord.id,
          baseRevision: 0,
          changes: { g_B: "Patched" },
        },
      });
      expect(blockedWithoutMetadata.statusCode).toBe(409);
      expect(writes).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("verifies Drive canEdit, a stable row identity, source preimage, and postwrite result", async () => {
    const credentialStore: GoogleCredentialStore = {
      enabled: () => true,
      begin: async () => ({ state: "unused", url: "https://example.test" }),
      complete: async () => undefined,
      accessToken: async () => "access-token",
    };
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/drive/v3/files/"))
        return new Response(
          JSON.stringify({ capabilities: { canEdit: true } }),
        );
      if (url.includes("/values/"))
        return new Response(JSON.stringify({ values: [["stable-1"]] }));
      if (url.includes("values:batchGet")) {
        const ranges = new URL(url).searchParams.getAll("ranges");
        if (ranges.every((range) => /![AB]1$/.test(range))) {
          return new Response(
            JSON.stringify({
              valueRanges: ranges.map((range) => ({
                values: [[range.endsWith("A1") ? "Key" : "Title"]],
              })),
            }),
          );
        }
        const postwrite =
          calls.filter((call) => call.includes("values:batchUpdate")).length >
          0;
        return new Response(
          JSON.stringify({
            valueRanges: postwrite
              ? [{ values: [["stable-1"]] }, { values: [["After"]] }]
              : [{ values: [["stable-1"]] }, { values: [["Before"]] }],
          }),
        );
      }
      if (url.includes("values:batchUpdate")) return new Response("{}");
      return new Response("{}", { status: 404 });
    };
    const connector = new GoogleSheetsConnector(credentialStore, fetchMock);
    const dataset: Dataset = {
      id: "dataset",
      name: "Google",
      source: {
        kind: "google",
        spreadsheetId: "spreadsheet",
        sheetName: "Sheet 1",
        sourceColumns: { key: "A", title: "B" },
        sourceHeaders: { key: "Key", title: "Title" },
        headerRow: 1,
        endRow: 2,
      } as Dataset["source"],
      fields: [
        { key: "key", label: "Key", type: "text" },
        { key: "title", label: "Title", type: "text" },
      ],
      mapping: { title: "title", identity: "key" },
      records: [
        {
          id: "record",
          revision: 0,
          sourceRow: 2,
          values: { key: "stable-1", title: "Before" },
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
    const patch: RecordPatch = {
      operationId: "patch_google_012345",
      recordId: "record",
      baseRevision: 0,
      changes: { title: "After" },
    };
    await expect(
      connector.applyPatch(dataset, patch, userId),
    ).rejects.toMatchObject({
      code: "GOOGLE_METADATA_IDENTITY_REQUIRED",
    });
    expect(calls.some((call) => call.includes("values:batchUpdate"))).toBe(
      false,
    );
  });

  it("writes an imported numeric Google date as a numeric serial and rejects a live formula", async () => {
    let writes = 0;
    let writeBody: unknown;
    const dateConnector = new GoogleSheetsConnector(
      credentialStore,
      async (input, init) => {
        const url = String(input);
        if (url.includes("/drive/v3/files/"))
          return new Response(
            JSON.stringify({ capabilities: { canEdit: true } }),
          );
        if (url.includes("/values/"))
          return new Response(JSON.stringify({ values: [["stable-1"]] }));
        if (url.includes("values:batchGet")) {
          const ranges = new URL(url).searchParams.getAll("ranges");
          if (ranges.every((range) => /![AB]1$/.test(range))) {
            return new Response(
              JSON.stringify({
                valueRanges: ranges.map((range) => ({
                  values: [[range.endsWith("A1") ? "Key" : "Due"]],
                })),
              }),
            );
          }
          const formulaRead = url.includes("valueRenderOption=FORMULA");
          const afterWrite = writes > 0;
          return new Response(
            JSON.stringify({
              valueRanges: [
                { values: [["stable-1"]] },
                {
                  values: [[formulaRead ? 45200 : afterWrite ? 45201 : 45200]],
                },
              ],
            }),
          );
        }
        if (url.includes("values:batchUpdate")) {
          writes += 1;
          writeBody = JSON.parse(String(init?.body));
          return new Response("{}");
        }
        return new Response("{}", { status: 404 });
      },
    );
    const dataset = {
      id: "dataset",
      name: "Google dates",
      source: {
        kind: "google",
        spreadsheetId: "spreadsheet",
        sheetName: "Sheet",
        sourceColumns: { key: "A", due: "B" },
        sourceHeaders: { key: "Key", due: "Due" },
        headerRow: 1,
        endRow: 2,
      },
      fields: [
        { key: "key", label: "Key", type: "text" },
        { key: "due", label: "Due", type: "date" },
      ],
      mapping: { title: "key", identity: "key", date: "due" },
      records: [
        {
          id: "google-record",
          revision: 0,
          sourceRow: 2,
          values: { key: "stable-1", due: "2023-10-01" },
          sourceValues: { due: 45200 },
        },
      ],
      revision: 0,
      locale: "en",
      timeZone: "UTC",
      dateOrder: "ymd",
      weekStartsOn: 1,
      updatedAt: new Date().toISOString(),
      completedStatuses: [],
    } as Dataset;
    await expect(
      dateConnector.applyPatch(
        dataset,
        {
          operationId: "numeric_date_patch_01",
          recordId: "google-record",
          baseRevision: 0,
          changes: { due: "2023-10-02" },
        },
        userId,
      ),
    ).rejects.toMatchObject({
      code: "GOOGLE_METADATA_IDENTITY_REQUIRED",
    });
    expect(writeBody).toBeUndefined();

    const formulaConnector = new GoogleSheetsConnector(
      credentialStore,
      async (input) => {
        const url = String(input);
        if (url.includes("/drive/v3/files/"))
          return new Response(
            JSON.stringify({ capabilities: { canEdit: true } }),
          );
        if (url.includes("/values/"))
          return new Response(JSON.stringify({ values: [["stable-1"]] }));
        if (url.includes("values:batchGet")) {
          const ranges = new URL(url).searchParams.getAll("ranges");
          if (ranges.every((range) => /![AB]1$/.test(range))) {
            return new Response(
              JSON.stringify({
                valueRanges: ranges.map((range) => ({
                  values: [[range.endsWith("A1") ? "Key" : "Due"]],
                })),
              }),
            );
          }
          const formulas = url.includes("valueRenderOption=FORMULA");
          return new Response(
            JSON.stringify({
              valueRanges: [
                { values: [["stable-1"]] },
                { values: [[formulas ? "=TODAY()" : 45200]] },
              ],
            }),
          );
        }
        if (url.includes("values:batchUpdate"))
          throw new Error("must not write a live formula");
        return new Response("{}", { status: 404 });
      },
    );
    await expect(
      formulaConnector.applyPatch(
        dataset,
        {
          operationId: "formula_date_patch_01",
          recordId: "google-record",
          baseRevision: 0,
          changes: { due: "2023-10-02" },
        },
        userId,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METADATA_IDENTITY_REQUIRED" });
  });

  it("does not write Google Sheets if preimage validation finds a conflict", async () => {
    const credentialStore: GoogleCredentialStore = {
      enabled: () => true,
      begin: async () => ({ state: "unused", url: "https://example.test" }),
      complete: async () => undefined,
      accessToken: async () => "access-token",
    };
    let writes = 0;
    const connector = new GoogleSheetsConnector(
      credentialStore,
      async (input) => {
        const url = String(input);
        if (url.includes("/drive/v3/files/"))
          return new Response(
            JSON.stringify({ capabilities: { canEdit: true } }),
          );
        if (url.includes("/values/"))
          return new Response(JSON.stringify({ values: [["stable-1"]] }));
        if (url.includes("values:batchGet")) {
          const ranges = new URL(url).searchParams.getAll("ranges");
          if (ranges.every((range) => /![AB]1$/.test(range))) {
            return new Response(
              JSON.stringify({
                valueRanges: ranges.map((range) => ({
                  values: [[range.endsWith("A1") ? "Key" : "Title"]],
                })),
              }),
            );
          }
          return new Response(
            JSON.stringify({
              valueRanges: [
                { values: [["other-row"]] },
                { values: [["Before"]] },
              ],
            }),
          );
        }
        if (url.includes("values:batchUpdate")) writes += 1;
        return new Response("{}");
      },
    );
    const dataset = {
      id: "dataset",
      name: "Google",
      source: {
        kind: "google",
        spreadsheetId: "spreadsheet",
        sheetName: "Sheet",
        sourceColumns: { key: "A", title: "B" },
        sourceHeaders: { key: "Key", title: "Title" },
        headerRow: 1,
        endRow: 2,
      },
      fields: [
        { key: "key", label: "Key", type: "text" },
        { key: "title", label: "Title", type: "text" },
      ],
      mapping: { title: "title", identity: "key" },
      records: [
        {
          id: "record",
          revision: 0,
          sourceRow: 2,
          values: { key: "stable-1", title: "Before" },
        },
      ],
      revision: 0,
      locale: "en",
      timeZone: "UTC",
      dateOrder: "ymd",
      weekStartsOn: 1,
      updatedAt: new Date().toISOString(),
      completedStatuses: [],
    } as Dataset;
    await expect(
      connector.applyPatch(
        dataset,
        {
          operationId: "conflict_google_012",
          recordId: "record",
          baseRevision: 0,
          changes: { title: "After" },
        },
        userId,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METADATA_IDENTITY_REQUIRED" });
    expect(writes).toBe(0);
  });

  it("refuses a duplicate identity introduced after import before issuing a write", async () => {
    let writes = 0;
    const connector = new GoogleSheetsConnector(
      credentialStore,
      async (input) => {
        const url = String(input);
        if (url.includes("/drive/v3/files/"))
          return new Response(
            JSON.stringify({ capabilities: { canEdit: true } }),
          );
        if (url.includes("/values/"))
          return new Response(
            JSON.stringify({ values: [["stable-1", "stable-1"]] }),
          );
        if (url.includes("values:batchGet")) {
          const ranges = new URL(url).searchParams.getAll("ranges");
          return new Response(
            JSON.stringify({
              valueRanges: ranges.map((range) => ({
                values: [[range.endsWith("A1") ? "Key" : "Title"]],
              })),
            }),
          );
        }
        if (url.includes("values:batchUpdate")) writes += 1;
        return new Response("{}");
      },
    );
    const dataset = {
      id: "dataset",
      name: "Google",
      source: {
        kind: "google",
        spreadsheetId: "spreadsheet",
        sheetName: "Sheet",
        headerRow: 1,
        endRow: 3,
        sourceColumns: { key: "A", title: "B" },
        sourceHeaders: { key: "Key", title: "Title" },
      },
      fields: [
        { key: "key", label: "Key", type: "text" },
        { key: "title", label: "Title", type: "text" },
      ],
      mapping: { title: "title", identity: "key" },
      records: [
        {
          id: "record",
          revision: 0,
          sourceRow: 2,
          values: { key: "stable-1", title: "Before" },
        },
      ],
      revision: 0,
      locale: "en",
      timeZone: "UTC",
      dateOrder: "ymd",
      weekStartsOn: 1,
      updatedAt: new Date().toISOString(),
      completedStatuses: [],
    } as Dataset;
    await expect(
      connector.applyPatch(
        dataset,
        {
          operationId: "duplicate_identity_patch_01",
          recordId: "record",
          baseRevision: 0,
          changes: { title: "After" },
        },
        userId,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METADATA_IDENTITY_REQUIRED" });
    expect(writes).toBe(0);
  });
});
