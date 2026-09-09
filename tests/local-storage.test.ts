import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInput } from '../packages/local/src/index.ts';
import type { LocalProject } from '../packages/local/src/types.ts';

type Listener = ((event: Event) => void) | null;

class MemoryRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
}

class MemoryTransaction {
  oncomplete: Listener = null;
  onabort: Listener = null;
  onerror: Listener = null;
  private pending = 0;
  private aborted = false;
  private completionQueued = false;

  constructor(private readonly values: Map<string, unknown>) {}

  objectStore(): MemoryStore {
    return new MemoryStore(this, this.values);
  }

  enqueue(run: () => void): void {
    this.pending += 1;
    queueMicrotask(() => {
      if (!this.aborted) run();
      this.pending -= 1;
      this.completeWhenIdle();
    });
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.(new Event('abort')));
  }

  private completeWhenIdle(): void {
    if (this.aborted || this.pending || this.completionQueued) return;
    this.completionQueued = true;
    queueMicrotask(() => {
      if (!this.aborted && !this.pending) this.oncomplete?.(new Event('complete'));
    });
  }
}

class MemoryStore {
  constructor(
    private readonly tx: MemoryTransaction,
    private readonly values: Map<string, unknown>,
  ) {}

  get(key: string): MemoryRequest<unknown> {
    const request = new MemoryRequest<unknown>();
    this.tx.enqueue(() => {
      request.result = this.values.has(key) ? structuredClone(this.values.get(key)) : undefined;
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }

  put(value: unknown, key: string): MemoryRequest<string> {
    const request = new MemoryRequest<string>();
    this.tx.enqueue(() => {
      this.values.set(key, structuredClone(value));
      request.result = key;
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }

  delete(key: string): MemoryRequest<undefined> {
    const request = new MemoryRequest<undefined>();
    this.tx.enqueue(() => {
      this.values.delete(key);
      request.result = undefined;
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
}

class MemoryDatabase {
  onversionchange: Listener = null;
  readonly objectStoreNames = { contains: () => true };

  constructor(private readonly values: Map<string, unknown>) {}

  createObjectStore(): MemoryStore {
    return new MemoryTransaction(this.values).objectStore();
  }

  transaction(): MemoryTransaction {
    return new MemoryTransaction(this.values);
  }

  close(): void {}
}

class MemoryIndexedDb {
  readonly values = new Map<string, unknown>();

  open(): MemoryRequest<MemoryDatabase> {
    const request = new MemoryRequest<MemoryDatabase>() as MemoryRequest<MemoryDatabase> & {
      onupgradeneeded: Listener;
      onblocked: Listener;
    };
    request.onupgradeneeded = null;
    request.onblocked = null;
    request.result = new MemoryDatabase(this.values);
    queueMicrotask(() => {
      request.onupgradeneeded?.(new Event('upgradeneeded'));
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
}

async function project(name = 'Data'): Promise<LocalProject> {
  const source = await importInput({
    id: 'storage-fixture',
    name: 'data.csv',
    bytes: new TextEncoder().encode('ID\n001'),
  });
  const table = { ...source.table, name };
  return {
    version: 1,
    id: 'local-workbench',
    name,
    sources: [source],
    primaryId: source.id,
    steps: [],
    table,
    undo: [],
    redo: [],
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
}

async function storageModule() {
  return import('../apps/web/src/local/storage.ts');
}

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let indexedDb: MemoryIndexedDb;

beforeEach(() => {
  vi.resetModules();
  indexedDb = new MemoryIndexedDb();
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: indexedDb,
  });
});

afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe('local project storage', () => {
  it('rejects malformed stored projects instead of accepting malformed provenance, operations, or locks', async () => {
    const { validateStoredProject } = await storageModule();
    const valid = await project();
    expect(() => validateStoredProject(valid)).not.toThrow();

    const unknownField = structuredClone(valid) as LocalProject & { unexpected?: boolean };
    unknownField.unexpected = true;
    expect(() => validateStoredProject(unknownField)).toThrow(/incompatible/i);

    const invalidOrigin = structuredClone(valid);
    invalidOrigin.table.rows[0].origins = [{} as never];
    expect(() => validateStoredProject(invalidOrigin)).toThrow(/provenance/i);

    const invalidLock = structuredClone(valid);
    invalidLock.table.rows[0].locked = ['missing'];
    expect(() => validateStoredProject(invalidLock)).toThrow(/locked/i);

    const invalidOperation = structuredClone(valid);
    invalidOperation.steps = [{ kind: 'not-supported' } as never];
    expect(() => validateStoredProject(invalidOperation)).toThrow(/operations/i);

    const changedSelection = structuredClone(valid);
    changedSelection.sources[0].selection.endRow = 3;
    expect(() => validateStoredProject(changedSelection)).toThrow(/original file is unavailable/i);
  });

  it('reads a legacy bare project and upgrades it only after a compare-and-save', async () => {
    indexedDb.values.set('current', structuredClone(await project('Legacy')));
    const storage = await storageModule();
    await expect(storage.loadProject()).resolves.toMatchObject({ name: 'Legacy' });

    await storage.saveProject(await project('Migrated'));
    expect(indexedDb.values.get('current')).toMatchObject({
      kind: 'sheet-workbench-local-project',
      project: { name: 'Migrated' },
    });
  });

  it('rejects a stale second tab save rather than overwriting the newer device copy', async () => {
    const tabA = await storageModule();
    await expect(tabA.loadProject()).resolves.toBeNull();
    await tabA.saveProject(await project('First'));
    await tabA.loadProject();

    vi.resetModules();
    const tabB = await storageModule();
    await tabB.loadProject();

    await tabA.saveProject(await project('Newest'));
    await expect(tabB.saveProject(await project('Stale'))).rejects.toThrow(/changed in another tab/i);
    await expect(tabA.loadProject()).resolves.toMatchObject({ name: 'Newest' });
  });

  it('rejects a stale delete rather than deleting a newer device copy', async () => {
    const tabA = await storageModule();
    await expect(tabA.loadProject()).resolves.toBeNull();
    await tabA.saveProject(await project('First'));
    await tabA.loadProject();

    vi.resetModules();
    const tabB = await storageModule();
    await tabB.loadProject();

    await tabA.saveProject(await project('Newest'));
    await expect(tabB.deleteProject()).rejects.toThrow(/changed in another tab/i);
    await expect(tabA.loadProject()).resolves.toMatchObject({ name: 'Newest' });
  });
});
