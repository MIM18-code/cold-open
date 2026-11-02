import { paginate, scenesOf, type Pagination, type PaginationOptions, type Script } from "@screenplay/engine";

export interface CompactSides { script: Script; pagination: Pagination; sourcePages: Map<string, string[]>; }
/** A delivery-only copy: published source numbers survive; original page locks do not repaginate the master. */
export function compactSides(source: Script, original: Pagination, chosen: ReadonlySet<string>, options: PaginationOptions = {}): CompactSides {
  const scenes = scenesOf(source.paragraphs);
  const paragraphs = scenes.flatMap((scene, index) => {
    if (!chosen.has(scene.sceneId)) return [];
    return source.paragraphs.slice(scene.start, scene.end).map((p) => {
      const copy = structuredClone(p);
      delete copy.startsNewPage;
      if (p.id === scene.headingId && copy.sceneNumber === undefined) copy.sceneNumber = String(index + 1);
      return copy;
    });
  });
  const script: Script = { ...source, paragraphs, titlePage: [] };
  const { locks: _locks, ...unlocked } = options;
  const pagination = paginate(script, { ...unlocked, page: original.layout.page, elements: original.layout.elements });
  const byParagraph = new Map<string, { page: string; from: number; to: number }[]>();
  for (const page of original.pages) for (const line of page.lines) {
    if (line.generated) continue;
    const rows = byParagraph.get(line.paragraphId) ?? [];
    rows.push({ page: page.number, from: line.from, to: line.to });
    byParagraph.set(line.paragraphId, rows);
  }
  const order = new Map(original.pages.map((p, i) => [p.number, i]));
  const sourcePages = new Map(pagination.pages.map((page) => {
    const refs = new Set<string>();
    for (const line of page.lines) {
      if (line.generated) continue;
      for (const old of byParagraph.get(line.paragraphId) ?? []) {
        if (Math.min(line.to, old.to) > Math.max(line.from, old.from) || line.from === line.to && old.from === old.to) refs.add(old.page);
      }
    }
    return [page.number, [...refs].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))] as const;
  }));
  return { script, pagination, sourcePages };
}
