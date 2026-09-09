import { validateRecipe } from '../../../../packages/local/src/index';
import type {
  LocalProject,
  Selection,
  SourceDocument,
  TableData,
} from '../../../../packages/local/src/types';

const database = 'sheet-workbench-personal-v1';
const storeName = 'projects';
const current = 'current';
const storedKind = 'sheet-workbench-local-project';
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 100;
const MAX_SOURCES = 100;
const MAX_HISTORY = 100;
const MAX_TEXT = 10_000;
const MAX_TOTAL_TEXT = 25 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type StoredProject = {
  kind: typeof storedKind;
  revision: string;
  project: LocalProject;
};

type ValidationBudget = { text: number };

// `undefined` means this tab has not loaded the saved copy. `null` means it
// observed an empty store. A revision is the exact snapshot this tab may edit.
let expectedRevision: string | null | undefined;
let revisionCounter = 0;

function fail(message: string): never {
  throw new Error(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function assertSafeId(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || FORBIDDEN_KEYS.has(value))
    fail(message);
}

function assertText(
  value: unknown,
  message: string,
  budget: ValidationBudget,
  maxLength = MAX_TEXT,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) fail(message);
  budget.text += value.length;
  if (budget.text > MAX_TOTAL_TEXT) fail('Stored project text exceeds the supported limit.');
}

function assertOptionalText(
  value: unknown,
  message: string,
  budget: ValidationBudget,
  maxLength = MAX_TEXT,
): void {
  if (value === undefined) return;
  assertText(value, message, budget, maxLength);
}

function assertPositiveInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(message);
}

// Kept in sync with the engine: a source ID identifies both its bytes and the
// selected rectangle within those bytes.
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function selectionIdentity(selection: Selection): string {
  return JSON.stringify({
    sheetName: selection.sheetName ?? '',
    headerRow: selection.headerRow ?? 0,
    startColumn: selection.startColumn ?? 0,
    endColumn: selection.endColumn ?? 0,
    endRow: selection.endRow ?? 0,
    encoding: (selection.encoding ?? 'utf-8').toLocaleLowerCase(),
    delimiter: selection.delimiter ?? ',',
  });
}

function assertSelection(value: unknown, budget: ValidationBudget): asserts value is Selection {
  if (!plainObject(value) || !onlyKeys(value, ['sheetName', 'headerRow', 'startColumn', 'endColumn', 'endRow', 'encoding', 'delimiter']))
    fail('Stored source selection is invalid.');
  assertOptionalText(value.sheetName, 'Stored source selection is invalid.', budget, 160);
  assertOptionalText(value.encoding, 'Stored source selection is invalid.', budget, 32);
  if (value.delimiter !== undefined && (typeof value.delimiter !== 'string' || value.delimiter.length !== 1))
    fail('Stored source selection is invalid.');
  for (const key of ['headerRow', 'startColumn', 'endColumn', 'endRow'] as const)
    if (value[key] !== undefined) assertPositiveInteger(value[key], 'Stored source selection is invalid.');
  const startColumn = value.startColumn;
  const endColumn = value.endColumn;
  const headerRow = value.headerRow;
  const endRow = value.endRow;
  if (typeof startColumn === 'number' && typeof endColumn === 'number' && endColumn < startColumn)
    fail('Stored source selection is invalid.');
  if (typeof headerRow === 'number' && typeof endRow === 'number' && endRow <= headerRow)
    fail('Stored source selection is invalid.');
}

function assertOrigin(value: unknown, budget: ValidationBudget): void {
  if (!plainObject(value) || !onlyKeys(value, ['sourceId', 'sheet', 'row', 'column']))
    fail('Stored row provenance is invalid.');
  assertSafeId(value.sourceId, 'Stored row provenance is invalid.');
  assertPositiveInteger(value.row, 'Stored row provenance is invalid.');
  assertOptionalText(value.sheet, 'Stored row provenance is invalid.', budget, 160);
  if (value.column !== undefined) assertSafeId(value.column, 'Stored row provenance is invalid.');
}

