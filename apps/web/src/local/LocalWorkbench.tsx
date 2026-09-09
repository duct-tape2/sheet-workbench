import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  FileDown,
  FileSpreadsheet,
  FolderOpen,
  History,
  Languages,
  LoaderCircle,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type {
  Change,
  Column,
  InputFile,
  LocalProject,
  LocalRow,
  Operation,
  OperationResult,
  Recipe,
  Selection,
  SourceDocument,
  TableData,
} from "../../../../packages/local/src/types";
import {
  deleteProject,
  loadProject,
  saveProject,
} from "./storage";
import {
  exportCsv,
  exportOriginal,
  exportTableXlsx,
  importInput,
  inspectInput,
  makeSample,
  replayRecipe,
  runOperation,
  validateRecipe,
} from "./runtime";
import LocalViews from "./LocalViews";
import "./local.css";

type Locale = "en" | "ko";
type HomeAction = "clean" | "append" | "compare" | "recipe";
type Pending =
  | { kind: "operation"; result: OperationResult; operation: Operation }
  | { kind: "paste"; result: OperationResult; operation: null }
  | { kind: "recipe"; result: OperationResult; recipe: Recipe };
type Cell = { rowId: string; column: string };
type PairedHistory = { table: TableData; steps: Operation[] };
type Inspection = Awaited<ReturnType<typeof inspectInput>>;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 10_000;
const OPERATIONS = [
  "trim",
  "blankRows",
  "dedupe",
  "replace",
  "convert",
  "append",
  "compare",
  "lookup",
  "summary",
] as const;

