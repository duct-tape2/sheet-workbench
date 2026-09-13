import type { CellValue } from '../../core/src/types';

export interface Column { key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean' }
export interface Origin { sourceId: string; sheet?: string; row: number; column?: string }
export interface LocalRow { id: string; values: Record<string, CellValue>; origins: Origin[]; locked?: string[] }
export interface TableData { id: string; name: string; columns: Column[]; rows: LocalRow[] }
export interface InputFile { id: string; name: string; bytes: Uint8Array }
export interface Selection { sheetName?: string; headerRow?: number; startColumn?: number; endColumn?: number; endRow?: number; encoding?: string; delimiter?: string }
export interface SourceDocument { id: string; name: string; hash: string; size: number; importedAt: string; selection: Selection; table: TableData; bytes: Uint8Array; format: 'xlsx' | 'csv' }
export type Operation =
 | { kind: 'trim'; columns: string[] }
 | { kind: 'blankRows' }
 | { kind: 'dedupe'; keys: string[] }
 | { kind: 'replace'; column: string; from: string; to: string }
 | { kind: 'convert'; column: string; to: 'number' | 'date' | 'text'; dateOrder?: 'ymd' | 'dmy' | 'mdy' }
 | { kind: 'append'; sourceId: string; mapping: Record<string, string> }
 | { kind: 'compare'; sourceId: string; keys: Array<[string,string]>; columns: Array<[string,string]> }
 | { kind: 'lookup'; sourceId: string; keys: Array<[string,string]>; columns: Array<[string,string]> }
 | { kind: 'summary'; groups: string[]; sums: string[] };
export interface Change { rowId: string; column?: string; before?: CellValue; after?: CellValue; kind: 'changed' | 'added' | 'removed' | 'same' | 'conflict'; message?: string }
export interface OperationResult { table: TableData; changes: Change[]; warnings: string[]; blocked: boolean }
/** A declarative, all-or-nothing local operation sequence. Draft snapshots are
 * exposed for UI review, but `table` is always the original table unless the
 * entire sequence completes successfully. */
export interface OperationBatchResult {
  status: 'completed' | 'cancelled' | 'blocked'
  table: TableData
  snapshots: Array<{ operation: Operation; result: OperationResult }>
  changes: Change[]
  warnings: string[]
  blocked: boolean
}
export interface Recipe { version: 1; name: string; primaryId: string; sources: Array<{ id: string; name: string; columns: string[]; selection?: Selection }>; steps: Operation[] }
export interface LocalProject { version: 1; id: string; name: string; sources: SourceDocument[]; primaryId: string; steps: Operation[]; table: TableData; undo: TableData[]; redo: TableData[]; updatedAt: string }
