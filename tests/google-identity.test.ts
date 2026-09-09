import { describe, expect, it } from "vitest";
import type {
  Dataset,
  RecordPatch,
  WorkRecord,
} from "../packages/core/src/types.ts";
import {
  GoogleSheetsConnector,
  GoogleSheetsReader,
  type GoogleCredentialStore,
} from "../apps/server/src/google.ts";

const credentials: GoogleCredentialStore = {
  enabled: () => true,
  begin: async () => ({ state: "test", url: "https://example.test" }),
  complete: async () => undefined,
  accessToken: async () => "token",
};

type Cell = string | number | boolean | null;
interface Row {
  values: Record<string, Cell>;
  formulas?: Record<string, string>;
  metadata?: Array<{ key: string; value: string; id?: number }>;
}

function columnFromLabel(label: string): string {
  return label;
}

function cell(value: Cell, formula?: string) {
  const effectiveValue =
    value === null
      ? undefined
      : typeof value === "string"
        ? { stringValue: value }
        : typeof value === "number"
          ? { numberValue: value }
          : { boolValue: value };
  return {
    ...(effectiveValue ? { effectiveValue } : {}),
    ...(formula ? { userEnteredValue: { formulaValue: formula } } : {}),
  };
}

function sourceDataset(
  rows: Row[],
  options: { metadata?: boolean; identity?: boolean } = {},
): Dataset {
  const metadata = options.metadata === true;
  const identity = options.identity === true;
  const records: WorkRecord[] = rows.slice(1).map((row, index) => {
    const values: WorkRecord["values"] = identity
      ? { key: String(row.values.A), title: row.values.B }
      : { title: row.values.B };
    return {
      id: `record-${index + 1}`,
      revision: 0,
      sourceRow: index + 2,
      values,
      ...(metadata && row.metadata?.[0]
        ? { sourceIdentity: row.metadata[0].value }
        : {}),
    };
  });
  return {
    id: "google-dataset-1",
    name: "Synthetic Google source",
    source: {
      kind: "google",
      spreadsheetId: "sheet-1",
      sheetId: 0,
      sheetName: "Roadmap",
      headerRow: 1,
      startColumn: 1,
      endColumn: 2,
      endRow: rows.length,
      sourceColumns: identity ? { key: "A", title: "B" } : { title: "B" },
      sourceHeaders: identity
        ? { key: "ID", title: "Title" }
        : { title: "Title" },
      ...(identity
        ? { identityColumn: "A", identityStrategy: "column" as const }
        : {}),
      ...(metadata
        ? {
            identityStrategy: "developer-metadata" as const,
            developerMetadataKey: "sheet-workbench.row.v1:google-dataset-1",
            developerMetadataConsent: true,
          }
        : {}),
    },
    fields: identity
      ? [
          { key: "key", label: "ID", type: "text" as const },
          { key: "title", label: "Title", type: "text" as const },
        ]
      : [{ key: "title", label: "Title", type: "text" as const }],
    mapping: identity
      ? { title: "title", identity: "key" }
      : { title: "title" },
    records,
    revision: 0,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: "2026-09-08T00:00:00.000Z",
    completedStatuses: [],
  };
}

