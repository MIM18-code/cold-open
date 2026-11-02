import { type ScreenplayDoc, structurePoints } from "@screenplay/engine";
/**
 * Native project records are intentionally not screenplay paragraphs. Name them before an exchange save. The local
 * history ID is not listed: every native save writes one, and an exchange copy has no use for it.
 */
export function nativeOnlyFeatures(doc: ScreenplayDoc): string[] {
  const out = new Set<string>();
  for (const [key, value] of doc.meta.entries()) {
    if (key.startsWith("workbench.record.") && value) {
      const kind = (value as { kind?: string }).kind;
      out.add(kind === "note" ? "Anchored notes and replies" : kind === "alternative" ? "Alternate dialogue / action" : kind === "cut" ? "Saved Cuts" : kind === "beat" ? "Unassigned planning beats" : "Bookmarks");
    } else if (key.startsWith("workbench.canvas.")) out.add("Beat canvas positions and links");
    else if (key === "tableRead.cast.v1" && value) out.add("Table-read voice assignments");
    else if (value && (key.startsWith("tableRead.cast.v2.character.")
      || key.startsWith("tableRead.cast.v3.character."))) out.add("Table-read voice assignments");
    else if (key === "tableRead.pronunciations.v1" && Array.isArray(value) && value.length) out.add("Project pronunciations");
    else if (key === "editor.smartType.v1" && value) out.add("Custom SmartType lists");
  }
  // A deleted point can leave a stray field behind after a merge; only points that still exist count.
  if (structurePoints(doc).length) out.add("Structure points");
  return [...out].sort();
}
