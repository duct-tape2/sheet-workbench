import type * as Engine from '../../../../packages/local/src/index';
import type { InputFile, Selection, TableData, Operation, SourceDocument, Recipe } from '../../../../packages/local/src/types';

type Method = 'inspectInput' | 'importInput' | 'runOperation' | 'replayRecipe' | 'exportCsv' | 'exportTableXlsx' | 'exportOriginal' | 'validateRecipe' | 'makeSample';
type Api = typeof Engine;
/** A disposable worker makes cancellation real, including synchronous ZIP parsing. */
function request<K extends Method>(method: K, args: unknown[], signal?: AbortSignal): Promise<Awaited<ReturnType<Api[K]>>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      if (error) reject(error); else resolve(value as Awaited<ReturnType<Api[K]>>);
    };
    const cancel = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(() => finish(new Error('Processing timed out. Try a smaller file or selection.')), 120_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new Error('The file processor stopped. Your original file has not changed.')); };
    worker.onmessage = ({ data }) => {
      if (data?.ok === true) finish(undefined, data.value);
      else finish(new Error(typeof data?.error === 'string' ? data.error : 'The file could not be processed.'));
    };
    try { worker.postMessage({ method, args }); } catch (error) { finish(error instanceof Error ? error : new Error('Could not open the file processor.')); }
  });
}
export const inspectInput = (file: InputFile, signal?: AbortSignal) => request('inspectInput', [file], signal);
export const importInput = (file: InputFile, selection: Selection = {}, signal?: AbortSignal) => request('importInput', [file, selection], signal);
export const runOperation = (table: TableData, operation: Operation, sources: SourceDocument[], signal?: AbortSignal) => request('runOperation', [table, operation, sources], signal);
export const replayRecipe = (recipe: Recipe, sources: SourceDocument[], signal?: AbortSignal) => request('replayRecipe', [recipe, sources], signal);
export const exportCsv = (table: TableData, signal?: AbortSignal) => request('exportCsv', [table], signal);
export const exportTableXlsx = (table: TableData, signal?: AbortSignal) => request('exportTableXlsx', [table], signal);
export const exportOriginal = (source: SourceDocument, table: TableData, signal?: AbortSignal) => request('exportOriginal', [source, table], signal);
export const validateRecipe = (value: unknown, signal?: AbortSignal) => request('validateRecipe', [value], signal);
export const makeSample = (kind: 'clean' | 'append' | 'compare', locale: 'en' | 'ko', signal?: AbortSignal) => request('makeSample', [kind, locale], signal);
