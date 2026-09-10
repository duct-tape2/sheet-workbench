/** Browser-safe protocol types for the authenticated loopback companion. */
export type CompanionScalar = string | number | boolean | null;

export type CompanionFileKind = "xlsx" | "pdf" | "image" | "text";

export interface CompanionFile {
  id: string;
  name: string;
  size: number;
  sha256: string;
  kind: CompanionFileKind;
  status: "ready" | "rejected";
}

export interface WorkbookFlags {
  hasVba: boolean;
  hasExternalLinks: boolean;
  hasPowerQuery: boolean;
  hasConnections: boolean;
  hasFormulaErrors: boolean;
}

export interface ProfileCell {
  address: string;
  value: CompanionScalar;
  formula?: string;
}

/** A bounded, value-free structural summary for review and AI context. */
export interface WorkbookSheetStructure {
  hiddenRows: string[];
  hiddenColumns: string[];
  mergedRanges: string[];
  tables: string[];
  truncated: boolean;
}

export interface WorkbookSheetProfile {
  name: string;
  hidden: boolean;
  populatedCells: ProfileCell[];
  truncated: boolean;
  structure: WorkbookSheetStructure;
}

export interface WorkbookProfile {
  sheets: WorkbookSheetProfile[];
  /** Defined-name labels only; formula definitions stay inside the workbook. */
  definedNames: string[];
  definedNamesTruncated: boolean;
  flags: WorkbookFlags;
  readOnlyReasons: string[];
}

export interface EvidenceReference {
  fileId: string;
  line?: number;
  page?: number;
  quote?: string;
}

export interface ProposedChange {
  sheet: string;
  address: string;
  before: CompanionScalar;
  after: CompanionScalar;
  evidence?: EvidenceReference[];
}

export interface AiProposal {
  changes: ProposedChange[];
  questions: string[];
  summary: string;
}

export interface AiProposeRequest {
  fileId: string;
  evidenceFileIds: string[];
  period: string;
  rules: string[];
  request: string;
  mode?: "local" | "cloud";
  cloudConsent?: boolean;
  costAcknowledged?: boolean;
}

export interface PatchCheck {
  sheet: string;
  address: string;
  expected: CompanionScalar;
}

export interface ApprovedPatch {
  sourceId: string;
  sourceHash: string;
  requestId: string;
  period: string;
  changes: ProposedChange[];
  checks: PatchCheck[];
  approved: true;
}

export interface CompanionRun {
  id: string;
  status: "draft" | "verified";
  sourceId: string;
  sourceHash: string;
  requestId: string;
  changed: number;
  verification: "not-run" | "native-excel";
  download?: string;
}

export interface CompanionCapabilities {
  excel: boolean;
  xlwings: boolean;
  docling: boolean;
  ollama: boolean;
}

export interface CompanionHealth {
  ok: true;
  version: string;
  capabilities: CompanionCapabilities;
  limits: {
    uploadBytes: number;
    profileCellsPerSheet: number;
  };
  cloud?: {
    configured: boolean;
    provider: string;
    model?: string;
  };
}
