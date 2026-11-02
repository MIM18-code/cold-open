// Draft comparison. Paragraphs are matched by ID first (drafts saved from one document share IDs, and FDX
// round trips keep Final Draft's), then by text: an exact LCS, then word similarity for edited paragraphs, so
// a Fountain file re-imported with fresh IDs compares as well as one with stable IDs. Paragraphs that match
// out of order are moves. Scenes are matched by scene ID, then heading, then shared paragraphs.
import { type ElementType, NON_PRINTING, type Script, plainText } from "./model.ts";

export interface WordDiffPart {
  op: "equal" | "insert" | "delete";
  text: string;
}

export interface ParagraphChange {
  kind: "added" | "deleted" | "changed" | "moved";
  /** The revised paragraph's type, or the base type for a deleted paragraph. */
  type: ElementType;
  baseId?: string;
  revisedId?: string;
  baseText?: string;
  revisedText?: string;
  /** The scene the paragraph is in, in the base and in the revised script. Absent before the first heading. */
  baseSceneId?: string;
  revisedSceneId?: string;
  /** Word-level diff, when a paragraph that exists in both has different text. */
  words?: WordDiffPart[];
  /** The element type changed (Action to General). */
  baseType?: ElementType;
}

export type SceneStatus = "added" | "omitted" | "changed" | "moved" | "unchanged";

export interface SceneChange {
  /** "moved" means moved and otherwise untouched; a moved scene with edits is "changed" with moved set. */
  status: SceneStatus;
  moved?: true;
  baseSceneId?: string;
  revisedSceneId?: string;
  baseHeading?: string;
  revisedHeading?: string;
  baseNumber?: string;
  revisedNumber?: string;
  /** Changes inside this scene (deleted paragraphs sit in the scene they came from). */
  changes: ParagraphChange[];
}

export interface Comparison {
  /** Every change, in revised-script order with deletions where they were. */
  changes: ParagraphChange[];
  /** Every scene of the revised script in order, with omitted scenes where they were. Paragraphs before the first heading form a scene with no ID or heading. */
  scenes: SceneChange[];
  counts: {
    paragraphs: { added: number; deleted: number; changed: number; moved: number; unchanged: number };
    scenes: { added: number; omitted: number; changed: number; moved: number; unchanged: number };
    wordsAdded: number;
    wordsDeleted: number;
  };
  identical: boolean;
}

// ---------- sequence helpers ----------

/** Indexes of one longest strictly increasing subsequence. */
function increasing(values: readonly number[]): number[] {
  const tails: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);
  values.forEach((value, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) out.push(i);
  return out.reverse();
}

const DP_LIMIT = 9_000_000;

/** Longest common subsequence of two key lists as index pairs. Large mismatched inputs fall back to unique-line anchors. */
function align(a: readonly string[], b: readonly string[], offsetA = 0, offsetB = 0): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < head; i++) pairs.push([offsetA + i, offsetB + i]);
  const ma = a.slice(head, a.length - tail), mb = b.slice(head, b.length - tail);
  if (ma.length && mb.length) {
    const middle = ma.length * mb.length <= DP_LIMIT ? dpAlign(ma, mb) : anchorAlign(ma, mb);
    for (const [i, j] of middle) pairs.push([offsetA + head + i, offsetB + head + j]);
  }
  for (let i = tail; i > 0; i--) pairs.push([offsetA + a.length - i, offsetB + b.length - i]);
  return pairs;
}

