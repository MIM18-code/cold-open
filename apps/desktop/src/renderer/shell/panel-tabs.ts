/** Keep the active panel visible, then fill the row in registration order. */
export function visiblePanelTabs(widths: number[], active: number, room: number, moreWidth: number): number[] {
  const gap = 2;
  if (widths.reduce((sum, width) => sum + width + gap, -gap) <= room) {
    return widths.map((_, index) => index);
  }
  const visible = [active];
  let used = widths[active]! + gap + moreWidth;
  for (let index = 0; index < widths.length; index++) {
    if (index === active) continue;
    if (used + gap + widths[index]! > room) break;
    visible.push(index);
    used += gap + widths[index]!;
  }
  return visible.sort((a, b) => a - b);
}