const copy = {
  en: {
    product: "Sheet Workbench",
    tag: "Local file workspace",
    open: "Open files",
    samples: "Try a synthetic sample",
    clean: "Clean a file",
    append: "Append files",
    compare: "Compare files",
    recipe: "Run a recipe",
    cleanHint: "Trim spaces, remove blanks, standardize values.",
    appendHint: "Stack matching files without touching their originals.",
    compareHint: "Find changes, look up values, or reconcile columns.",
    recipeHint: "Replay versioned cleanup steps on new local files.",
    noSources: "Open a .xlsx or .csv file to begin. Files are processed in this browser.",
    commonJobs: "Three common jobs",
    jobAppend: "Append files: add rows from an incoming file to the current file.",
    jobCompare: "Compare by ID: check the current file against a previous or newer version.",
    jobLookup: "Look up values: bring reference columns into the current file by ID.",
    sources: "Sources",
    result: "Result",
    history: "Operation history",
    openFiles: "Open local files",
    source: "Current source",
    currentFile: "Current file",
    incomingFile: "Incoming file",
    comparisonFile: "Comparison file",
    referenceFile: "Reference file",
    appendRole: "Add rows from the incoming file. Map each current column to its incoming column.",
    compareRole: "Check this current file against a previous or newer file by ID.",
    lookupRole: "Bring selected reference values into this current file by ID.",
    keySafety: "ID check",
    keySafetyHint: "The review stops when either file has a blank or duplicate ID key.",
    selectKey: "Select at least one ID key column before reviewing.",
    mapKey: "Map every selected ID key to the other file before reviewing.",
    primary: "Primary source",
    switchPrimary: "Use as primary",
    inspect: "Review import",
    accept: "Accept source",
    selected: "Selected files",
    sheet: "Sheet",
    header: "Header row",
    firstColumn: "First column",
    lastColumn: "Last column",
    lastRow: "Last row",
    encoding: "CSV encoding",
    delimiter: "CSV delimiter",
    preview: "Preview",
    rows: "rows",
    columns: "columns",
    fileLimit: "Up to 25 MiB and 10,000 imported rows across all sources.",
    sourceTooLarge: "Selected files are larger than 25 MiB in total.",
    rowLimit: "This source exceeds the 10,000-row local preview limit.",
    apply: "Apply changes",
    review: "Review changes",
    cancel: "Cancel",
    close: "Close",
    back: "Back",
    warnings: "Warnings",
    blocked: "This preview is blocked. Resolve the warning before applying it.",
    changes: "changes",
    noChanges: "No cells would change.",
    undo: "Undo",
    redo: "Redo",
    undoLabel: "Undo last confirmed action",
    redoLabel: "Redo last action",
    search: "Search result",
    sort: "Sort",
    filter: "Filter",
    allValues: "All values",
    visibleColumns: "Columns",
    operations: "Operations",
    operation: "Operation",
    trim: "Trim whitespace",
    blankRows: "Remove blank rows",
    dedupe: "Remove duplicates",
    replace: "Find and replace",
    convert: "Convert type",
    appendOp: "Append source",
    compareOp: "Compare source",
    lookup: "Look up columns",
    summary: "Summarize",
    chooseColumns: "Choose columns",
    keyColumns: "Key columns",
    sourceColumns: "Source columns",
    targetColumns: "Target columns",
    find: "Find",
    replaceWith: "Replace with",
    conversion: "Convert to",
    dateOrder: "Date order",
    addMapping: "Add column mapping",
    mappingHint: "Choose one or more key columns above. Add a mapping for each differently named key; remaining mappings are fields to compare or look up.",
    runPreview: "Review result",
    formulasLocked: "Formula and protected cells are locked.",
    cellLocked: "This formula or protected cell cannot be edited here.",
    editCell: "Edit cell",
    saveCell: "Confirm cell edit",
    pasteHint: "Select a cell, then paste a rectangular TSV range. It will be reviewed before applying.",
    pasteViewBlocked: "Clear search, filters, sorting, and hidden columns before pasting multiple cells.",
    individualEdit: "Individual cell edits stay in this result, but are not included in saved recipes.",
    export: "Export",
    resultXlsx: "Result .xlsx",
    resultCsv: "Result .csv",
    original: "Original / formatted file",
    preparing: "Preparing download…",
    downloaded: "Download started.",
    downloadFailed: "Could not prepare that download.",
    keep: "Keep on this device",
    keepHint: "Off by default. No uploads, analytics, or account required.",
    saveDevice: "Save device copy",
    loadDevice: "Load device copy",
    clearDevice: "Clear saved device copy",
    savedDevice: "Saved only on this device.",
    deviceCleared: "Saved device copy removed.",
    deviceEmpty: "No saved device copy found.",
    storageFailed: "This browser could not save the local copy.",
    saveRecipe: "Save recipe",
    loadRecipe: "Load recipe",
    recipeName: "Recipe name",
    recipeSources: "Match recipe sources",
    recipeNeedSources: "Open the files for this recipe, then choose which current source belongs to each saved source.",
    recipeUniqueSources: "Each saved recipe source needs a different opened file.",
    fileRoles: "File roles",
    reviewRecipe: "Review replay",
    noHistory: "Confirmed operations will appear here.",
    resetWarning: "Changing the primary source replaces the in-memory result and clears this session’s undo history. Source files are not changed.",
    continue: "Continue",
    sampleClean: "Cleaning sample",
    sampleAppend: "Append sample",
    sampleCompare: "Compare sample",
    loading: "Working locally…",
    cancelWork: "Cancel work",
    provenance: "Source rows",
    locale: "한국어",
    team: "Open team workspace",
  },
  ko: {
    product: "시트 워크벤치",
    tag: "내 PC 파일 작업 공간",
    open: "파일 열기",
    samples: "가상 샘플 사용",
    clean: "파일 정리",
    append: "파일 이어붙이기",
    compare: "파일 비교",
    recipe: "레시피 실행",
    cleanHint: "공백, 빈 행, 표기 형식을 원본 변경 없이 정리합니다.",
    appendHint: "원본은 건드리지 않고 같은 구조의 파일을 이어붙입니다.",
    compareHint: "바뀐 값 확인, 조회, 열 대조를 합니다.",
    recipeHint: "버전이 있는 정리 단계를 새 로컬 파일에 다시 적용합니다.",
    noSources: ".xlsx 또는 .csv 파일을 열어 시작하세요. 파일은 이 브라우저에서 처리됩니다.",
    commonJobs: "자주 쓰는 세 가지 작업",
    jobAppend: "파일 이어붙이기: 추가할 파일의 행을 현재 파일에 더합니다.",
    jobCompare: "ID로 비교: 현재 파일과 이전 또는 새 버전 파일의 바뀐 값을 확인합니다.",
    jobLookup: "값 조회: 참조 파일의 열을 ID 기준으로 현재 파일에 가져옵니다.",
    sources: "원본 파일",
    result: "결과",
    history: "작업 이력",
    openFiles: "로컬 파일 열기",
    source: "현재 원본",
    currentFile: "현재 파일",
    incomingFile: "추가할 파일",
    comparisonFile: "비교 파일",
    referenceFile: "참조 파일",
    appendRole: "추가할 파일의 행을 더합니다. 현재 파일의 각 열을 추가할 파일의 열과 연결하세요.",
    compareRole: "현재 파일을 이전 또는 새 버전 파일과 ID 기준으로 비교합니다.",
    lookupRole: "참조 파일에서 고른 값을 ID 기준으로 현재 파일에 가져옵니다.",
    keySafety: "ID 확인",
    keySafetyHint: "두 파일 중 하나라도 ID가 비어 있거나 중복되면 확인을 멈춥니다.",
    selectKey: "결과를 확인하기 전에 ID 기준 열을 하나 이상 고르세요.",
    mapKey: "결과를 확인하기 전에 고른 ID 기준 열을 모두 다른 파일의 열과 연결하세요.",
    primary: "기준 원본",
    switchPrimary: "기준 원본으로 사용",
    inspect: "가져오기 확인",
    accept: "원본 받아들이기",
    selected: "선택한 파일",
    sheet: "시트",
    header: "제목 행",
    firstColumn: "첫 열",
    lastColumn: "마지막 열",
    lastRow: "마지막 행",
    encoding: "CSV 인코딩",
    delimiter: "CSV 구분자",
    preview: "미리보기",
    rows: "행",
    columns: "열",
    fileLimit: "합계 25MiB, 모든 원본을 합쳐 10,000행까지 가져올 수 있습니다.",
    sourceTooLarge: "선택한 파일 합계가 25MiB를 넘습니다.",
    rowLimit: "이 원본은 로컬 미리보기 10,000행 제한을 넘습니다.",
    apply: "변경 적용",
    review: "변경 확인",
    cancel: "취소",
    close: "닫기",
    back: "뒤로",
    warnings: "주의",
    blocked: "이 미리보기는 적용할 수 없습니다. 주의 내용을 먼저 해결하세요.",
    changes: "개 변경",
    noChanges: "바뀌는 셀이 없습니다.",
    undo: "되돌리기",
    redo: "다시 실행",
    undoLabel: "마지막 확정 작업 되돌리기",
    redoLabel: "되돌린 작업 다시 실행",
    search: "결과 검색",
    sort: "정렬",
    filter: "필터",
    allValues: "전체 값",
    visibleColumns: "표시할 열",
    operations: "작업",
    operation: "작업 종류",
    trim: "공백 정리",
    blankRows: "빈 행 제거",
    dedupe: "중복 제거",
    replace: "찾아 바꾸기",
    convert: "형식 변환",
    appendOp: "원본 이어붙이기",
    compareOp: "원본 비교",
    lookup: "열 조회",
    summary: "요약",
    chooseColumns: "열 선택",
    keyColumns: "기준 열",
    sourceColumns: "원본 열",
    targetColumns: "결과 열",
    find: "찾을 값",
    replaceWith: "바꿀 값",
    conversion: "바꿀 형식",
    dateOrder: "날짜 순서",
    addMapping: "열 연결 추가",
    mappingHint: "위에서 기준 열을 하나 이상 고르세요. 이름이 다른 기준 열은 각각 연결하고, 나머지 연결은 비교하거나 조회할 값으로 사용합니다.",
    runPreview: "결과 확인",
    formulasLocked: "수식과 보호된 셀은 잠겨 있습니다.",
    cellLocked: "수식 또는 보호된 셀은 여기서 수정할 수 없습니다.",
    editCell: "셀 수정",
    saveCell: "셀 수정 확정",
    pasteHint: "셀 하나를 선택한 뒤 직사각형 TSV 범위를 붙여 넣으세요. 적용 전 먼저 확인합니다.",
    pasteViewBlocked: "여러 셀을 붙여 넣기 전에 검색, 필터, 정렬, 숨긴 열을 모두 해제하세요.",
    individualEdit: "개별 셀 수정은 현재 결과에는 남지만 저장 레시피에는 포함되지 않습니다.",
    export: "내보내기",
    resultXlsx: "결과 .xlsx",
    resultCsv: "결과 .csv",
    original: "원본 / 서식 파일",
    preparing: "내려받기 준비 중…",
    downloaded: "다운로드를 시작했습니다.",
    downloadFailed: "다운로드를 준비하지 못했습니다.",
    keep: "이 기기에 보관",
    keepHint: "기본은 미보관입니다. 업로드·분석·계정이 필요 없습니다.",
    saveDevice: "기기 사본 저장",
    loadDevice: "기기 사본 불러오기",
    clearDevice: "저장한 기기 사본 지우기",
    savedDevice: "이 기기에만 저장했습니다.",
    deviceCleared: "저장한 기기 사본을 지웠습니다.",
    deviceEmpty: "저장한 기기 사본이 없습니다.",
    storageFailed: "이 브라우저에 로컬 사본을 저장하지 못했습니다.",
    saveRecipe: "레시피 저장",
    loadRecipe: "레시피 불러오기",
    recipeName: "레시피 이름",
    recipeSources: "레시피 원본 연결",
    recipeNeedSources: "이 레시피에 쓸 파일을 연 뒤 저장된 원본마다 현재 파일을 선택하세요.",
    recipeUniqueSources: "저장된 레시피 원본마다 서로 다른 열린 파일을 선택하세요.",
    fileRoles: "파일 역할",
    reviewRecipe: "다시 실행 결과 확인",
    noHistory: "확정한 작업이 여기에 표시됩니다.",
    resetWarning: "기준 원본을 바꾸면 현재 메모리 결과와 되돌리기 이력이 초기화됩니다. 원본 파일은 바뀌지 않습니다.",
    continue: "계속",
    sampleClean: "정리 샘플",
    sampleAppend: "이어붙이기 샘플",
    sampleCompare: "비교 샘플",
    loading: "내 PC에서 처리 중…",
    cancelWork: "작업 취소",
    provenance: "원본 행",
    locale: "English",
    team: "팀 작업 공간 열기",
  },
} as const;

function basename(name: string) {
  return name.replace(/\.[^.]+$/, "") || name;
}

function isLocked(row: LocalRow, column: string) {
  const value = row.values[column];
  return (
    row.locked?.includes(column) ||
    (typeof value === "string" && value.trimStart().startsWith("="))
  );
}

function cloneTable(table: TableData): TableData {
  return {
    ...table,
    columns: table.columns.map((column) => ({ ...column })),
    rows: table.rows.map((row) => ({
      ...row,
      values: { ...row.values },
      origins: row.origins.map((origin) => ({ ...origin })),
      locked: row.locked ? [...row.locked] : undefined,
    })),
  };
}

