import { createHash } from "node:crypto";
import { validateDataset } from "../../../packages/core/src/index.ts";
import type {
  Dataset,
  SourceInfo,
  WorkRecord,
} from "../../../packages/core/src/types.ts";
import { HttpError } from "./errors.ts";
import {
  GoogleSheetsReader,
  type GoogleImportSelection,
  type GoogleSource,
} from "./google.ts";

export interface GoogleIdentityPreview {
  /** A fresh, read-only source snapshot to pass to explicit identity enablement. */
  dataset: Dataset;
  /** Stable proof that the reviewed source rows have not changed before consent. */
  fingerprint: string;
  /** Rows without a previously tracked metadata identity. */
  added: number;
}

function metadataKey(dataset: Dataset): string {
  const key =
    dataset.source.developerMetadataKey ??
    `sheet-workbench.row.v1:${dataset.id}`;
  if (!/^[\x20-\x7e]{1,500}$/.test(key))
    throw new HttpError(
      409,
      "GOOGLE_METADATA_IDENTITY_UNSAFE",
      "The Google row metadata key is invalid.",
    );
  return key;
}

function selectionForPreview(dataset: Dataset): GoogleImportSelection {
  const source = dataset.source as GoogleSource;
  if (
    source.kind !== "google" ||
    !source.spreadsheetId ||
    source.sheetId === undefined ||
    !source.headerRow ||
    !source.startColumn ||
    !source.endColumn ||
    !source.endRow
  )
    throw new HttpError(
      409,
      "GOOGLE_REFRESH_UNSAFE",
      "This Google dataset lacks its original bounded source selection.",
    );
  return {
    spreadsheetId: source.spreadsheetId,
    sheetId: source.sheetId,
    headerRow: source.headerRow,
    startColumn: source.startColumn,
    endColumn: source.endColumn,
    endRow: source.endRow,
    mapping: dataset.mapping,
    // The visible ID remains part of the import mapping when one exists. Row
    // metadata is the locator, not a replacement for a useful visible value.
    identityField: dataset.mapping.identity,
    identityStrategy: "developer-metadata",
    developerMetadataKey: metadataKey(dataset),
    developerMetadataConsent: true,
    name: dataset.name,
    locale: dataset.locale,
    timeZone: dataset.timeZone,
    dateOrder: dataset.dateOrder,
    weekStartsOn: dataset.weekStartsOn,
  };
}

function exactRecordValues(left: WorkRecord, right: WorkRecord): boolean {
  const keys = new Set([
    ...Object.keys(left.values),
    ...Object.keys(right.values),
  ]);
  return [...keys].every((key) => left.values[key] === right.values[key]);
}

function sourceRecordChanged(left: WorkRecord, right: WorkRecord): boolean {
  return (
    left.sourceRow !== right.sourceRow ||
    !exactRecordValues(left, right) ||
    JSON.stringify(left.sourceValues ?? {}) !==
      JSON.stringify(right.sourceValues ?? {}) ||
    JSON.stringify(left.lockedFields ?? []) !==
      JSON.stringify(right.lockedFields ?? [])
  );
}

function exactEntries(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function assertSameSourceSchema(
  stored: GoogleSource,
  fresh: GoogleSource,
): void {
  if (
    stored.spreadsheetId !== fresh.spreadsheetId ||
    stored.sheetId !== fresh.sheetId ||
    stored.sheetName !== fresh.sheetName ||
    stored.headerRow !== fresh.headerRow ||
    stored.startColumn !== fresh.startColumn ||
    stored.endColumn !== fresh.endColumn ||
    stored.endRow !== fresh.endRow ||
    !exactEntries(stored.sourceHeaders, fresh.sourceHeaders) ||
    !exactEntries(stored.sourceColumns, fresh.sourceColumns)
  )
    throw new HttpError(
      409,
      "GOOGLE_SCHEMA_CHANGED",
      "Google headers or the selected source bounds changed. Review the source before enabling row identity.",
    );
}

function trackedRecords(records: WorkRecord[]): Map<string, WorkRecord> {
  const index = new Map<string, WorkRecord>();
  for (const record of records) {
    if (!record.sourceIdentity) continue;
    if (index.has(record.sourceIdentity))
      throw new HttpError(
        409,
        "GOOGLE_METADATA_IDENTITY_MISMATCH",
        "Stored Google row metadata identities are duplicated.",
      );
    index.set(record.sourceIdentity, record);
  }
  return index;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Hashes only source/row content: timestamps and freshly generated dataset IDs are excluded. */
export function googleIdentityPreviewFingerprint(dataset: Dataset): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({ source: dataset.source, records: dataset.records }),
      ),
    )
    .digest("hex");
}

export function assertGoogleIdentityPreviewFingerprint(
  supplied: string,
  current: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(supplied) || supplied !== current)
    throw new HttpError(
      409,
      "GOOGLE_IDENTITY_PREVIEW_STALE",
      "The Google row preview changed. Review the current rows and confirm again before creating metadata.",
    );
}

/**
 * Reads the bounded source anew without writing any Google metadata. Existing
 * records are retained solely through their opaque row metadata identity;
 * row number and visible contents are never used as a matching fallback.
 */
export async function prepareGoogleIdentityPreview(
  stored: Dataset,
  reader: GoogleSheetsReader,
  userId: string,
): Promise<GoogleIdentityPreview> {
  const selection = selectionForPreview(stored);
  const freshDraft = await reader.importSelection(selection, userId);
  const fresh = freshDraft.dataset;
  const storedSource = stored.source as GoogleSource;
  const freshSource = fresh.source as GoogleSource;
  assertSameSourceSchema(storedSource, freshSource);

  const existing = trackedRecords(stored.records);
  let added = 0;
  const records = fresh.records.map((record) => {
    const prior = record.sourceIdentity
      ? existing.get(record.sourceIdentity)
      : undefined;
    if (!prior) {
      added += 1;
      return record;
    }
    return {
      ...record,
      id: prior.id,
      revision: prior.revision + (sourceRecordChanged(prior, record) ? 1 : 0),
    };
  });

  // Preserve local presentation/settings and the original connector owner.
  // Only remote canonical cell values, formula locks, and current row locations
  // flow from the freshly read source.
  const source: SourceInfo = {
    ...stored.source,
    identityStrategy: "developer-metadata",
    developerMetadataKey: selection.developerMetadataKey,
    developerMetadataConsent: true,
    readOnly: fresh.source.readOnly,
    ...(fresh.source.readOnlyReason
      ? { readOnlyReason: fresh.source.readOnlyReason }
      : {}),
  };
  if (!fresh.source.readOnly) delete source.readOnlyReason;
  const dataset = validateDataset({
    ...stored,
    source,
    fields: stored.fields,
    mapping: stored.mapping,
    records,
    // A preview cannot claim a local revision or wall-clock update.
    revision: stored.revision,
    updatedAt: stored.updatedAt,
  });
  return {
    dataset,
    fingerprint: googleIdentityPreviewFingerprint(dataset),
    added,
  };
}