function assertTable(value: unknown, budget: ValidationBudget): asserts value is TableData {
  if (!plainObject(value) || !onlyKeys(value, ['id', 'name', 'columns', 'rows']))
    fail('Stored table is invalid or exceeds the supported limit.');
  assertSafeId(value.id, 'Stored table is invalid or exceeds the supported limit.');
  assertText(value.name, 'Stored table is invalid or exceeds the supported limit.', budget, 160);
  if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > MAX_COLUMNS)
    fail('Stored table is invalid or exceeds the supported limit.');
  if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS)
    fail('Stored table is invalid or exceeds the supported limit.');

  const keys = new Set<string>();
  for (const column of value.columns) {
    if (!plainObject(column) || !onlyKeys(column, ['key', 'label', 'type']))
      fail('Stored column definitions are invalid.');
    assertSafeId(column.key, 'Stored column definitions are invalid.');
    assertText(column.label, 'Stored column definitions are invalid.', budget);
    if (!['text', 'number', 'date', 'boolean'].includes(String(column.type)) || keys.has(column.key))
      fail('Stored column definitions are invalid.');
    keys.add(column.key);
  }

  const rowIds = new Set<string>();
  for (const row of value.rows) {
    if (!plainObject(row) || !onlyKeys(row, ['id', 'values', 'origins', 'locked']))
      fail('Stored row is invalid.');
    assertSafeId(row.id, 'Stored row is invalid.');
    if (rowIds.has(row.id) || !plainObject(row.values) || !Array.isArray(row.origins))
      fail('Stored row is invalid.');
    rowIds.add(row.id);
    if (row.origins.length > MAX_ROWS) fail('Stored row provenance exceeds the supported limit.');
    for (const origin of row.origins) assertOrigin(origin, budget);
    for (const [key, cell] of Object.entries(row.values)) {
      if (!keys.has(key)) fail('Stored cell is invalid.');
      if (typeof cell === 'string') {
        if (cell.length > MAX_TEXT) fail('Stored cell is invalid.');
        budget.text += cell.length;
        if (budget.text > MAX_TOTAL_TEXT) fail('Stored project text exceeds the supported limit.');
      } else if (cell !== null && typeof cell !== 'boolean' && (typeof cell !== 'number' || !Number.isFinite(cell))) {
        fail('Stored cell is invalid.');
      }
    }
    if (row.locked !== undefined) {
      if (!Array.isArray(row.locked) || row.locked.length > MAX_COLUMNS || row.locked.some((key) => typeof key !== 'string' || !keys.has(key)) || new Set(row.locked).size !== row.locked.length)
        fail('Stored locked fields are invalid.');
    }
  }
}

function assertSource(value: unknown, budget: ValidationBudget): asserts value is SourceDocument {
  if (!plainObject(value) || !onlyKeys(value, ['id', 'name', 'hash', 'size', 'importedAt', 'selection', 'table', 'bytes', 'format']))
    fail('Stored original file is unavailable.');
  assertSafeId(value.id, 'Stored original file is unavailable.');
  assertText(value.name, 'Stored original file is unavailable.', budget, 160);
  assertSafeId(value.hash, 'Stored original file is unavailable.');
  if (!(value.bytes instanceof Uint8Array) || !Number.isSafeInteger(value.size) || value.size !== value.bytes.byteLength || value.size > MAX_BYTES)
    fail('Stored original file is unavailable.');
  if (value.format !== 'csv' && value.format !== 'xlsx')
    fail('Stored original file is unavailable.');
  if (typeof value.importedAt !== 'string' || !Number.isFinite(Date.parse(value.importedAt)))
    fail('Stored original file is unavailable.');
  assertSelection(value.selection, budget);
  const expectedId = `source-${value.hash.slice(0, 24)}-${stableHash(`${value.format}|${selectionIdentity(value.selection)}`)}`;
  if (value.id !== expectedId) fail('Stored original file is unavailable.');
  assertTable(value.table, budget);
  if (value.table.id !== `table-${value.id}`) fail('Stored original file is unavailable.');
}

function assertOriginsKnown(table: TableData, sourceIds: Set<string>): void {
  for (const row of table.rows)
    for (const origin of row.origins)
      if (!sourceIds.has(origin.sourceId)) fail('Stored row provenance references an unavailable source.');
}

function assertUpdatedAt(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail('Stored project timestamp is invalid.');
}

/** Validate the complete persisted contract before using any device-stored value. */
export function validateStoredProject(project: unknown): asserts project is LocalProject {
  const budget: ValidationBudget = { text: 0 };
  if (!plainObject(project) || !onlyKeys(project, ['version', 'id', 'name', 'sources', 'primaryId', 'steps', 'table', 'undo', 'redo', 'updatedAt']))
    fail('Stored project is incompatible. Open the original files again.');
  if (project.version !== 1 || !Array.isArray(project.sources) || !project.sources.length || project.sources.length > MAX_SOURCES || !Array.isArray(project.steps) || project.steps.length > MAX_HISTORY || !Array.isArray(project.undo) || !Array.isArray(project.redo))
    fail('Stored project is incompatible. Open the original files again.');
  assertSafeId(project.id, 'Stored project is incompatible. Open the original files again.');
  assertText(project.name, 'Stored project is incompatible. Open the original files again.', budget, 160);
  assertSafeId(project.primaryId, 'Stored project is incompatible. Open the original files again.');
  assertUpdatedAt(project.updatedAt);

  let bytes = 0;
  let sourceRows = 0;
  const sourceIds = new Set<string>();
  for (const source of project.sources) {
    assertSource(source, budget);
    if (sourceIds.has(source.id)) fail('Stored project has duplicate source IDs.');
    sourceIds.add(source.id);
    bytes += source.bytes.byteLength;
    sourceRows += source.table.rows.length;
    if (bytes > MAX_BYTES || sourceRows > MAX_ROWS) fail('Stored project exceeds the supported limit.');
  }
  if (!sourceIds.has(project.primaryId)) fail('Stored project references an unavailable primary source.');
  const sources = project.sources as SourceDocument[];

  // Reuse the engine's strict allow-list for declarative, executable steps.
  let recipe;
  try {
    recipe = validateRecipe({
      version: 1,
      name: project.name,
      primaryId: project.primaryId,
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        columns: source.table.columns.map((column) => column.key),
        selection: source.selection,
      })),
      steps: project.steps,
    });
  } catch {
    fail('Stored project operations are invalid.');
  }
  for (const step of recipe.steps)
    if ('sourceId' in step && !sourceIds.has(step.sourceId))
      fail('Stored project operation references an unavailable source.');

  assertTable(project.table, budget);
  assertOriginsKnown(project.table, sourceIds);
  if (project.undo.length > MAX_HISTORY || project.redo.length > MAX_HISTORY)
    fail('Stored history exceeds the supported limit.');
  let historyRows = 0;
  for (const table of [...project.undo, ...project.redo]) {
    assertTable(table, budget);
    assertOriginsKnown(table, sourceIds);
    historyRows += table.rows.length;
    if (historyRows > MAX_ROWS) fail('Stored history exceeds the supported limit.');
  }
}

