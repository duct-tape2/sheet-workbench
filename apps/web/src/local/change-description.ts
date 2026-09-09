import type {
  Change,
  Operation,
  SourceDocument,
  TableData,
} from "../../../../packages/local/src/types";

type Locale = "en" | "ko";

type ChangeDescriptionInput = {
  change: Change;
  resultTable: TableData;
  sources: SourceDocument[];
  locale: Locale;
  operation?: Pick<Operation, "kind"> | null;
};

const labels = {
  en: {
    newRow: "New row",
    removedRow: "Removed row",
    rowComparison: "Row comparison",
    compareOnly: "Row only in compared file",
  },
  ko: {
    newRow: "새 행",
    removedRow: "삭제된 행",
    rowComparison: "행 비교",
    compareOnly: "비교 파일에만 있는 행",
  },
} as const;

const displayCell = (value: Change["before"]) =>
  typeof value === "string" ? JSON.stringify(value) : String(value ?? "—");

const isCompareOnlyAdded = (
  change: Change,
  sources: SourceDocument[],
  operation?: Pick<Operation, "kind"> | null,
) =>
  change.kind === "added" &&
  (operation?.kind === "compare" ||
    /^Only in /u.test(change.message ?? "") ||
    sources.some((source) => change.message === `Only in ${source.name}.`));

/**
 * Describes a preview change without inferring rows that are absent from the
 * result table. Added rows can be read directly from that checked result;
 * compare-only rows remain comparison findings, never inferred writes.
 */
export function describeChange({
  change,
  resultTable,
  sources,
  locale,
  operation,
}: ChangeDescriptionInput) {
  if (change.kind === "changed") {
    return `${displayCell(change.before)} → ${displayCell(change.after)}`;
  }

  const text = labels[locale];
  if (isCompareOnlyAdded(change, sources, operation)) return text.compareOnly;

  if (change.kind === "added") {
    const row = resultTable.rows.find(
      (candidate) => candidate.id === change.rowId,
    );
    if (!row) return text.newRow;
    const values = resultTable.columns.map(
      (column) => `${column.label}: ${displayCell(row.values[column.key])}`,
    );
    return `${text.newRow}: ${values.join(" · ")}`;
  }

  if (change.kind === "removed") return text.removedRow;
  return text.rowComparison;
}