function download(bytes: BlobPart | Uint8Array, name: string, type: string) {
  const part: BlobPart = bytes instanceof Uint8Array
    ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    : bytes;
  const url = URL.createObjectURL(new Blob([part], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function selectedColumns(columns: Column[], selected: string[]) {
  return selected.length ? selected : columns.map((column) => column.key);
}

function operationName(operation: Operation, locale: Locale) {
  const t = copy[locale];
  return t[operation.kind === "append" ? "appendOp" : operation.kind];
}

function asFileInput(file: File, bytes: Uint8Array): InputFile {
  return { id: crypto.randomUUID(), name: file.name, bytes };
}

function recipeSelectionIdentity(selection: Selection) {
  const requestedEncoding = (selection.encoding ?? "utf-8").toLocaleLowerCase();
  const encoding = requestedEncoding === "utf8" ? "utf-8" : requestedEncoding === "cp949" ? "euc-kr" : requestedEncoding;
  return JSON.stringify({
    sheetName: selection.sheetName ?? "",
    headerRow: selection.headerRow ?? 0,
    startColumn: selection.startColumn ?? 0,
    endColumn: selection.endColumn ?? 0,
    encoding,
    delimiter: selection.delimiter ?? ",",
  });
}

export default function LocalWorkbench({
  locale,
  onLocale,
  onLegacy,
}: {
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onLegacy: () => void;
}) {
  const t = copy[locale];
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [primaryId, setPrimaryId] = useState("");
  const [table, setTable] = useState<TableData | null>(null);
  const [steps, setSteps] = useState<Operation[]>([]);
  const [past, setPast] = useState<PairedHistory[]>([]);
  const [future, setFuture] = useState<PairedHistory[]>([]);
  const [action, setAction] = useState<HomeAction | null>(null);
  const [importing, setImporting] = useState<
    Array<{ file: File; input: InputFile; inspection: Inspection; selection: Selection }>
  >([]);
  const [importError, setImportError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [primaryPrompt, setPrimaryPrompt] = useState<SourceDocument | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [keepDevice, setKeepDevice] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ column: string; direction: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState<{ column: string; value: string } | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const [operationKind, setOperationKind] = useState<(typeof OPERATIONS)[number]>("trim");
  const [operationColumns, setOperationColumns] = useState<string[]>([]);
  const [operationSource, setOperationSource] = useState("");
  const [replaceFrom, setReplaceFrom] = useState("");
  const [replaceTo, setReplaceTo] = useState("");
  const [convertTo, setConvertTo] = useState<"number" | "date" | "text">("text");
  const [dateOrder, setDateOrder] = useState<"ymd" | "dmy" | "mdy">("ymd");
  const [mappingRows, setMappingRows] = useState<Array<[string, string]>>([]);
  const [activeCell, setActiveCell] = useState<Cell | null>(null);
  const [editingCell, setEditingCell] = useState<Cell | null>(null);
  const [editValue, setEditValue] = useState("");
  const [manualEdits, setManualEdits] = useState(false);
  const [recipeToRun, setRecipeToRun] = useState<Recipe | null>(null);
  const [recipeName, setRecipeName] = useState("");
  const [recipeMappings, setRecipeMappings] = useState<Record<string, string>>({});
  const [recipePrompt, setRecipePrompt] = useState(false);
  const [deviceSaved, setDeviceSaved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recipeInput = useRef<HTMLInputElement>(null);

  const primary = sources.find((source) => source.id === primaryId) ?? null;
  const project = useMemo<LocalProject | null>(() => {
    if (!table || !primaryId) return null;
    return {
      version: 1,
      id: "local-workbench",
      name: table.name,
      sources,
      primaryId,
      steps,
      table,
      // LocalProject only stores tables; paired operation history cannot be
      // reconstructed safely after reload, so it is intentionally not saved.
      undo: [],
      redo: [],
      updatedAt: new Date().toISOString(),
    };
  }, [sources, primaryId, steps, table, past, future]);
  const columns = table?.columns ?? [];
  const shownColumns = visible.length ? columns.filter((c) => visible.includes(c.key)) : columns;
  const hasHiddenColumns = visible.length > 0 && visible.length < columns.length;
  const rows = useMemo(() => {
    if (!table) return [];
    const term = search.trim().toLocaleLowerCase(locale === "ko" ? "ko-KR" : "en-US");
    const searched = term
      ? table.rows.filter((row) =>
          columns.some((column) =>
            String(row.values[column.key] ?? "").toLocaleLowerCase().includes(term),
          ),
        )
      : table.rows;
    const matched = filter?.column && filter.value !== ""
      ? searched.filter((row) => String(row.values[filter.column] ?? "") === filter.value)
      : searched;
    if (!sort) return matched;
    return [...matched].sort((a, b) => {
      const av = String(a.values[sort.column] ?? "");
      const bv = String(b.values[sort.column] ?? "");
      return av.localeCompare(bv, locale) * sort.direction;
    });
  }, [table, columns, search, sort, filter, locale]);

  const filterValues = useMemo(() => filter?.column ? [...new Set((table?.rows ?? []).map((row) => String(row.values[filter.column] ?? "")).filter(Boolean))].sort((left, right) => left.localeCompare(right, locale)) : [], [table, filter?.column, locale]);

  useEffect(() => {
    if (table) {
      setVisible((current) => current.filter((key) => table.columns.some((column) => column.key === key)));
      setOperationColumns((current) => current.filter((key) => table.columns.some((column) => column.key === key)));
    }
  }, [table]);

  useEffect(() => {
    if (!["append", "compare", "lookup"].includes(operationKind)) return;
    const available = sources.filter((source) => source.id !== primaryId);
    setOperationSource((current) => available.some((source) => source.id === current) ? current : available[0]?.id ?? "");
  }, [operationKind, primaryId, sources]);

  const work = async (label: string, fn: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await fn(controller.signal);
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") setError((caught as Error).message || String(caught));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy("");
    }
  };

  const adoptSources = (next: SourceDocument[], nextPrimary = next[0]?.id ?? "") => {
    const first = next.find((source) => source.id === nextPrimary) ?? next[0];
    setSources(next);
    setPrimaryId(first?.id ?? "");
    setTable(first ? cloneTable(first.table) : null);
    setSteps([]);
    setPast([]);
    setFuture([]);
    setManualEdits(false);
    setActiveCell(null);
    setDeviceSaved(false);
  };

  const onChooseFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const existingBytes = sources.reduce((sum, source) => sum + source.size, 0);
    if (existingBytes + total > MAX_BYTES) {
      setImportError(t.sourceTooLarge);
      return;
    }
    await work(t.loading, async (signal) => {
      const checked = await Promise.all(
        files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const input = asFileInput(file, bytes);
          const inspection = await inspectInput(input, signal);
          const selection: Selection = {
            sheetName: inspection.suggestedSelection?.sheetName ?? inspection.sheets[0]?.name,
            headerRow: inspection.suggestedSelection?.headerRow ?? inspection.sheets[0]?.headerCandidates[0]?.row ?? 1,
            startColumn: inspection.suggestedSelection?.startColumn ?? 1,
            endColumn: inspection.suggestedSelection?.endColumn,
            endRow: inspection.suggestedSelection?.endRow,
            encoding: "utf-8",
            delimiter: ",",
          };
          return { file, input, inspection, selection };
        }),
      );
      setImportError("");
      setImporting(checked);
    });
  };

  const importReviewed = async () => {
    if (!importing.length) return;
    await work(t.loading, async (signal) => {
      const next = await Promise.all(
        importing.map(async ({ input, selection, inspection }) => {
          const sheet = inspection.sheets.find((candidate) => candidate.name === selection.sheetName);
          if ((sheet?.rowCount ?? 0) > MAX_ROWS) throw new Error(t.rowLimit);
          return importInput(input, selection, signal);
        }),
      );
      if (sources.reduce((sum, source) => sum + source.table.rows.length, 0) + next.reduce((sum, source) => sum + source.table.rows.length, 0) > MAX_ROWS) throw new Error(t.rowLimit);
      const combined = [...sources, ...next];
      if (!table) adoptSources(combined, primaryId || next[0]?.id);
      else {
        setSources(combined);
        setDeviceSaved(false);
      }
      setImporting([]);
      setAction(null);
    });
  };

  const loadSample = async (kind: "clean" | "append" | "compare") => {
    await work(t.loading, async (signal) => {
      const samples = await makeSample(kind, locale, signal);
      adoptSources(samples);
      const primarySample = samples[0];
      const secondarySample = samples[1];
      const sharedMappings = primarySample && secondarySample
        ? primarySample.table.columns
          .filter((column) => secondarySample.table.columns.some((candidate) => candidate.key === column.key))
          .map((column) => [column.key, column.key] as [string, string])
        : [];
      setOperationKind(kind === "clean" ? "trim" : kind);
      setOperationSource(secondarySample?.id ?? "");
      setOperationColumns(kind === "compare" && primarySample ? [primarySample.table.columns[0]?.key].filter(Boolean) : []);
      setMappingRows(sharedMappings);
      setAction(kind === "clean" ? "clean" : kind === "append" ? "append" : "compare");
    });
  };

  const remember = () => {
    if (!table) return;
    setPast((history) => [...history, { table: cloneTable(table), steps: [...steps] }]);
    setFuture([]);
  };

  const confirmPending = () => {
    if (!pending || pending.result.blocked) return;
    if (table) remember();
    setTable(pending.result.table);
    if (pending.kind === "operation") setSteps((current) => [...current, pending.operation]);
    if (pending.kind === "recipe") {
      setSteps([...pending.recipe.steps]);
      setPrimaryId(pending.recipe.primaryId);
    }
    if (pending.kind === "paste") setManualEdits(true);
    setDeviceSaved(false);
    setPending(null);
  };

  const undo = () => {
    if (!table || !past.length) return;
    const entry = past[past.length - 1];
    setFuture((next) => [{ table: cloneTable(table), steps: [...steps] }, ...next]);
    setPast((history) => history.slice(0, -1));
    setTable(entry.table);
    setSteps(entry.steps);
    setDeviceSaved(false);
  };

  const redo = () => {
    if (!table || !future.length) return;
    const entry = future[0];
    setPast((history) => [...history, { table: cloneTable(table), steps: [...steps] }]);
    setFuture((history) => history.slice(1));
    setTable(entry.table);
    setSteps(entry.steps);
    setDeviceSaved(false);
  };

  const switchPrimary = () => {
    if (!primaryPrompt) return;
    setPrimaryId(primaryPrompt.id);
    setTable(cloneTable(primaryPrompt.table));
    setSteps([]);
    setPast([]);
    setFuture([]);
    setManualEdits(false);
    setDeviceSaved(false);
    setPrimaryPrompt(null);
  };

  const operationForForm = (): Operation | null => {
    if (!table) return null;
    const choices = selectedColumns(columns, operationColumns);
    const sourceId = operationSource;
    const pairs = mappingRows.filter(([left, right]) => left && right);
    const comparisonKeys = operationColumns;
    const keyPairs = comparisonKeys.map((key) => pairs.find(([left]) => left === key) ?? [key, key] as [string, string]);
    const valuePairs = pairs.filter(([left]) => !comparisonKeys.includes(left));
    switch (operationKind) {
      case "trim": return { kind: "trim", columns: choices };
      case "blankRows": return { kind: "blankRows" };
      case "dedupe": return { kind: "dedupe", keys: choices };
      case "replace": return { kind: "replace", column: choices[0] ?? "", from: replaceFrom, to: replaceTo };
      case "convert": return { kind: "convert", column: choices[0] ?? "", to: convertTo, dateOrder };
      case "append": return { kind: "append", sourceId, mapping: Object.fromEntries(pairs) };
      case "compare": return { kind: "compare", sourceId, keys: keyPairs, columns: valuePairs };
      case "lookup": return { kind: "lookup", sourceId, keys: keyPairs, columns: valuePairs };
      case "summary": return { kind: "summary", groups: choices.slice(0, 1), sums: choices.slice(1) };
    }
  };

  const previewOperation = async () => {
    if (!table) return;
    const needsSource = ["append", "compare", "lookup"].includes(operationKind);
    if (needsSource && !operationSource) {
      setError(t.source);
      return;
    }
    if (["compare", "lookup"].includes(operationKind)) {
      if (!operationColumns.length) {
        setError(t.selectKey);
        return;
      }
      const mappedKeys = new Set(mappingRows.filter(([left, right]) => left && right).map(([left]) => left));
      if (operationColumns.some((key) => !mappedKeys.has(key))) {
        setError(t.mapKey);
        return;
      }
    }
    const operation = operationForForm();
    if (!operation) return;
    await work(t.loading, async (signal) => {
      const result = await runOperation(table, operation, sources, signal);
      setPending({ kind: "operation", result, operation });
    });
  };

  const previewPaste = (event: ClipboardEvent<HTMLTableCellElement>) => {
    if (!table || !activeCell) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    event.preventDefault();
    if (search.trim() || sort || filter?.column || hasHiddenColumns) {
      setError(t.pasteViewBlocked);
      return;
    }
    const pasted = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    const rowIndex = table.rows.findIndex((row) => row.id === activeCell.rowId);
    const columnIndex = table.columns.findIndex((column) => column.key === activeCell.column);
    if (rowIndex < 0 || columnIndex < 0 || rowIndex + pasted.length > table.rows.length || columnIndex + Math.max(...pasted.map((row) => row.length)) > table.columns.length) {
      setError(t.pasteHint);
      return;
    }
    const changed = cloneTable(table);
    const changes: Change[] = [];
    for (let r = 0; r < pasted.length; r += 1) for (let c = 0; c < pasted[r].length; c += 1) {
      const row = changed.rows[rowIndex + r];
      const column = changed.columns[columnIndex + c];
      if (isLocked(row, column.key)) {
        setError(t.cellLocked);
        return;
      }
      const before = row.values[column.key] ?? null;
      const after = pasted[r][c];
      if (before !== after) {
        row.values[column.key] = after;
        changes.push({ rowId: row.id, column: column.key, before, after, kind: "changed" });
      }
    }
    setPending({ kind: "paste", operation: null, result: { table: changed, changes, warnings: [], blocked: false } });
  };

  const startEdit = (row: LocalRow, column: Column) => {
    if (isLocked(row, column.key)) {
      setError(t.cellLocked);
      return;
    }
    setEditingCell({ rowId: row.id, column: column.key });
    setEditValue(String(row.values[column.key] ?? ""));
  };

  const confirmCell = () => {
    if (!editingCell || !table) return;
    const next = cloneTable(table);
    const row = next.rows.find((candidate) => candidate.id === editingCell.rowId);
    if (!row) return;
    const before = row.values[editingCell.column] ?? null;
    if (String(before) === editValue) {
      setEditingCell(null);
      return;
    }
    row.values[editingCell.column] = editValue;
    setPending({ kind: "paste", operation: null, result: { table: next, changes: [{ rowId: row.id, column: editingCell.column, before, after: editValue, kind: "changed" }], warnings: [t.individualEdit], blocked: false } });
    setEditingCell(null);
  };

  const saveDeviceCopy = async () => {
    if (!project) return;
    await work(t.loading, async () => {
      try {
        await saveProject(project);
        setDeviceSaved(true);
        setMessage(t.savedDevice);
      } catch (caught) {
        setError(`${t.storageFailed} ${(caught as Error).message}`);
      }
    });
  };

  const loadDeviceCopy = async () => {
    await work(t.loading, async () => {
      try {
        const saved = await loadProject();
        if (!saved) {
          setMessage(t.deviceEmpty);
          return;
        }
        setSources(saved.sources);
        setPrimaryId(saved.primaryId);
        setTable(saved.table);
        setSteps(saved.steps);
        setPast([]);
        setFuture([]);
        // Project storage does not encode manual-edit provenance. Keep recipe
        // exports conservative after loading rather than implying fidelity.
        setManualEdits(true);
        setDeviceSaved(true);
      } catch (caught) {
        setError(`${t.storageFailed} ${(caught as Error).message}`);
      }
    });
  };

  const clearDeviceCopy = async () => {
    await work(t.loading, async () => {
      try {
        await deleteProject();
        setDeviceSaved(false);
        setMessage(t.deviceCleared);
      } catch (caught) {
        setError(`${t.storageFailed} ${(caught as Error).message}`);
      }
    });
  };

  const exportResult = async (kind: "csv" | "xlsx" | "original") => {
    if (!table) return;
    await work(t.preparing, async (signal) => {
      try {
        if (kind === "csv") download(await exportCsv(table, signal), `${basename(table.name)}-result.csv`, "text/csv;charset=utf-8");
        if (kind === "xlsx") download(await exportTableXlsx(table, signal), `${basename(table.name)}-result.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        if (kind === "original" && primary) download(await exportOriginal(primary, table, signal), primary.name, "application/octet-stream");
        setMessage(t.downloaded);
      } catch {
        setError(t.downloadFailed);
      }
    });
  };

  const downloadRecipe = () => {
    if (!table || !primary) return;
    const recipe: Recipe = {
      version: 1,
      name: recipeName.trim() || `${basename(table.name)} recipe`,
      primaryId,
      sources: sources.map((source) => ({ id: source.id, name: source.name, columns: source.table.columns.map((column) => column.key), selection: { ...source.selection } })),
      steps,
    };
    download(JSON.stringify(recipe, null, 2), `${basename(recipe.name)}.sheet-recipe.json`, "application/json");
    setRecipeName("");
    setRecipePrompt(false);
  };

  const chooseRecipe = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await work(t.loading, async (signal) => {
      const parsed = JSON.parse(await file.text());
      const recipe = await validateRecipe(parsed, signal);
      setRecipeToRun(recipe);
      setRecipeMappings(Object.fromEntries(recipe.sources.map((source) => [source.id, sources.find((current) => current.name === source.name)?.id ?? ""])));
      setRecipePrompt(true);
    });
  };

  const previewRecipe = async () => {
    if (!recipeToRun) return;
    const matchedSources = recipeToRun.sources.map((expected) =>
      sources.find((current) => current.id === recipeMappings[expected.id]),
    );
    if (matchedSources.some((source) => !source)) {
      setError(t.recipeNeedSources);
      return;
    }
    const recipeSources = matchedSources as SourceDocument[];
    if (new Set(recipeSources.map((source) => source.id)).size !== recipeSources.length) {
      setError(t.recipeUniqueSources);
      return;
    }
    const remap = (id: string) => recipeMappings[id] || id;
    const remapped: Recipe = {
      ...recipeToRun,
      primaryId: remap(recipeToRun.primaryId),
      sources: recipeToRun.sources.map((source) => ({ ...source, id: remap(source.id) })),
      steps: recipeToRun.steps.map((step) => {
        if (step.kind === "append") return { ...step, sourceId: remap(step.sourceId) };
        if (step.kind === "compare" || step.kind === "lookup") return { ...step, sourceId: remap(step.sourceId) };
        return step;
      }),
    };
    const selectedPrimary = recipeSources.find((source) => source.id === remapped.primaryId);
    const selectionMatches = recipeToRun.sources.every((expected, index) => {
      const current = recipeSources[index];
      return recipeSelectionIdentity(current.selection) === recipeSelectionIdentity(expected.selection ?? current.selection);
    });
    if (!selectedPrimary || !selectionMatches) {
      setError(t.recipeNeedSources);
      return;
    }
    await work(t.loading, async (signal) => {
      const result = await replayRecipe(remapped, recipeSources, signal);
      setPending({ kind: "recipe", result, recipe: remapped });
      setRecipePrompt(false);
      setRecipeToRun(null);
    });
  };

  const mappingSource = sources.find((source) => source.id === (operationSource || sources.find((source) => source.id !== primaryId)?.id));

  useEffect(() => {
    if (!table || deviceSaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [table, deviceSaved]);

  const leaveForLegacy = () => {
    const message = locale === "ko" ? "이 탭에만 있는 작업이 있습니다. 팀 작업 공간으로 이동할까요?" : "This work only exists in this tab. Open the team workspace anyway?";
    if (!table || deviceSaved || window.confirm(message)) onLegacy();
  };

  return (
    <section className="local-workbench" aria-label={t.product}>
      <header className="local-topbar">
        <div className="local-brand"><FileSpreadsheet size={20} aria-hidden="true" /><div><strong>{t.product}</strong><small>{t.tag}</small></div></div>
        <div className="local-top-actions">
          <button className="local-button" onClick={() => fileInput.current?.click()}><FolderOpen size={16} />{t.open}</button>
          <button className="local-button icon-label" onClick={() => onLocale(locale === "en" ? "ko" : "en")}><Languages size={16} />{t.locale}</button>
          <button className="local-button local-legacy" onClick={leaveForLegacy}><ArrowLeft size={16} />{t.team}</button>
        </div>
        <input ref={fileInput} className="local-visually-hidden" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple onChange={(event) => void onChooseFiles(event)} />
        <input ref={recipeInput} className="local-visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void chooseRecipe(event)} />
      </header>

      {(busy || error || message) && <div className="local-notice-row" aria-live="polite">
        {busy && <p className="local-working"><LoaderCircle size={16} />{busy}<button onClick={() => abortRef.current?.abort()}>{t.cancelWork}</button></p>}
        {error && <p className="local-error" role="alert">{error}<button aria-label={t.close} onClick={() => setError("")}><X size={15} /></button></p>}
        {message && <p className="local-message">{message}<button aria-label={t.close} onClick={() => setMessage("")}><X size={15} /></button></p>}
      </div>}

      {!table ? <Home locale={locale} action={action} setAction={setAction} openFiles={() => fileInput.current?.click()} sample={loadSample} onLoad={() => void loadDeviceCopy()} /> : <div className="local-layout">
        <aside className="local-pane local-sources-pane">
          <div className="local-pane-head"><h2>{t.sources}</h2><button className="local-icon-button" aria-label={t.openFiles} onClick={() => fileInput.current?.click()}><Plus size={18} /></button></div>
          <div className="local-source-list">
            {sources.map((source) => <button key={source.id} className={`local-source ${source.id === primaryId ? "is-primary" : ""}`} onClick={() => source.id === primaryId ? undefined : setPrimaryPrompt(source)}>
              <FileSpreadsheet size={16} aria-hidden="true" /><span><strong>{source.name}</strong><small>{source.table.rows.length} {t.rows} · {source.selection.sheetName ?? "CSV"}</small></span>{source.id === primaryId && <small className="local-primary-label">{t.primary}</small>}
            </button>)}
          </div>
          <div className="local-device-panel">
            <label className="local-check"><input type="checkbox" checked={keepDevice} onChange={(event) => setKeepDevice(event.target.checked)} />{t.keep}</label>
            <p>{t.keepHint}</p>
            {keepDevice && <button className="local-button" disabled={!project || Boolean(busy)} onClick={() => void saveDeviceCopy()}><Save size={15} />{t.saveDevice}</button>}
            <button className="local-text-button" onClick={() => void loadDeviceCopy()}>{t.loadDevice}</button>
            <button className="local-text-button danger" onClick={() => void clearDeviceCopy()}>{t.clearDevice}</button>
          </div>
        </aside>

        <main className="local-result-pane">
          <div className="local-result-head">
            <div><p className="local-eyebrow">{t.result}</p><h1>{table.name}</h1><small>{rows.length} / {table.rows.length} {t.rows} · {shownColumns.length} {t.columns}</small></div>
            <div className="local-history-actions">
              <button className="local-icon-button" aria-label={t.undoLabel} disabled={!past.length} onClick={undo}><Undo2 size={17} /></button>
              <button className="local-icon-button" aria-label={t.redoLabel} disabled={!future.length} onClick={redo}><Redo2 size={17} /></button>
              <div className="local-export"><button className="local-button"><Download size={16} />{t.export}<ChevronDown size={14} /></button><div className="local-export-menu"><button onClick={() => void exportResult("xlsx")}>{t.resultXlsx}</button><button onClick={() => void exportResult("csv")}>{t.resultCsv}</button>{primary && <button onClick={() => void exportResult("original")}>{t.original}</button>}</div></div>
            </div>
          </div>
          <div className="local-grid-controls">
            <label className="local-search"><Search size={16} /><input aria-label={t.search} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.search} /></label>
            <label className="local-select-label">{t.sort}<select value={sort ? `${sort.column}:${sort.direction}` : ""} onChange={(event) => { const [column, direction] = event.target.value.split(":"); setSort(column ? { column, direction: Number(direction) as 1 | -1 } : null); }}><option value="">—</option>{columns.map((column) => <option key={column.key} value={`${column.key}:1`}>{column.label} ↑</option>)}{columns.map((column) => <option key={`${column.key}-desc`} value={`${column.key}:-1`}>{column.label} ↓</option>)}</select></label>
            <label className="local-select-label">{t.filter}<select value={filter?.column ?? ""} onChange={(event) => setFilter(event.target.value ? { column: event.target.value, value: "" } : null)}><option value="">—</option>{columns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select></label>
            {filter?.column && <label className="local-select-label"><span className="local-visually-hidden">{t.filter}</span><select value={filter.value} onChange={(event) => setFilter({ ...filter, value: event.target.value })}><option value="">{t.allValues}</option>{filterValues.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
            <details className="local-columns"><summary><SlidersHorizontal size={15} />{t.visibleColumns}</summary>{columns.map((column) => <label key={column.key}><input type="checkbox" checked={!visible.length || visible.includes(column.key)} onChange={(event) => setVisible((current) => { const base = current.length ? current : columns.map((item) => item.key); return event.target.checked ? [...base, column.key] : base.filter((key) => key !== column.key); })} />{column.label}</label>)}</details>
          </div>
          <p className="local-grid-hint">{t.pasteHint} {t.formulasLocked}</p>
          <ResultTable rows={rows} columns={shownColumns} locale={locale} activeCell={activeCell} setActiveCell={setActiveCell} editingCell={editingCell} editValue={editValue} setEditValue={setEditValue} onEdit={startEdit} onConfirmEdit={confirmCell} onCancelEdit={() => setEditingCell(null)} onPaste={previewPaste} />
          <LocalViews table={table} locale={locale} />
        </main>

        <aside className="local-pane local-operations-pane">
          <OperationPanel locale={locale} primary={primary} columns={columns} sources={sources.filter((source) => source.id !== primaryId)} operationKind={operationKind} setOperationKind={setOperationKind} selected={operationColumns} setSelected={setOperationColumns} sourceId={operationSource} setSourceId={setOperationSource} replaceFrom={replaceFrom} setReplaceFrom={setReplaceFrom} replaceTo={replaceTo} setReplaceTo={setReplaceTo} convertTo={convertTo} setConvertTo={setConvertTo} dateOrder={dateOrder} setDateOrder={setDateOrder} mappingRows={mappingRows} setMappingRows={setMappingRows} sourceColumns={mappingSource?.table.columns ?? []} onPreview={() => void previewOperation()} disabled={Boolean(busy)} />
          <section className="local-history"><div className="local-pane-head"><h2><History size={17} />{t.history}</h2></div>
            {steps.length ? <ol>{steps.map((step, index) => <li key={`${step.kind}-${index}`}><span>{index + 1}</span>{operationName(step, locale)}</li>)}</ol> : <p>{t.noHistory}</p>}
            {manualEdits && <p className="local-warning-text"><AlertTriangle size={15} />{t.individualEdit}</p>}
            <div className="local-recipe-buttons"><button className="local-text-button" onClick={() => setRecipePrompt(true)}><Save size={15} />{t.saveRecipe}</button><button className="local-text-button" onClick={() => recipeInput.current?.click()}><Upload size={15} />{t.loadRecipe}</button></div>
          </section>
        </aside>
      </div>}

      {importing.length > 0 && <ImportReview locale={locale} items={importing} setItems={setImporting} error={importError} onClose={() => setImporting([])} onAccept={() => void importReviewed()} />}
      {pending && <PreviewDialog locale={locale} pending={pending} sources={sources} onClose={() => setPending(null)} onApply={confirmPending} />}
      {primaryPrompt && <ConfirmDialog locale={locale} title={t.switchPrimary} body={t.resetWarning} confirm={t.continue} onClose={() => setPrimaryPrompt(null)} onConfirm={switchPrimary} />}
      {recipePrompt && <RecipeDialog locale={locale} recipe={recipeToRun} name={recipeName} onName={setRecipeName} sources={sources} mappings={recipeMappings} setMappings={setRecipeMappings} onClose={() => { setRecipePrompt(false); setRecipeToRun(null); }} onSave={downloadRecipe} onReplay={() => void previewRecipe()} />}
    </section>
  );
}

function Home({ locale, action, setAction, openFiles, sample, onLoad }: { locale: Locale; action: HomeAction | null; setAction: (action: HomeAction) => void; openFiles: () => void; sample: (kind: "clean" | "append" | "compare") => Promise<void>; onLoad: () => void }) {
  const t = copy[locale];
  const cards: Array<[HomeAction, keyof typeof t, keyof typeof t]> = [["clean", "clean", "cleanHint"], ["append", "append", "appendHint"], ["compare", "compare", "compareHint"], ["recipe", "recipe", "recipeHint"]];
  return <main className="local-home"><div className="local-home-intro"><p className="local-eyebrow">{t.tag}</p><h1>{t.product}</h1><p>{t.noSources}</p><button className="local-button primary" onClick={openFiles}><FolderOpen size={17} />{t.openFiles}</button><button className="local-text-button" onClick={onLoad}><RotateCcw size={15} />{t.loadDevice}</button></div><section className="local-common-jobs" aria-labelledby="local-common-jobs"><h2 id="local-common-jobs">{t.commonJobs}</h2><ol><li>{t.jobAppend}</li><li>{t.jobCompare}</li><li>{t.jobLookup}</li></ol></section><div className="local-action-grid">{cards.map(([kind, label, hint]) => <button key={kind} className={action === kind ? "is-selected" : ""} onClick={() => { setAction(kind); openFiles(); }}><strong>{t[label]}</strong><span>{t[hint]}</span></button>)}</div><div className="local-samples"><p>{t.samples}</p><button onClick={() => void sample("clean")}>{t.sampleClean}</button><button onClick={() => void sample("append")}>{t.sampleAppend}</button><button onClick={() => void sample("compare")}>{t.sampleCompare}</button></div></main>;
}

function ImportReview({ locale, items, setItems, error, onClose, onAccept }: { locale: Locale; items: Array<{ file: File; input: InputFile; inspection: Inspection; selection: Selection }>; setItems: Dispatch<SetStateAction<Array<{ file: File; input: InputFile; inspection: Inspection; selection: Selection }>>>; error: string; onClose: () => void; onAccept: () => void }) {
  const t = copy[locale];
  const update = (index: number, selection: Partial<Selection>) =>
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, selection: { ...item.selection, ...selection } } : item));
  return <LocalDialog title={t.inspect} onClose={onClose} wide>
    <div className="local-dialog-body">
      <p>{t.fileLimit}</p>
      {error && <p className="local-error" role="alert">{error}</p>}
      {items.map((item, index) => {
        const sheet = item.inspection.sheets.find((candidate) => candidate.name === item.selection.sheetName) ?? item.inspection.sheets[0];
        return <section className="local-import-card" key={item.input.id}>
          <h3>{item.file.name}</h3>
          <p>{sheet?.rowCount ?? 0} {t.rows} · {sheet?.maxColumn ?? 0} {t.columns}</p>
          <div className="local-form-grid">
            <label>{t.sheet}<select value={item.selection.sheetName} onChange={(event) => {
              const nextSheet = item.inspection.sheets.find((candidate) => candidate.name === event.target.value);
              update(index, { sheetName: event.target.value, headerRow: nextSheet?.headerCandidates[0]?.row ?? 1 });
            }}>{item.inspection.sheets.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}</select></label>
            <label>{t.header}<select value={item.selection.headerRow} onChange={(event) => update(index, { headerRow: Number(event.target.value) })}>{(sheet?.headerCandidates ?? []).map((candidate) => <option key={candidate.row} value={candidate.row}>{candidate.row}: {candidate.values.join(" · ")}</option>)}</select></label>
            {(["startColumn", "endColumn", "endRow"] as const).map((key) => <label key={key}>{t[key === "startColumn" ? "firstColumn" : key === "endColumn" ? "lastColumn" : "lastRow"]}<input type="number" min="1" value={item.selection[key] ?? ""} onChange={(event) => update(index, { [key]: event.target.value ? Number(event.target.value) : undefined })} /></label>)}
            {item.file.name.toLowerCase().endsWith(".csv") && <>
              <label>{t.encoding}<select value={item.selection.encoding ?? "utf-8"} onChange={(event) => update(index, { encoding: event.target.value })}><option value="utf-8">UTF-8</option><option value="euc-kr">EUC-KR / CP949</option></select></label>
              <label>{t.delimiter}<select value={item.selection.delimiter ?? ","} onChange={(event) => update(index, { delimiter: event.target.value })}><option value=",">Comma</option><option value="\t">Tab</option><option value=";">Semicolon</option></select></label>
            </>}
          </div>
          <p className="local-dialog-note">{locale === "ko" ? "원본 행 수에는 제목과 빈 행이 포함됩니다. 결과에는 선택한 범위의 내용이 있는 데이터 행만 표시되어 행 수가 달라질 수 있습니다." : "Source row counts include headers and empty rows. Results contain non-empty data rows from the selected range, so their counts may differ."}</p>
<div className="local-import-preview"><strong>{t.preview}</strong><table><tbody>{(sheet?.headerCandidates.find((candidate) => candidate.row === item.selection.headerRow)?.values ?? []).slice(0, 8).map((value, valueIndex) => <tr key={`${value}-${valueIndex}`}><td>{value}</td></tr>)}</tbody></table></div>
        </section>;
      })}
    </div>
    <footer className="local-dialog-actions"><button onClick={onClose}>{t.cancel}</button><button className="local-button primary" onClick={onAccept}><Check size={16} />{t.accept}</button></footer>
  </LocalDialog>;
}

function ResultTable({ rows, columns, locale, activeCell, setActiveCell, editingCell, editValue, setEditValue, onEdit, onConfirmEdit, onCancelEdit, onPaste }: { rows: LocalRow[]; columns: Column[]; locale: Locale; activeCell: Cell | null; setActiveCell: (cell: Cell) => void; editingCell: Cell | null; editValue: string; setEditValue: (value: string) => void; onEdit: (row: LocalRow, column: Column) => void; onConfirmEdit: () => void; onCancelEdit: () => void; onPaste: (event: ClipboardEvent<HTMLTableCellElement>) => void }) {
  const [page, setPage] = useState(0);
  const pageSize = 150;
  const start = Math.min(page * pageSize, Math.max(0, rows.length - 1));
  const view = rows.slice(start, start + pageSize);
  useEffect(() => setPage(0), [rows.length]);
  return <><div className="local-table-scroll" tabIndex={0}><table className="local-table"><thead><tr>{columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{view.map((row) => <tr key={row.id}>{columns.map((column) => { const selected = activeCell?.rowId === row.id && activeCell.column === column.key; const editing = editingCell?.rowId === row.id && editingCell.column === column.key; return <td key={column.key} className={selected ? "is-selected" : ""} onClick={() => setActiveCell({ rowId: row.id, column: column.key })} onDoubleClick={() => onEdit(row, column)} onPaste={onPaste}>{editing ? <span className="local-inline-editor"><input aria-label={`${copy[locale].editCell} ${column.label}`} autoFocus value={editValue} onChange={(event) => setEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onConfirmEdit(); if (event.key === "Escape") onCancelEdit(); }} /><button aria-label={copy[locale].saveCell} onClick={onConfirmEdit}><Check size={14} /></button></span> : <span title={String(row.values[column.key] ?? "")}>{String(row.values[column.key] ?? "—")}</span>}</td>; })}</tr>)}</tbody></table>{!rows.length && <p className="local-empty">—</p>}</div>{rows.length > pageSize && <nav className="local-pagination" aria-label="Result pages"><button disabled={page === 0} onClick={() => setPage((current) => current - 1)}>←</button><span>{start + 1}–{Math.min(start + pageSize, rows.length)} / {rows.length}</span><button disabled={start + pageSize >= rows.length} onClick={() => setPage((current) => current + 1)}>→</button></nav>}</>;
}

function OperationPanel({ locale, primary, columns, sources, operationKind, setOperationKind, selected, setSelected, sourceId, setSourceId, replaceFrom, setReplaceFrom, replaceTo, setReplaceTo, convertTo, setConvertTo, dateOrder, setDateOrder, mappingRows, setMappingRows, sourceColumns, onPreview, disabled }: { locale: Locale; primary: SourceDocument | null; columns: Column[]; sources: SourceDocument[]; operationKind: (typeof OPERATIONS)[number]; setOperationKind: (kind: (typeof OPERATIONS)[number]) => void; selected: string[]; setSelected: Dispatch<SetStateAction<string[]>>; sourceId: string; setSourceId: (id: string) => void; replaceFrom: string; setReplaceFrom: (value: string) => void; replaceTo: string; setReplaceTo: (value: string) => void; convertTo: "number" | "date" | "text"; setConvertTo: (value: "number" | "date" | "text") => void; dateOrder: "ymd" | "dmy" | "mdy"; setDateOrder: (value: "ymd" | "dmy" | "mdy") => void; mappingRows: Array<[string, string]>; setMappingRows: Dispatch<SetStateAction<Array<[string, string]>>>; sourceColumns: Column[]; onPreview: () => void; disabled: boolean }) {
  const t = copy[locale];
  const needsSource = ["append", "compare", "lookup"].includes(operationKind);
  const isJoin = operationKind === "compare" || operationKind === "lookup";
  const needsColumns = !["blankRows", "append"].includes(operationKind);
  const selectedSource = sources.find((source) => source.id === sourceId) ?? null;
  const sourceLabel = operationKind === "append" ? t.incomingFile : operationKind === "compare" ? t.comparisonFile : t.referenceFile;
  const roleText = operationKind === "append" ? t.appendRole : operationKind === "compare" ? t.compareRole : t.lookupRole;
  const flip = (key: string) => setSelected((current) => current.includes(key) ? current.filter((currentKey) => currentKey !== key) : [...current, key]);

  return <section className="local-operation">
    <div className="local-pane-head"><h2>{t.operations}</h2></div>
    <label>{t.operation}<select value={operationKind} onChange={(event) => setOperationKind(event.target.value as typeof operationKind)}>{OPERATIONS.map((kind) => <option key={kind} value={kind}>{t[kind === "append" ? "appendOp" : kind]}</option>)}</select></label>
    {needsSource && <>
      <section className="local-file-roles" aria-label={t.fileRoles}>
        <div><strong>{t.currentFile}</strong><span>{primary?.name ?? "—"}</span></div>
        <div><strong>{sourceLabel}</strong><span>{selectedSource?.name ?? "—"}</span></div>
      </section>
      <p className="local-operation-role">{roleText}</p>
      <label>{sourceLabel}<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">—</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
    </>}
    {isJoin && <p className="local-key-safety"><strong>{t.keySafety}</strong>{t.keySafetyHint}</p>}
    {needsColumns && <fieldset><legend>{operationKind === "dedupe" || isJoin ? t.keyColumns : t.chooseColumns}</legend><div className="local-column-checks">{columns.map((column) => <label key={column.key}><input type="checkbox" checked={selected.includes(column.key)} onChange={() => flip(column.key)} />{column.label}</label>)}</div></fieldset>}
    {operationKind === "replace" && <div className="local-form-grid"><label>{t.find}<input value={replaceFrom} onChange={(event) => setReplaceFrom(event.target.value)} /></label><label>{t.replaceWith}<input value={replaceTo} onChange={(event) => setReplaceTo(event.target.value)} /></label></div>}
    {operationKind === "convert" && <div className="local-form-grid"><label>{t.conversion}<select value={convertTo} onChange={(event) => setConvertTo(event.target.value as typeof convertTo)}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option></select></label>{convertTo === "date" && <label>{t.dateOrder}<select value={dateOrder} onChange={(event) => setDateOrder(event.target.value as typeof dateOrder)}><option value="ymd">YYYY-MM-DD</option><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label>}</div>}
    {needsSource && <div className="local-mappings"><p>{operationKind === "append" ? t.targetColumns : t.addMapping}</p>{isJoin && <small>{t.mappingHint}</small>}{mappingRows.map((pair, index) => <div key={index}><select value={pair[0]} onChange={(event) => setMappingRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? [event.target.value, row[1]] : row))}><option value="">—</option>{columns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select><span>↔</span><select value={pair[1]} onChange={(event) => setMappingRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? [row[0], event.target.value] : row))}><option value="">—</option>{sourceColumns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</select><button aria-label={copy[locale].close} onClick={() => setMappingRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><X size={14} /></button></div>)}<button className="local-text-button" onClick={() => setMappingRows((rows) => [...rows, [columns[0]?.key ?? "", sourceColumns[0]?.key ?? ""]])}><Plus size={14} />{t.addMapping}</button></div>}
    <button className="local-button primary local-review-button" disabled={disabled || (needsSource && (!sources.length || !sourceId))} onClick={onPreview}><Search size={16} />{t.runPreview}</button>
  </section>;
}

function PreviewDialog({ locale, pending, sources, onClose, onApply }: { locale: Locale; pending: Pending; sources: SourceDocument[]; onClose: () => void; onApply: () => void }) { const t = copy[locale]; const changes = pending.result.changes.filter((change) => change.kind !== "same"); return <LocalDialog title={t.review} onClose={onClose} wide><div className="local-dialog-body"><p><strong>{changes.length}</strong> {t.changes}</p>{pending.result.blocked && <p className="local-blocked"><AlertTriangle size={17} />{t.blocked}</p>}{pending.result.warnings.length > 0 && <section className="local-dialog-warnings"><h3>{t.warnings}</h3><ul>{pending.result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></section>}{changes.length ? <div className="local-change-list">{changes.slice(0, 100).map((change, index) => <div key={`${change.rowId}-${change.column}-${index}`}><code>{change.rowId.slice(0, 8)}{change.column ? ` · ${change.column}` : ""}</code><span>{typeof change.before === "string" ? JSON.stringify(change.before) : String(change.before ?? "—")} → {typeof change.after === "string" ? JSON.stringify(change.after) : String(change.after ?? "—")}</span><small>{change.message ?? change.kind}</small></div>)}</div> : <p>{t.noChanges}</p>}{changes.some((change) => { const row = pending.result.table.rows.find((candidate) => candidate.id === change.rowId); return row?.origins.length; }) && <details className="local-provenance"><summary>{t.provenance}</summary>{changes.slice(0, 25).map((change, index) => { const row = pending.result.table.rows.find((candidate) => candidate.id === change.rowId); return <p key={`${change.rowId}-${change.column}-${index}`}>{change.rowId.slice(0, 8)}: {(row?.origins ?? []).map((origin) => `${sources.find((source) => source.id === origin.sourceId)?.name ?? origin.sourceId} ${origin.sheet ?? ""} row ${origin.row}`).join(", ")}</p>; })}</details>}</div><footer className="local-dialog-actions"><button onClick={onClose}>{t.cancel}</button><button className="local-button primary" disabled={pending.result.blocked} onClick={onApply}><Check size={16} />{t.apply}</button></footer></LocalDialog>; }

function RecipeDialog({ locale, recipe, name, onName, sources, mappings, setMappings, onClose, onSave, onReplay }: { locale: Locale; recipe: Recipe | null; name: string; onName: (name: string) => void; sources: SourceDocument[]; mappings: Record<string, string>; setMappings: Dispatch<SetStateAction<Record<string, string>>>; onClose: () => void; onSave: () => void; onReplay: () => void }) {
  const t = copy[locale];
  const loading = Boolean(recipe);
  const selectedIds = recipe ? recipe.sources.map((source) => mappings[source.id]).filter(Boolean) : [];
  const hasRoleConflict = new Set(selectedIds).size !== selectedIds.length;
  return <LocalDialog title={loading ? t.recipeSources : t.saveRecipe} onClose={onClose}>
    <div className="local-dialog-body">
      {loading && recipe ? <><p>{t.recipeNeedSources}</p>{recipe.sources.length > 1 && <p className="local-dialog-note">{t.recipeUniqueSources}</p>}{hasRoleConflict && <p className="local-error" role="alert">{t.recipeUniqueSources}</p>}{recipe.sources.map((source) => <label key={source.id}>{source.name}<select value={mappings[source.id] ?? ""} onChange={(event) => setMappings((current) => ({ ...current, [source.id]: event.target.value }))}><option value="">—</option>{sources.map((current) => <option key={current.id} value={current.id} disabled={recipe.sources.some((other) => other.id !== source.id && mappings[other.id] === current.id)}>{current.name}</option>)}</select></label>)}</> : <label>{t.recipeName}<input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder={locale === "ko" ? "매주 명단 정리" : "Weekly cleanup"} /></label>}
    </div>
    <footer className="local-dialog-actions"><button onClick={onClose}>{t.cancel}</button><button className="local-button primary" disabled={loading ? Object.values(mappings).some((id) => !id) || hasRoleConflict : false} onClick={loading ? onReplay : onSave}>{loading ? t.reviewRecipe : t.saveRecipe}</button></footer>
  </LocalDialog>;
}

function ConfirmDialog({ locale, title, body, confirm, onClose, onConfirm }: { locale: Locale; title: string; body: string; confirm: string; onClose: () => void; onConfirm: () => void }) { const t = copy[locale]; return <LocalDialog title={title} onClose={onClose}><div className="local-dialog-body"><p>{body}</p></div><footer className="local-dialog-actions"><button onClick={onClose}>{t.cancel}</button><button className="local-button primary" onClick={onConfirm}>{confirm}</button></footer></LocalDialog>; }

function LocalDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) { useEffect(() => { const close = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [onClose]); return <div className="local-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`local-modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="local-icon-button" aria-label={copy.en.close} onClick={onClose}><X size={18} /></button></header>{children}</section></div>; }