function legacyRevision(project: LocalProject): string {
  return `legacy-${project.updatedAt}`;
}

function readStored(value: unknown): StoredProject {
  if (!plainObject(value)) fail('Stored project is incompatible. Open the original files again.');
  if ('kind' in value) {
    if (!onlyKeys(value, ['kind', 'revision', 'project']) || value.kind !== storedKind || typeof value.revision !== 'string' || !SAFE_ID.test(value.revision))
      fail('Stored project is incompatible. Open the original files again.');
    validateStoredProject(value.project);
    return { kind: storedKind, revision: value.revision, project: value.project };
  }
  // Version-1 records were bare projects. They remain readable and are
  // upgraded to an envelope after the next successful compare-and-save.
  validateStoredProject(value);
  return { kind: storedKind, revision: legacyRevision(value), project: value };
}

function nextRevision(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `r-${uuid}`;
  revisionCounter += 1;
  return `r-${Date.now().toString(36)}-${revisionCounter.toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('Device storage is unavailable. Download your result before closing this tab.'));
      return;
    }
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onblocked = () => reject(new Error('Device storage is blocked by another tab. Close the other tab and retry.'));
    request.onerror = () => reject(new Error('Device storage could not be opened. Your work is still in this tab.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function storageFailure(): Error {
  return new Error('Device storage failed or is full. Download your work; it has not been safely saved.');
}

async function compareAndWrite(project: LocalProject): Promise<void> {
  validateStoredProject(project);
  const expected = expectedRevision;
  const db = await open();
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let committedRevision: string | undefined;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const read = store.get(current);
      read.onerror = () => {
        failure = storageFailure();
        tx.abort();
      };
      read.onsuccess = () => {
        try {
          const existing = read.result === undefined ? undefined : readStored(read.result);
          if (expected === undefined && existing)
            fail('A saved device copy already exists. Load it before replacing it.');
          if (expected === null && existing)
            fail('The saved device copy changed in another tab. Load it before saving again.');
          if (typeof expected === 'string' && (!existing || existing.revision !== expected))
            fail('The saved device copy changed in another tab. Load it before saving again.');
          committedRevision = nextRevision();
          store.put({ kind: storedKind, revision: committedRevision, project }, current);
        } catch (error) {
          failure = error instanceof Error ? error : storageFailure();
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        expectedRevision = committedRevision!;
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(failure ?? storageFailure());
      };
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : storageFailure());
    }
  });
}

async function compareAndDelete(): Promise<void> {
  const expected = expectedRevision;
  const db = await open();
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const read = store.get(current);
      read.onerror = () => {
        failure = storageFailure();
        tx.abort();
      };
      read.onsuccess = () => {
        try {
          const existing = read.result === undefined ? undefined : readStored(read.result);
          if (!existing) return;
          if (expected === undefined)
            fail('A saved device copy already exists. Load it before deleting it.');
          if (expected === null || existing.revision !== expected)
            fail('The saved device copy changed in another tab. Load it before deleting it.');
          store.delete(current);
        } catch (error) {
          failure = error instanceof Error ? error : storageFailure();
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        expectedRevision = null;
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(failure ?? storageFailure());
      };
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : storageFailure());
    }
  });
}

export async function saveProject(project: LocalProject): Promise<void> {
  await compareAndWrite(project);
}

export async function loadProject(): Promise<LocalProject | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    try {
      const tx = db.transaction(storeName, 'readonly');
      const read = tx.objectStore(storeName).get(current);
      read.onerror = () => {
        failure = storageFailure();
        tx.abort();
      };
      read.onsuccess = () => {
        try {
          if (read.result === undefined) {
            expectedRevision = null;
            return;
          }
          const stored = readStored(read.result);
          expectedRevision = stored.revision;
          resolve(stored.project);
        } catch (error) {
          failure = error instanceof Error ? error : storageFailure();
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        if (read.result === undefined) resolve(null);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(failure ?? storageFailure());
      };
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : storageFailure());
    }
  });
}

export async function deleteProject(): Promise<void> {
  await compareAndDelete();
}
