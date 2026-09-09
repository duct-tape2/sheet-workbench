import * as engine from '../../../../packages/local/src/index';

const methods = ['inspectInput', 'importInput', 'runOperation', 'replayRecipe', 'exportCsv', 'exportTableXlsx', 'exportOriginal', 'validateRecipe', 'makeSample'] as const;
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (!data || !methods.includes(data.method) || !Array.isArray(data.args)) throw new Error('Unsupported file operation.');
    const method = data.method as typeof methods[number];
    const fn = engine[method] as unknown as (...args: unknown[]) => unknown;
    const value = await fn(...data.args);
    self.postMessage({ ok: true, value });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'The file operation failed.' });
  }
};
