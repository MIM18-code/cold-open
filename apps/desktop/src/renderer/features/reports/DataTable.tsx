// A sortable table. Click a header to sort, click again to reverse. Rows can be clickable.
import { useMemo, useState } from "react";
import { nextSort, sortRows, type SortState } from "./sort.ts";

export interface Column<T> {
  key: string;
  title: string;
  /** The cell text, and the CSV value. */
  value(row: T): string | number;
  /** What to sort by when it differs from the shown value (a length shown as "1 3/8" sorts by eighths). */
  sort?(row: T): string | number;
  numeric?: boolean;
  width?: number;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, selected, sort: controlledSort, onSortChange }: {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  onRowClick?(row: T): void;
  selected?: string | null;
  sort?: SortState | null;
  onSortChange?(next: SortState | null): void;
}) {
  const [ownSort, setOwnSort] = useState<SortState | null>(null);
  const sort = onSortChange ? controlledSort ?? null : ownSort;
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const toggle = (column: Column<T>) => {
    const next = nextSort(sort, column);
    if (onSortChange) onSortChange(next);
    else setOwnSort(next);
  };
  return (
    <table className="data reports-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} style={column.width ? {width:column.width,minWidth:column.width} : undefined} className={column.numeric ? "num" : ""}
              aria-sort={sort?.key === column.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
              <button onClick={() => toggle(column)}>
                {column.title}
                <span className="reports-arrow" aria-hidden="true">{sort?.key === column.key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={rowKey(row)} className={`${onRowClick ? "reports-click" : ""} ${selected === rowKey(row) ? "on" : ""}`}
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row); } } : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {columns.map((column) => <td key={column.key} className={column.numeric ? "num" : ""}>{column.value(row)}</td>)}
          </tr>
        ))}
        {!sorted.length ? <tr><td colSpan={columns.length} className="reports-none">Nothing to show.</td></tr> : null}
      </tbody>
    </table>
  );
}
