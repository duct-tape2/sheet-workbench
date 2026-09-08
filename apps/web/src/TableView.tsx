import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUpRight } from "lucide-react";
import {
  categoryIndex,
  type Dataset,
  type WorkRecord,
  type Locale,
} from "../../../packages/core/src/index";
import { en, ko } from "./i18n";
import { colorFor } from "./colors";
export default function TableView({
  dataset: d,
  rows,
  locale,
  onSelect,
  selected,
  setSelected,
}: {
  dataset: Dataset;
  rows: WorkRecord[];
  locale: Locale;
  onSelect: (r: WorkRecord) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  const t = locale === "ko" ? ko : en;
  const [sorting, setSorting] = useState<SortingState>([]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const columns = useMemo<ColumnDef<WorkRecord>[]>(
    () => [
      {
        id: "selection",
        header: () => (
          <input
            type="checkbox"
            aria-label={t.selectAllMatching}
            checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
            onChange={(e) =>
              setSelected(
                e.target.checked ? new Set(rows.map((r) => r.id)) : new Set(),
              )
            }
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`${t.selectRecord} ${row.original.values[d.mapping.title]}`}
            checked={selected.has(row.original.id)}
            onChange={() => toggle(row.original.id)}
          />
        ),
      },
      ...d.fields.map((f) => ({
        id: f.key,
        accessorFn: (r: WorkRecord) => r.values[f.key] ?? "",
        header: f.label,
        cell: ({ row }: any) => {
          const r: WorkRecord = row.original;
          const value = String(r.values[f.key] ?? "");
          return f.key === d.mapping.title ? (
            <button className="record-link" onClick={() => onSelect(r)}>
              {value || "—"}
              <ArrowUpRight size={14} />
            </button>
          ) : f.key === d.mapping.category || f.key === d.mapping.status ? (
            <span className={`pill category-${colorFor(d, value)}`}>
              {value || "—"}
            </span>
          ) : (
            <button
              className="cell-edit"
              onClick={() => onSelect(r)}
              title={value}
            >
              {value || "—"}
            </button>
          );
        },
      })),
    ],
    [d, rows, selected, locale],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          {table.getHeaderGroups().map((h) => (
            <tr key={h.id}>
              {h.headers.map((c) => (
                <th key={c.id} scope="col">
                  {c.column.getCanSort() ? (
                    <button onClick={c.column.getToggleSortingHandler()}>
                      {flexRender(c.column.columnDef.header, c.getContext())}
                      <ArrowUpDown size={12} />
                    </button>
                  ) : (
                    flexRender(c.column.columnDef.header, c.getContext())
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id}>
              {r.getVisibleCells().map((c) => (
                <td key={c.id} data-label={String(c.column.columnDef.header)}>
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty-state">{t.empty}</p>}
    </div>
  );
}
