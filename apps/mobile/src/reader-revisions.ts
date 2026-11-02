import { deletionMarks, revisedRanges, type Paragraph, type PhoneProduction } from "@screenplay/engine";

export type ReaderLine = { text: string; y: number; height: number };
export function revisionLines(paragraph: Paragraph, lines: ReaderLine[], production?: PhoneProduction) {
  const revision = production?.marks[paragraph.id];
  if (!revision) return [];
  const ranges = revisedRanges(paragraph), deletions = deletionMarks(paragraph);
  let offset = 0;
  return lines.flatMap((line, index) => {
    const start = offset;
    offset += line.text.length;
    const ids = [...ranges.filter(r => r.from < offset && r.to > start).map(r => r.setId),
      ...deletions.filter(d => d.offset >= start && (d.offset < offset || index === lines.length - 1 && d.offset === offset)).map(d => d.setId)];
    // Older snapshots and imported deletions may carry only a paragraph mark.
    if (!ids.length && (ranges.length || deletions.length || index > 0)) return [];
    const set = production?.sets.findLast(s => ids.length ? ids.includes(s.id) : s.name === revision.label && s.color === revision.color);
    return [{ y: line.y, height: line.height, mark: set?.mark || "*", color: set?.color ?? revision.color }];
  });
}

export function revisionColor(hex: string, dark: boolean) {
  if (!dark) return hex;
  let rgb = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const luminance = () => rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  while (luminance() < 0.3) rgb = rgb.map(v => Math.min(255, v + 8));
  return "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
}
