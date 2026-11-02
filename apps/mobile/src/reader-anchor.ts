export function readerAnchor<T extends { id: string }>(rows: T[], anchor: string | undefined,
  previous: string[], visible?: string) {
  const exact = rows.find(r => r.id === anchor);
  if (exact) return { row: exact, changed: false };
  const oldIndex = previous.indexOf(anchor ?? "");
  if (oldIndex >= 0) {
    const byId = new Map(rows.map(r => [r.id, r]));
    for (let distance = 1; distance < previous.length; distance++) {
      const neighbor = byId.get(previous[oldIndex + distance] ?? "")
        ?? byId.get(previous[oldIndex - distance] ?? "");
      if (neighbor) return { row: neighbor, changed: true };
    }
  }
  return { row: rows.find(r => r.id === visible), changed: !!anchor };
}