function syntheticGoogle(rows: Row[]) {
  let canEdit = true;
  let lostResponse = false;
  let sortBeforeMetadataBatch = false;
  let sortBeforeMetadataWrite = false;
  let sortBeforeMetadataSearch = false;
  let writes = 0;
  let nextMetadataId = 1;
  for (const row of rows)
    for (const item of row.metadata ?? []) item.id ??= nextMetadataId++;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const formula =
      new URL(url).searchParams.get("valueRenderOption") === "FORMULA" ||
      body?.valueRenderOption === "FORMULA";
    const valueAt = (column: string, row: number): Cell => {
      const item = rows[row - 1];
      if (!item) return null;
      return formula && item.formulas?.[column]
        ? item.formulas[column]
        : (item.values[column] ?? null);
    };
    const rangeValue = (range: string): Cell => {
      const match = /!([A-Z]+)(\d+)$/.exec(range);
      return match
        ? valueAt(columnFromLabel(match[1]!), Number(match[2]))
        : null;
    };
    const metadataFor = (row: Row, index: number) =>
      (row.metadata ?? []).map((item) => ({
        metadataId: item.id,
        metadataKey: item.key,
        metadataValue: item.value,
        visibility: "DOCUMENT",
        location: {
          locationType: "ROW",
          dimensionRange: {
            sheetId: 0,
            dimension: "ROWS",
            startIndex: index,
            endIndex: index + 1,
          },
        },
      }));
    if (url.includes("/drive/v3/files/"))
      return new Response(JSON.stringify({ capabilities: { canEdit } }));
    if (url.includes("developerMetadata:search")) {
      if (sortBeforeMetadataSearch) {
        sortBeforeMetadataSearch = false;
        const dataRows = rows.splice(1);
        rows.push(...dataRows.reverse());
      }
      const lookup = body.dataFilters[0].developerMetadataLookup as {
        metadataKey: string;
        metadataValue?: string;
      };
      const matchedDeveloperMetadata = rows.flatMap((row, index) =>
        (row.metadata ?? [])
          .filter(
            (item) =>
              item.key === lookup.metadataKey &&
              (!lookup.metadataValue || item.value === lookup.metadataValue),
          )
          .map((item) => ({
            developerMetadata: metadataFor(
              { ...row, metadata: [item] },
              index,
            )[0],
          })),
      );
      return new Response(JSON.stringify({ matchedDeveloperMetadata }));
    }
    if (url.includes("includeGridData=false"))
      return new Response(
        JSON.stringify({
          properties: { title: "Synthetic" },
          sheets: [
            { properties: { sheetId: 0, title: "Roadmap", sheetType: "GRID" } },
          ],
        }),
      );
    if (url.includes("includeGridData=true"))
      return new Response(
        JSON.stringify({
          sheets: [
            {
              data: [
                {
                  startRow: 0,
                  startColumn: 0,
                  rowData: rows.map((row) => ({
                    values: [
                      cell(row.values.A, row.formulas?.A),
                      cell(row.values.B, row.formulas?.B),
                    ],
                  })),
                  rowMetadata: rows.map((row, index) => ({
                    developerMetadata: metadataFor(row, index),
                  })),
                },
              ],
            },
          ],
        }),
      );
    if (url.includes("values:batchGetByDataFilter")) {
      const lookup = body.dataFilters[0].developerMetadataLookup as {
        metadataId: number;
      };
      const found = rows.find((row) =>
        row.metadata?.some((item) => item.id === lookup.metadataId),
      );
      if (!found) return new Response(JSON.stringify({ valueRanges: [] }));
      return new Response(
        JSON.stringify({
          valueRanges: [
            {
              valueRange: {
                values: [
                  [
                    valueAt("A", rows.indexOf(found) + 1),
                    valueAt("B", rows.indexOf(found) + 1),
                  ],
                ],
              },
            },
          ],
        }),
      );
    }
    if (url.includes("values:batchGet")) {
      const ranges = new URL(url).searchParams.getAll("ranges");
      return new Response(
        JSON.stringify({
          valueRanges: ranges.map((range) => {
            const value = rangeValue(range);
            return value === null ? {} : { values: [[value]] };
          }),
        }),
      );
    }
    if (url.includes("values:batchUpdateByDataFilter")) {
      writes += 1;
      if (sortBeforeMetadataWrite) {
        sortBeforeMetadataWrite = false;
        const dataRows = rows.splice(1);
        rows.push(...dataRows.reverse());
      }
      const data = body.data[0] as {
        dataFilter: { developerMetadataLookup: { metadataId: number } };
        values: [Cell[]];
      };
      const found = rows.find((row) =>
        row.metadata?.some(
          (item) =>
            item.id === data.dataFilter.developerMetadataLookup.metadataId,
        ),
      );
      if (!found) return new Response("Missing metadata", { status: 400 });
      data.values[0].forEach((value, index) => {
        if (value !== null)
          found.values[String.fromCharCode(65 + index)] =
            value === "" ? null : value;
      });
      return new Response("{}");
    }
    if (url.includes("/values/")) {
      const decoded = decodeURIComponent(
        url.slice(url.indexOf("/values/") + 8).split("?")[0]!,
      );
      const match = /!([A-Z]+)(\d+):[A-Z]+(\d+)$/.exec(decoded);
      const values = match
        ? [
            Array.from(
              { length: Number(match[3]) - Number(match[2]) + 1 },
              (_, index) => valueAt(match[1]!, Number(match[2]) + index),
            ),
          ]
        : [];
      return new Response(JSON.stringify({ values }));
    }
    if (url.includes("values:batchUpdate")) {
      writes += 1;
      for (const update of body.data as Array<{
        range: string;
        values: [[Cell]];
      }>) {
        const match = /!([A-Z]+)(\d+)$/.exec(update.range);
        if (match)
          rows[Number(match[2]) - 1]!.values[match[1]!] = update.values[0]![0]!;
      }
      return new Response("{}");
    }
    if (url.includes(":batchUpdate")) {
      writes += 1;
      if (
        sortBeforeMetadataBatch &&
        (body.requests as Array<Record<string, any>>).some(
          (request) => request.createDeveloperMetadata,
        )
      ) {
        sortBeforeMetadataBatch = false;
        const dataRows = rows.splice(1);
        rows.push(...dataRows.reverse());
      }
      for (const request of body.requests as Array<Record<string, any>>) {
        if (request.insertDimension) {
          const index = request.insertDimension.range.startIndex as number;
          rows.splice(index, 0, { values: {} });
        }
        if (request.updateCells) {
          const start = request.updateCells.start;
          const field = request.updateCells.rows[0].values[0].userEnteredValue;
          const value =
            field.stringValue ?? field.numberValue ?? field.boolValue ?? null;
          rows[start.rowIndex]!.values[
            String.fromCharCode(65 + start.columnIndex)
          ] = value;
        }
        if (request.createDeveloperMetadata) {
          const data = request.createDeveloperMetadata.developerMetadata;
          const index = data.location.dimensionRange.startIndex as number;
          const row = rows[index]!;
          row.metadata ??= [];
          row.metadata.push({
            key: data.metadataKey,
            value: data.metadataValue,
            id: nextMetadataId++,
          });
        }
      }
      if (lostResponse) {
        lostResponse = false;
        throw new DOMException("lost", "TimeoutError");
      }
      return new Response("{}");
    }
    return new Response("Unexpected request", { status: 500 });
  };
  return {
    fetchMock,
    rows,
    get writes() {
      return writes;
    },
    set canEdit(value: boolean) {
      canEdit = value;
    },
    loseNextResponse() {
      lostResponse = true;
    },
    sortBeforeNextMetadataBatch() {
      sortBeforeMetadataBatch = true;
    },
    sortBeforeNextMetadataWrite() {
      sortBeforeMetadataWrite = true;
    },
    sortBeforeNextMetadataSearch() {
      sortBeforeMetadataSearch = true;
    },
  };
}

