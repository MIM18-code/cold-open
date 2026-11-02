import assert from "node:assert/strict";
import test from "node:test";
import { nextSort, sortRows, type SortColumn } from "../src/renderer/features/reports/sort.ts";

type Row = { id: string; label: string; eighths: number; display: string };
const columns: SortColumn<Row>[] = [
  { key: "label", value: (r) => r.label },
  { key: "length", value: (r) => r.display, sort: (r) => r.eighths, numeric: true },
];
const rows: Row[] = [
  { id: "a", label: "Zeta", eighths: 8, display: "1" },
  { id: "b", label: "Alpha", eighths: 14, display: "1 6/8" },
  { id: "c", label: "Beta", eighths: 8, display: "1" },
];

test("report ordering honors numeric eighths and keeps equal rows stable", () => {
  const sort = nextSort(null, columns[1]!);
  assert.deepEqual(sortRows(rows, columns, sort).map((r) => r.id), ["b", "a", "c"]);
  const reverse = nextSort(sort, columns[1]!);
  assert.deepEqual(sortRows(rows, columns, reverse).map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(sortRows(rows, columns, nextSort(reverse, columns[1]!)), rows);
});

test("a report export can consume the exact same ordered rows as the visible table", () => {
  const sort = nextSort(null, columns[0]!);
  const displayed = sortRows(rows, columns, sort);
  const csvRows = displayed.map((r) => [r.label, r.display]);
  assert.deepEqual(csvRows, [["Alpha", "1 6/8"], ["Beta", "1"], ["Zeta", "1"]]);
});