function dpAlign(a: readonly string[], b: readonly string[]): [number, number][] {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Patience-style: match lines unique to both sides, keep the longest ordered run, recurse between them. */
function anchorAlign(a: readonly string[], b: readonly string[]): [number, number][] {
  const count = (list: readonly string[]) => list.reduce((map, key, i) => map.set(key, map.has(key) ? -1 : i), new Map<string, number>());
  const inA = count(a), inB = count(b);
  const anchors: [number, number][] = [];
  for (const [key, i] of inA) {
    const j = inB.get(key);
    if (i >= 0 && j !== undefined && j >= 0) anchors.push([i, j]);
  }
  anchors.sort((x, y) => x[0] - y[0]);
  const kept = increasing(anchors.map(([, j]) => j)).map((k) => anchors[k]!);
  if (!kept.length) return [];
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  for (const [ai, bj] of [...kept, [a.length, b.length] as [number, number]]) {
    if (ai > i && bj > j) pairs.push(...align(a.slice(i, ai), b.slice(j, bj), i, j));
    if (ai < a.length) pairs.push([ai, bj]);
    i = ai + 1;
    j = bj + 1;
  }
  return pairs;
}

// ---------- word diff ----------

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s]/gu;

/** Word-level diff of two texts. Equal, deleted and inserted stretches in order; joining equal and deleted gives the base. */
export function diffWords(base: string, revised: string): WordDiffPart[] {
  if (base === revised) return base ? [{ op: "equal", text: base }] : [];
  const a = base.match(TOKEN) ?? [], b = revised.match(TOKEN) ?? [];
  const parts: WordDiffPart[] = [];
  const push = (op: WordDiffPart["op"], text: string) => {
    const last = parts.at(-1);
    if (last?.op === op) last.text += text;
    else parts.push({ op, text });
  };
  let i = 0, j = 0;
  for (const [pi, pj] of [...align(a, b), [a.length, b.length] as [number, number]]) {
    if (i < pi) push("delete", a.slice(i, pi).join(""));
    if (j < pj) push("insert", b.slice(j, pj).join(""));
    if (pi < a.length) push("equal", a[pi]!);
    i = pi + 1;
    j = pj + 1;
  }
  return parts;
}

/** Character ranges of inserted text within the revised paragraph's text. */
export function insertedRanges(parts: readonly WordDiffPart[]): [number, number][] {
  const ranges: [number, number][] = [];
  let at = 0;
  for (const part of parts) {
    if (part.op === "delete") continue;
    if (part.op === "insert") ranges.push([at, at + part.text.length]);
    at += part.text.length;
  }
  return ranges;
}

function wordsIn(parts: readonly WordDiffPart[], op: "insert" | "delete"): number {
  return parts.filter((part) => part.op === op).reduce((sum, part) => sum + (part.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
}

// ---------- matching ----------

interface Item {
  id: string;
  type: ElementType;
  text: string;
  /** Lower case, one space between words: what the exact match compares. */
  key: string;
  /** Word counts for similarity. */
  bag: Map<string, number>;
  /** Index into the script's scene groups. */
  group: number;
}

interface Group {
  sceneId?: string;
  heading?: string;
  number?: string;
  items: number[];
}

interface Side {
  items: Item[];
  groups: Group[];
}

const NAME = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

function read(script: Script): Side {
  const items: Item[] = [];
  const groups: Group[] = [{ items: [] }];
  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "sceneHeading") {
      const text = plainText(paragraph.runs);
      groups.push({ sceneId: paragraph.sceneId ?? paragraph.id, heading: text, ...(paragraph.sceneNumber !== undefined ? { number: paragraph.sceneNumber } : {}), items: [] });
    }
    if (NON_PRINTING.has(paragraph.type)) continue;
    const text = plainText(paragraph.runs);
    if (!text.trim()) continue;
    const bag = new Map<string, number>();
    for (const word of text.toLowerCase().match(NAME) ?? []) bag.set(word, (bag.get(word) ?? 0) + 1);
    groups.at(-1)!.items.push(items.length);
    items.push({ id: paragraph.id, type: paragraph.type, text, key: text.toLowerCase().replace(/\s+/g, " ").trim(), bag, group: groups.length - 1 });
  }
  // Paragraphs before the first heading are a group of their own, kept only when there are any.
  if (!groups[0]!.items.length) {
    groups.shift();
    for (const item of items) item.group--;
  }
  return { items, groups };
}

