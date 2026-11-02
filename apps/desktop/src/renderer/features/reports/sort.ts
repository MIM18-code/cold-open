/** Shared table ordering: the same result feeds the screen and every export. */
export interface SortState { key: string; dir: 1 | -1; }
export interface SortColumn<T> {
  key: string;
  value(row: T): string | number;
  sort?(row: T): string | number;
  numeric?: boolean;
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortRows<T>(rows: readonly T[], columns: readonly SortColumn<T>[], sort: SortState | null): T[] {
  const col = columns.find((c) => c.key === sort?.key);
  if (!sort || !col) return [...rows];
  const by = col.sort ?? col.value;
  return rows.map((row, index) => ({ row, index, key: by(row) })).sort((a, b) => {
    const first = typeof a.key === "number" && typeof b.key === "number"
      ? a.key - b.key
      : collator.compare(String(a.key), String(b.key));
    return sort.dir * first || a.index - b.index;
  }).map(({ row }) => row);
}
export function nextSort(current: SortState | null, column: { key: string; numeric?: boolean }): SortState | null {
  const first = column.numeric ? -1 : 1;
  if (current?.key !== column.key) return { key: column.key, dir: first };
  return current.dir === first ? { key: column.key, dir: first === 1 ? -1 : 1 } : null;
}
