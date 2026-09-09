export type CellValue = string | number | boolean | null;
export type Role = "owner" | "editor" | "viewer";
export type Locale = "en" | "ko";
export type FieldType = "text" | "date" | "number" | "select" | "url";
export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
}
export interface Mapping {
  title: string;
  date?: string;
  assignee?: string;
  status?: string;
  category?: string;
  url?: string;
  identity?: string;
}
export interface WorkRecord {
  id: string;
  revision: number;
  values: Record<string, CellValue>;
  sourceRow?: number;
  /**
   * Opaque, adapter-owned row identity. Google developer-metadata sources use
   * this instead of trying to infer a row from visible cell contents.
   */
  sourceIdentity?: string;
  sourceValues?: Record<string, CellValue>;
  lockedFields?: string[];
}
export interface SourceInfo {
  kind: "demo" | "xlsx" | "google";
  template?: string;
  fileName?: string;
  sheetName?: string;
  spreadsheetId?: string;
  sheetId?: number;
  headerRow?: number;
  startColumn?: number;
  endColumn?: number;
  endRow?: number;
  date1904?: boolean;
  sourceColumns?: Record<string, string>;
  sourceHeaders?: Record<string, string>;
  connectedBy?: string;
  identityColumn?: string;
  /** Google row locator chosen at import or through explicit identity consent. */
  identityStrategy?: "column" | "developer-metadata";
  /** Dataset-scoped Google developer-metadata key; never a user data column. */
  developerMetadataKey?: string;
  /** Records that adding row metadata was explicitly approved for this source. */
  developerMetadataConsent?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
}
export interface Dataset {
  id: string;
  name: string;
  source: SourceInfo;
  fields: Field[];
  mapping: Mapping;
  records: WorkRecord[];
  revision: number;
  locale: Locale;
  timeZone: string;
  dateOrder: "ymd" | "dmy" | "mdy";
  weekStartsOn: 0 | 1;
  updatedAt: string;
  completedStatuses: string[];
  categoryColors?: Record<string, number>;
  /** Source-attempt telemetry; it never changes the data `updatedAt` timestamp. */
  lastCheckedAt?: string;
  lastSyncError?: string;
}
export interface RecordPatch {
  operationId: string;
  recordId: string;
  baseRevision: number;
  changes: Record<string, CellValue>;
}
export interface ChangeEntry {
  id: string;
  operationId: string;
  recordId: string;
  actor: string;
  at: string;
  before: Record<string, CellValue>;
  after: Record<string, CellValue>;
  revision: number;
}
export interface SourceCapabilities {
  read: boolean;
  write: boolean;
  append: boolean;
  preservesFormulas: boolean;
}
export interface SourceAdapter {
  capabilities: SourceCapabilities;
  read(): Promise<Dataset>;
  apply(patch: RecordPatch): Promise<WorkRecord>;
}