function similarity(a: Item, b: Item): number {
  if (a.key === b.key) return 1;
  let shared = 0, total = 0;
  for (const count of a.bag.values()) total += count;
  for (const count of b.bag.values()) total += count;
  if (!total) return 0;
  for (const [word, count] of a.bag) shared += Math.min(count, b.bag.get(word) ?? 0);
  return (2 * shared) / total;
}

const SIMILAR = 0.5;
const SIMILAR_OTHER_TYPE = 0.75;
const SIMILAR_MOVED = 0.8;

function similarEnough(a: Item, b: Item, floor: number): number {
  const score = similarity(a, b);
  return score >= (a.type === b.type ? floor : Math.max(floor, SIMILAR_OTHER_TYPE)) ? score : 0;
}

/** Order-preserving pairing of two short lists that maximizes total similarity. */
function alignSimilar(base: Item[], bi: number[], rev: Item[], ri: number[]): [number, number][] {
  if (!bi.length || !ri.length || bi.length * ri.length > 1_000_000) return [];
  const width = ri.length + 1;
  const score = new Float32Array((bi.length + 1) * width);
  const fit = (i: number, j: number) => similarEnough(base[bi[i]!]!, rev[ri[j]!]!, SIMILAR);
  for (let i = bi.length - 1; i >= 0; i--) {
    for (let j = ri.length - 1; j >= 0; j--) {
      const s = fit(i, j);
      score[i * width + j] = Math.max(score[(i + 1) * width + j]!, score[i * width + j + 1]!, s ? score[(i + 1) * width + j + 1]! + s : 0);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < bi.length && j < ri.length) {
    const s = fit(i, j);
    if (s && Math.abs(score[i * width + j]! - (score[(i + 1) * width + j + 1]! + s)) < 1e-4) pairs.push([bi[i++]!, ri[j++]!]);
    else if (score[(i + 1) * width + j]! >= score[i * width + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Pair the unmatched paragraphs between two anchors: identical text, then edited text. */
function matchGap(base: Side, rev: Side, bi: number[], ri: number[], link: (b: number, r: number) => void): void {
  const exact = align(bi.map((i) => base.items[i]!.key), ri.map((i) => rev.items[i]!.key));
  let b = 0, r = 0;
  for (const [pb, pr] of [...exact, [bi.length, ri.length] as [number, number]]) {
    for (const [x, y] of alignSimilar(base.items, bi.slice(b, pb), rev.items, ri.slice(r, pr))) link(x, y);
    if (pb < bi.length) link(bi[pb]!, ri[pr]!);
    b = pb + 1;
    r = pr + 1;
  }
}

const normalizeHeading = (heading: string | undefined) => (heading ?? "").toLowerCase().replace(/^\s*#?\d+[a-z]?[.)]?\s+(?=\S)/, "").replace(/\s+/g, " ").trim();

export function compareScripts(base: Script, revised: Script): Comparison {
  const a = read(base), b = read(revised);
  const baseMatch: number[] = new Array(a.items.length).fill(-1);
  const revMatch: number[] = new Array(b.items.length).fill(-1);
  const moved = new Set<number>(); // revised item indexes matched out of order
  const link = (x: number, y: number) => {
    baseMatch[x] = y;
    revMatch[y] = x;
  };

  // 1. Same ID in both. Pairs that cross the longest in-order run are moves.
  const unique = (items: Item[]) => items.reduce((map, item, i) => map.set(item.id, map.has(item.id) ? -1 : i), new Map<string, number>());
  const baseIds = unique(a.items), revIds = unique(b.items);
  const byId: [number, number][] = [];
  b.items.forEach((item, y) => {
    const x = baseIds.get(item.id);
    if (x !== undefined && x >= 0 && revIds.get(item.id) === y) byId.push([x, y]);
  });
  const inOrder = new Set(increasing(byId.map(([x]) => x)));
  byId.forEach(([x, y], k) => {
    link(x, y);
    if (!inOrder.has(k)) moved.add(y);
  });

  // 2. Between the anchors that stayed in order: identical text, then similar text.
  const anchors = byId.filter((_, k) => inOrder.has(k));
  let prevB = -1, prevR = -1;
  for (const [x, y] of [...anchors, [a.items.length, b.items.length] as [number, number]]) {
    const gapB: number[] = [], gapR: number[] = [];
    for (let i = prevB + 1; i < x; i++) if (baseMatch[i]! < 0) gapB.push(i);
    for (let i = prevR + 1; i < y; i++) if (revMatch[i]! < 0) gapR.push(i);
    matchGap(a, b, gapB, gapR, link);
    prevB = x;
    prevR = y;
  }

  // 3. Whatever is left may have moved: identical text first, then edited text.
  const loose = (side: number[]) => side.map((_, i) => i).filter((i) => side[i]! < 0);
  const looseB = loose(baseMatch), looseR = loose(revMatch);
  const byKey = new Map<string, number[]>();
  for (const x of looseB) byKey.set(a.items[x]!.key, [...(byKey.get(a.items[x]!.key) ?? []), x]);
  for (const y of looseR) {
    const x = byKey.get(b.items[y]!.key)?.shift();
    if (x !== undefined) (link(x, y), moved.add(y));
  }
  const stillB = looseB.filter((x) => baseMatch[x]! < 0), stillR = looseR.filter((y) => revMatch[y]! < 0);
  if (stillB.length * stillR.length <= 1_000_000) {
    for (const y of stillR) {
      let best = -1, bestScore = 0;
      for (const x of stillB) {
        if (baseMatch[x]! >= 0) continue;
        const s = similarEnough(a.items[x]!, b.items[y]!, SIMILAR_MOVED);
        if (s > bestScore) (best = x, bestScore = s);
      }
      if (best >= 0) (link(best, y), moved.add(y));
    }
  }

  // A paragraph that only travelled with its scene is not a paragraph move.
  const pairing = pairScenes(a, b, revMatch);
  for (const y of [...moved]) {
    const x = revMatch[y]!;
    if (x >= 0 && pairing.pairOf.get(b.items[y]!.group) === a.items[x]!.group && !pairing.stays.has(a.items[x]!.group)) moved.delete(y);
  }

  // Paragraph changes, placed by revised position. A deletion sorts just after the last in-place paragraph before it.
  const baseSceneId = (item: Item) => a.groups[item.group]?.sceneId;
  const revisedSceneId = (item: Item) => b.groups[item.group]?.sceneId;
  const placed: { at: number; sub: number; change: ParagraphChange }[] = [];
  let unchanged = 0, wordsAdded = 0, wordsDeleted = 0;
  b.items.forEach((item, y) => {
    const x = revMatch[y]!;
    if (x < 0) {
      const added = countWordsIn(item.text);
      wordsAdded += added;
      placed.push({ at: 2 * y + 1, sub: 0, change: {
        kind: "added", type: item.type, revisedId: item.id, revisedText: item.text, ...(revisedSceneId(item) ? { revisedSceneId: revisedSceneId(item)! } : {}),
      } });
      return;
    }
    const before = a.items[x]!;
    const textChanged = squeeze(before.text) !== squeeze(item.text), typeChanged = before.type !== item.type;
    if (!textChanged && !typeChanged && !moved.has(y)) {
      unchanged++;
      return;
    }
    const words = textChanged ? diffWords(before.text, item.text) : undefined;
    if (words) {
      wordsAdded += wordsIn(words, "insert");
      wordsDeleted += wordsIn(words, "delete");
    }
    placed.push({ at: 2 * y + 1, sub: 0, change: {
      kind: moved.has(y) ? "moved" : "changed", type: item.type, baseId: before.id, revisedId: item.id, baseText: before.text, revisedText: item.text,
      ...(baseSceneId(before) ? { baseSceneId: baseSceneId(before)! } : {}),
      ...(revisedSceneId(item) ? { revisedSceneId: revisedSceneId(item)! } : {}),
      ...(words ? { words } : {}),
      ...(typeChanged ? { baseType: before.type } : {}),
    } });
  });
  let lastStay = -1;
  a.items.forEach((item, x) => {
    const y = baseMatch[x]!;
    if (y >= 0) {
      if (!moved.has(y)) lastStay = y;
      return;
    }
    wordsDeleted += countWordsIn(item.text);
    placed.push({ at: 2 * (lastStay + 1), sub: x, change: {
      kind: "deleted", type: item.type, baseId: item.id, baseText: item.text, ...(baseSceneId(item) ? { baseSceneId: baseSceneId(item)! } : {}),
    } });
  });
  placed.sort((p, q) => p.at - q.at || p.sub - q.sub);
  const changes = placed.map((p) => p.change);

  const scenes = compareScenes(a, b, pairing, changes);
  const counts = {
    paragraphs: {
      added: changes.filter((c) => c.kind === "added").length,
      deleted: changes.filter((c) => c.kind === "deleted").length,
      changed: changes.filter((c) => c.kind === "changed").length,
      moved: changes.filter((c) => c.kind === "moved").length,
      unchanged,
    },
    scenes: {
      added: scenes.filter((s) => s.status === "added").length,
      omitted: scenes.filter((s) => s.status === "omitted").length,
      changed: scenes.filter((s) => s.status === "changed").length,
      moved: scenes.filter((s) => s.moved).length,
      unchanged: scenes.filter((s) => s.status === "unchanged").length,
    },
    wordsAdded,
    wordsDeleted,
  };
  const identical = !changes.length && scenes.every((s) => s.status === "unchanged");
  return { changes, scenes, counts, identical };
}

/** Spacing differences (trailing spaces, doubled spaces) are not edits; Final Draft and Fountain files differ in them. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function countWordsIn(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

interface ScenePairing {
  /** Revised group to base group. */
  pairOf: Map<number, number>;
  /** Base groups that kept their place in the scene order; matched scenes outside this set moved. */
  stays: Set<number>;
}

function pairScenes(a: Side, b: Side, revMatch: number[]): ScenePairing {
  const pairOf = new Map<number, number>();
  const taken = new Set<number>();
  const pair = (g: number, h: number) => (pairOf.set(h, g), taken.add(g));
  // The leading group without a heading matches its twin.
  if (!a.groups[0]?.sceneId && !b.groups[0]?.sceneId && a.groups[0] && b.groups[0]) pair(0, 0);
  const byScene = new Map<string, number>();
  a.groups.forEach((group, g) => group.sceneId && byScene.set(group.sceneId, g));
  b.groups.forEach((group, h) => {
    const g = group.sceneId ? byScene.get(group.sceneId) : undefined;
    if (g !== undefined && !taken.has(g)) pair(g, h);
  });
  b.groups.forEach((group, h) => {
    if (pairOf.has(h) || !group.sceneId) return;
    const g = a.groups.findIndex((other, i) => !taken.has(i) && other.sceneId && normalizeHeading(other.heading) === normalizeHeading(group.heading));
    if (g >= 0) pair(g, h);
  });
  // Scenes whose headings were rewritten still match when most of their paragraphs do.
  const overlap = new Map<string, number>();
  b.items.forEach((item, y) => {
    const x = revMatch[y]!;
    if (x < 0) return;
    const key = `${a.items[x]!.group}:${item.group}`;
    overlap.set(key, (overlap.get(key) ?? 0) + 1);
  });
  [...overlap].map(([key, n]) => ({ g: Number(key.split(":")[0]), h: Number(key.split(":")[1]), n })).sort((p, q) => q.n - p.n).forEach(({ g, h, n }) => {
    if (taken.has(g) || pairOf.has(h) || !a.groups[g]!.sceneId || !b.groups[h]!.sceneId) return;
    if (n * 2 >= Math.min(a.groups[g]!.items.length, b.groups[h]!.items.length)) pair(g, h);
  });

  // Scenes that left the longest in-order run moved.
  const matched = [...pairOf].filter(([h]) => b.groups[h]!.sceneId).sort((p, q) => p[0] - q[0]);
  const stays = new Set(increasing(matched.map(([, g]) => g)).map((k) => matched[k]![1]));
  return { pairOf, stays };
}

function compareScenes(a: Side, b: Side, { pairOf, stays }: ScenePairing, changes: ParagraphChange[]): SceneChange[] {
  // Group the changes by the scene they belong to: the revised group, or for deletions the base group's partner.
  const changeGroup = new Map<ParagraphChange, { base?: number; revised?: number }>();
  const itemById = (side: Side, id: string) => side.items.find((item) => item.id === id);
  for (const change of changes) {
    const base = change.baseId !== undefined ? itemById(a, change.baseId)?.group : undefined;
    const revised = change.revisedId !== undefined ? itemById(b, change.revisedId)?.group : undefined;
    changeGroup.set(change, { ...(base !== undefined ? { base } : {}), ...(revised !== undefined ? { revised } : {}) });
  }

  const out: { at: number; sub: number; scene: SceneChange }[] = [];
  const baseOfRevised = new Map(pairOf);
  const revisedOfBase = new Map([...pairOf].map(([h, g]) => [g, h]));
  b.groups.forEach((group, h) => {
    const g = baseOfRevised.get(h);
    const before = g === undefined ? undefined : a.groups[g];
    const own = changes.filter((c) => {
      const where = changeGroup.get(c)!;
      return c.kind === "deleted" ? where.base !== undefined && revisedOfBase.get(where.base) === h : where.revised === h;
    });
    const movedAway = g !== undefined && changes.some((c) => c.kind === "moved" && changeGroup.get(c)!.base === g && changeGroup.get(c)!.revised !== h);
    const sceneMoved = g !== undefined && !!before?.sceneId && !stays.has(g);
    const headingChanged = !!before && before.heading !== group.heading;
    const touched = own.length > 0 || movedAway || headingChanged;
    const scene: SceneChange = {
      status: g === undefined ? "added" : touched ? "changed" : sceneMoved ? "moved" : "unchanged",
      ...(sceneMoved ? { moved: true as const } : {}),
      ...(before?.sceneId ? { baseSceneId: before.sceneId } : {}),
      ...(group.sceneId ? { revisedSceneId: group.sceneId } : {}),
      ...(before?.heading !== undefined ? { baseHeading: before.heading } : {}),
      ...(group.heading !== undefined ? { revisedHeading: group.heading } : {}),
      ...(before?.number !== undefined ? { baseNumber: before.number } : {}),
      ...(group.number !== undefined ? { revisedNumber: group.number } : {}),
      changes: own,
    };
    out.push({ at: 2 * h + 1, sub: 0, scene });
  });
  // Omitted scenes sit after the last scene before them that stayed where it was.
  let lastStay = -1;
  a.groups.forEach((group, g) => {
    const h = revisedOfBase.get(g);
    if (h !== undefined) {
      if (stays.has(g) || !group.sceneId) lastStay = h;
      return;
    }
    const own = changes.filter((c) => c.kind === "deleted" && changeGroup.get(c)!.base === g);
    out.push({ at: 2 * (lastStay + 1), sub: g, scene: {
      status: "omitted",
      ...(group.sceneId ? { baseSceneId: group.sceneId } : {}),
      ...(group.heading !== undefined ? { baseHeading: group.heading } : {}),
      ...(group.number !== undefined ? { baseNumber: group.number } : {}),
      changes: own,
    } });
  });
  return out.sort((p, q) => p.at - q.at || p.sub - q.sub).map((entry) => entry.scene);
}
