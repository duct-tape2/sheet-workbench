import { describe, expect, it } from "vitest";
import type { Dataset } from "../packages/core/src/types.ts";
import { GoogleSheetsReader } from "../apps/server/src/google.ts";
import {
  assertGoogleIdentityPreviewFingerprint,
  prepareGoogleIdentityPreview,
} from "../apps/server/src/google-identity-preview.ts";

function dataset(
  records: Dataset["records"],
  options: { header?: string; source?: Dataset["source"] } = {},
): Dataset {
  return {
    id: "dataset-google-preview",
    name: "Source roadmap",
    source: options.source ?? {
      kind: "google",
      spreadsheetId: "sheet-preview",
      sheetId: 7,
      sheetName: "Roadmap",
      headerRow: 1,
      startColumn: 1,
      endColumn: 2,
      endRow: 4,
      sourceColumns: { key: "A", title: "B" },
      sourceHeaders: { key: "ID", title: options.header ?? "Title" },
      connectedBy: "editor-1",
      identityStrategy: "developer-metadata",
      developerMetadataKey: "sheet-workbench.row.v1:dataset-google-preview",
      developerMetadataConsent: true,
    },
    fields: [
      { key: "key", label: "ID", type: "text" },
      { key: "title", label: "Title", type: "text" },
    ],
    mapping: { title: "title", identity: "key" },
    records,
    revision: 9,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: "2026-09-08T00:00:00.000Z",
    completedStatuses: ["Done"],
  };
}

function readerFor(fresh: Dataset) {
  let imports = 0;
  const importSelection = async (selection: unknown) => ({
    // GoogleSheetsReader creates a fresh local dataset ID on every import;
    // the consent fingerprint must not churn merely because that ID changed.
    dataset: { ...fresh, id: `fresh-import-${++imports}` },
    readOnly: fresh.source.readOnly === true,
    readOnlyReason: fresh.source.readOnlyReason,
  });
  return {
    reader: { importSelection } as unknown as GoogleSheetsReader,
    selection: () => importSelection,
  };
}

describe("Google identity preview", () => {
  it("retains tracked local IDs only by metadata and includes untracked external rows", async () => {
    const stored = dataset([
      {
        id: "local-first",
        revision: 4,
        sourceIdentity: "record:first",
        sourceRow: 2,
        values: { key: "A", title: "First" },
      },
      {
        id: "local-second",
        revision: 2,
        sourceIdentity: "record:second",
        sourceRow: 3,
        values: { key: "B", title: "Second" },
      },
    ]);
    const fresh = dataset(
      [
        {
          id: "reader-row-second",
          revision: 0,
          sourceIdentity: "record:second",
          sourceRow: 2,
          values: { key: "B", title: "Second updated" },
        },
        {
          id: "reader-row-first",
          revision: 0,
          sourceIdentity: "record:first",
          sourceRow: 3,
          values: { key: "A", title: "First" },
        },
        {
          id: "google-row-7-4",
          revision: 0,
          sourceRow: 4,
          values: { key: "C", title: "External new" },
        },
      ],
      {
        source: {
          ...stored.source,
          identityStrategy: "developer-metadata",
          developerMetadataConsent: true,
          readOnly: true,
          readOnlyReason:
            "Google has new or untracked rows without approved metadata identities. Review them before enabling writeback.",
        },
      },
    );
    const { reader } = readerFor(fresh);
    const preview = await prepareGoogleIdentityPreview(
      stored,
      reader,
      "editor-1",
    );
    expect(preview.added).toBe(1);
    expect(preview.dataset.id).toBe(stored.id);
    expect(preview.dataset.source.connectedBy).toBe("editor-1");
    expect(preview.dataset.fields).toEqual(stored.fields);
    expect(preview.dataset.records).toEqual([
      expect.objectContaining({
        id: "local-second",
        revision: 3,
        sourceRow: 2,
      }),
      expect.objectContaining({ id: "local-first", revision: 5, sourceRow: 3 }),
      expect.objectContaining({
        id: "google-row-7-4",
        revision: 0,
        sourceRow: 4,
      }),
    ]);
    expect(preview.dataset.records[2]?.sourceIdentity).toBeUndefined();
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires exact headers and rejects a stale consent fingerprint", async () => {
    const stored = dataset([
      {
        id: "local-first",
        revision: 0,
        sourceIdentity: "record:first",
        sourceRow: 2,
        values: { key: "A", title: "First" },
      },
    ]);
    const changedHeaders = dataset([], {
      header: "Renamed title",
      source: {
        ...stored.source,
        sourceHeaders: { key: "ID", title: "Renamed title" },
      },
    });
    const { reader } = readerFor(changedHeaders);
    await expect(
      prepareGoogleIdentityPreview(stored, reader, "editor-1"),
    ).rejects.toMatchObject({ code: "GOOGLE_SCHEMA_CHANGED" });
    expect(() =>
      assertGoogleIdentityPreviewFingerprint("0".repeat(64), "1".repeat(64)),
    ).toThrow(/preview changed/i);
  });

  it("keeps the preview fingerprint stable across identical fresh imports", async () => {
    const stored = dataset([
      {
        id: "local-first",
        revision: 0,
        sourceIdentity: "record:first",
        sourceRow: 2,
        values: { key: "A", title: "First" },
      },
    ]);
    const fresh = dataset([
      {
        id: "reader-first",
        revision: 0,
        sourceIdentity: "record:first",
        sourceRow: 2,
        values: { key: "A", title: "First" },
      },
    ]);
    const { reader } = readerFor(fresh);
    const first = await prepareGoogleIdentityPreview(
      stored,
      reader,
      "editor-1",
    );
    const second = await prepareGoogleIdentityPreview(
      stored,
      reader,
      "editor-1",
    );
    expect(first.dataset.id).toBe(stored.id);
    expect(second.dataset.id).toBe(stored.id);
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});