describe("Google developer-metadata source identity", () => {
  it("tags an ID-less source, tracks it through a sort, and refreshes locations by metadata", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      { values: { A: null, B: "First" } },
      { values: { A: null, B: "Second" } },
    ]);
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    const initial = sourceDataset(remote.rows);
    const enabled = await connector.enableMetadataIdentity(
      initial,
      { operationId: "enable_identity_01", consent: true },
      "actor",
    );
    expect(enabled.replayed).toBe(false);
    expect(enabled.records.every((record) => record.sourceIdentity)).toBe(true);
    remote.rows.splice(1, 2, remote.rows[2]!, remote.rows[1]!);
    const sorted = {
      ...initial,
      source: enabled.source,
      records: enabled.records,
    };
    const patch: RecordPatch = {
      operationId: "metadata_sort_patch_01",
      recordId: enabled.records[0]!.id,
      baseRevision: 0,
      changes: { title: "First changed" },
    };
    const write = await connector.applyPatch(sorted, patch, "actor");
    expect(write.recordSource?.sourceRow).toBe(3);
    expect(remote.rows[2]!.values.B).toBe("First changed");

    const reader = new GoogleSheetsReader(credentials, remote.fetchMock);
    const refreshed = await reader.importSelection(
      {
        spreadsheetId: "sheet-1",
        sheetId: 0,
        headerRow: 1,
        startColumn: 1,
        endColumn: 2,
        endRow: 3,
        mapping: { title: "g_B" },
        identityStrategy: "developer-metadata",
        developerMetadataKey: enabled.source.developerMetadataKey,
        developerMetadataConsent: true,
        name: "Refresh",
        locale: "en",
        timeZone: "UTC",
        dateOrder: "ymd",
        weekStartsOn: 1,
      },
      "actor",
    );
    expect(refreshed.readOnly).toBe(false);
    expect(
      refreshed.dataset.records.map((record) => record.sourceIdentity),
    ).toEqual(enabled.records.map((record) => record.sourceIdentity).reverse());
  });

  it("keeps cells paired with their same-snapshot metadata when a sort races refresh", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      { values: { A: null, B: "First" } },
      { values: { A: null, B: "Second" } },
    ]);
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    const initial = sourceDataset(remote.rows);
    const enabled = await connector.enableMetadataIdentity(
      initial,
      { operationId: "enable_identity_refresh_race_01", consent: true },
      "actor",
    );
    const reader = new GoogleSheetsReader(credentials, remote.fetchMock);
    // The grid response still contains First then Second. The following
    // developerMetadata search observes a sort, which must not relabel the
    // already-read cells with those later physical row positions.
    remote.sortBeforeNextMetadataSearch();
    const refreshed = await reader.importSelection(
      {
        spreadsheetId: "sheet-1",
        sheetId: 0,
        headerRow: 1,
        startColumn: 1,
        endColumn: 2,
        endRow: 3,
        mapping: { title: "g_B" },
        identityStrategy: "developer-metadata",
        developerMetadataKey: enabled.source.developerMetadataKey,
        developerMetadataConsent: true,
        name: "Refresh race",
        locale: "en",
        timeZone: "UTC",
        dateOrder: "ymd",
        weekStartsOn: 1,
      },
      "actor",
    );
    const byIdentity = new Map(
      refreshed.dataset.records.map((record) => [
        record.sourceIdentity,
        record,
      ]),
    );
    expect(
      byIdentity.get(enabled.records[0]!.sourceIdentity!)?.values.g_B,
    ).toBe("First");
    expect(
      byIdentity.get(enabled.records[1]!.sourceIdentity!)?.values.g_B,
    ).toBe("Second");
    expect(remote.rows[1]!.values.B).toBe("Second");
  });

  it("fails closed on duplicate metadata and keeps unmarked refreshed rows read-only", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      {
        values: { A: null, B: "First" },
        metadata: [
          {
            key: "sheet-workbench.row.v1:google-dataset-1",
            value: "record:one",
          },
          {
            key: "sheet-workbench.row.v1:google-dataset-1",
            value: "record:two",
          },
        ],
      },
      { values: { A: null, B: "Unmarked" } },
    ]);
    const reader = new GoogleSheetsReader(credentials, remote.fetchMock);
    await expect(
      reader.importSelection(
        {
          spreadsheetId: "sheet-1",
          sheetId: 0,
          headerRow: 1,
          startColumn: 1,
          endColumn: 2,
          endRow: 3,
          mapping: { title: "g_B" },
          identityStrategy: "developer-metadata",
          developerMetadataKey: "sheet-workbench.row.v1:google-dataset-1",
          developerMetadataConsent: true,
          name: "Broken",
          locale: "en",
          timeZone: "UTC",
          dateOrder: "ymd",
          weekStartsOn: 1,
        },
        "actor",
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METADATA_IDENTITY_MISMATCH" });
  });

  it("does not expose identities when a source sort races metadata assignment", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      { values: { A: null, B: "First" } },
      { values: { A: null, B: "Second" } },
    ]);
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    remote.sortBeforeNextMetadataBatch();
    await expect(
      connector.enableMetadataIdentity(
        sourceDataset(remote.rows),
        { operationId: "enable_identity_race_01", consent: true },
        "actor",
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METADATA_IDENTITY_MISMATCH" });
  });

  it("writes the metadata-selected row when a sort races the source write", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      { values: { A: null, B: "First" } },
      { values: { A: null, B: "Second" } },
    ]);
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    const initial = sourceDataset(remote.rows);
    const enabled = await connector.enableMetadataIdentity(
      initial,
      { operationId: "enable_identity_write_race_01", consent: true },
      "actor",
    );
    remote.sortBeforeNextMetadataWrite();
    const write = await connector.applyPatch(
      { ...initial, source: enabled.source, records: enabled.records },
      {
        operationId: "metadata_write_race_01",
        recordId: enabled.records[0]!.id,
        baseRevision: 0,
        changes: { title: "First changed" },
      },
      "actor",
    );
    expect(remote.rows[2]!.values.B).toBe("First changed");
    expect(write.recordSource?.sourceRow).toBe(3);
  });

  it("keeps a visible ID locked while metadata supplies the write locator", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      { values: { A: "first", B: "First" } },
      { values: { A: "second", B: "Second" } },
    ]);
    const initial = sourceDataset(remote.rows, { identity: true });
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    const enabled = await connector.enableMetadataIdentity(
      initial,
      { operationId: "enable_visible_id_metadata_01", consent: true },
      "actor",
    );
    expect(enabled.source.identityStrategy).toBe("developer-metadata");
    expect(
      enabled.records.every((record) => record.lockedFields?.includes("key")),
    ).toBe(true);

    const reader = new GoogleSheetsReader(credentials, remote.fetchMock);
    const refreshed = await reader.importSelection(
      {
        spreadsheetId: "sheet-1",
        sheetId: 0,
        headerRow: 1,
        startColumn: 1,
        endColumn: 2,
        endRow: 3,
        mapping: { title: "g_B" },
        identityField: "g_A",
        identityStrategy: "developer-metadata",
        developerMetadataKey: enabled.source.developerMetadataKey,
        developerMetadataConsent: true,
        name: "Visible ID refresh",
        locale: "en",
        timeZone: "UTC",
        dateOrder: "ymd",
        weekStartsOn: 1,
      },
      "actor",
    );
    expect(
      refreshed.dataset.records.every((record) =>
        record.lockedFields?.includes("g_A"),
      ),
    ).toBe(true);

    const created = await connector.createRow(
      { ...initial, source: enabled.source, records: enabled.records },
      {
        operationId: "create_visible_id_metadata_01",
        record: {
          id: "created-visible-id",
          revision: 0,
          values: { key: "third", title: "Third" },
        },
        appendConsent: true,
        developerMetadataConsent: true,
      },
      "actor",
    );
    expect(created.record.sourceIdentity).toBe(
      "op:create_visible_id_metadata_01",
    );
    expect(created.record.lockedFields).toContain("key");
  });

  it("reconciles a lost append response by operation metadata without inserting twice", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      {
        values: { A: null, B: "Existing" },
        metadata: [
          {
            key: "sheet-workbench.row.v1:google-dataset-1",
            value: "record:record-1",
          },
        ],
      },
    ]);
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    const dataset = sourceDataset(remote.rows, { metadata: true });
    const request = {
      operationId: "append_lost_response_01",
      record: {
        id: "google-op-append-1",
        revision: 0,
        values: { title: "Created" },
      },
      appendConsent: true as const,
      developerMetadataConsent: true as const,
    };
    remote.loseNextResponse();
    await expect(
      connector.createRow(dataset, request, "actor"),
    ).rejects.toMatchObject({
      code: "GOOGLE_TIMEOUT",
    });
    const afterLost = remote.rows.length;
    const replay = await connector.createRow(dataset, request, "actor");
    expect(replay.replayed).toBe(true);
    expect(replay.record.sourceIdentity).toBe("op:append_lost_response_01");
    expect(remote.rows).toHaveLength(afterLost);
  });

  it("blocks create/patch before writes on permission, header, and formula guards", async () => {
    const remote = syntheticGoogle([
      { values: { A: "ID", B: "Title" } },
      {
        values: { A: null, B: "Existing" },
        metadata: [
          {
            key: "sheet-workbench.row.v1:google-dataset-1",
            value: "record:record-1",
          },
        ],
      },
    ]);
    const connector = new GoogleSheetsConnector(credentials, remote.fetchMock);
    const dataset = sourceDataset(remote.rows, { metadata: true });
    const create = {
      operationId: "permission_guard_01",
      record: {
        id: "google-op-guard",
        revision: 0,
        values: { title: "Created" },
      },
      appendConsent: true as const,
      developerMetadataConsent: true as const,
    };
    remote.canEdit = false;
    await expect(
      connector.createRow(dataset, create, "actor"),
    ).rejects.toMatchObject({
      code: "GOOGLE_CANNOT_EDIT",
    });
    expect(remote.writes).toBe(0);
    remote.canEdit = true;
    remote.rows[0]!.values.B = "Changed title";
    await expect(
      connector.createRow(dataset, create, "actor"),
    ).rejects.toMatchObject({
      code: "GOOGLE_SCHEMA_CHANGED",
    });
    expect(remote.writes).toBe(0);
    remote.rows[0]!.values.B = "Title";
    remote.rows[1]!.formulas = { B: "=TODAY()" };
    await expect(
      connector.applyPatch(
        dataset,
        {
          operationId: "formula_guard_01",
          recordId: dataset.records[0]!.id,
          baseRevision: 0,
          changes: { title: "No write" },
        },
        "actor",
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_SOURCE_CONFLICT" });
    expect(remote.writes).toBe(0);
  });
});
