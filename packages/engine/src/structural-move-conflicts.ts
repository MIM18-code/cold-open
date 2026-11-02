import * as Y from "yjs";
import type { ScreenplayDoc } from "./doc.ts";
import { plainText } from "./model.ts";
import { MOVE_KNOWLEDGE_PREFIX, type MoveKnowledge, type MoveSpan } from "./move-knowledge.ts";

type Delta = { insert: string; attributes?: Record<string, unknown> };
type Span = { client: number; clock: number; length: number };
type Range = { start: number; length: number; paragraphId: string; boundary?: Span };
export interface StructuralMoveConflict {
  id: string;
  paragraphId: string;
  sceneId: string;
  heading: string;
  text: string;
  currentParagraphId: string;
  spans: Span[];
  boundary?: Span;
  delta: Delta[];
}

function attributesKey(attributes: Record<string, unknown> = {}): string {
  return JSON.stringify(Object.entries(attributes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function append(delta: Delta[], text: string, attributes: Record<string, unknown>): void {
  const last = delta.at(-1);
  if (last && attributesKey(last.attributes) === attributesKey(attributes)) last.insert += text;
  else delta.push({ insert: text, ...(Object.keys(attributes).length ? { attributes: structuredClone(attributes) } : {}) });
}

function signature(delta: Delta[]): string {
  return JSON.stringify(delta.map(op => [op.insert, attributesKey(op.attributes)]));
}

function format(attributes: Record<string, unknown>, content: Y.ContentFormat): void {
  if (content.value === null) delete attributes[content.key];
  else attributes[content.key] = content.value;
}

function changedItems(doc: ScreenplayDoc, transaction: Y.Transaction): Y.Item[] {
  const items = new Set<Y.Item>();
  for (const [client, clock] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= clock) continue;
    const structs = doc.ydoc.store.clients.get(client)!;
    for (let i = Y.findIndexSS(structs, from); i < structs.length && structs[i]!.id.clock < clock; i++) {
      const item = structs[i]!;
      if (item instanceof Y.Item && item.parent === doc.body) items.add(item);
    }
  }
  for (const [client, ranges] of transaction.deleteSet.clients) {
    const structs = doc.ydoc.store.clients.get(client);
    if (!structs) continue;
    for (const range of ranges) for (let i = Y.findIndexSS(structs, range.clock); i < structs.length && structs[i]!.id.clock < range.clock + range.len; i++) {
      const item = structs[i]!;
      if (item instanceof Y.Item && item.parent === doc.body) items.add(item);
    }
  }
  return [...items];
}

function spanIndex(spans: MoveSpan[]): Map<number, MoveSpan[]> {
  const index = new Map<number, MoveSpan[]>();
  for (const span of spans) {
    const list = index.get(span[0]) ?? [];
    list.push(span); index.set(span[0], list);
  }
  return index;
}

function inSpans(index: Map<number, MoveSpan[]>, client: number, clock: number): boolean {
  const spans = index.get(client) ?? [];
  let low = 0, high = spans.length;
  while (low < high) { const mid = (low + high) >>> 1; if (spans[mid]![1] <= clock) low = mid + 1; else high = mid; }
  const span = spans[low - 1];
  return !!span && clock < span[1] + span[2];
}

/** During observers, evaluate newly received records against the current body, including collected source items. */
export function strandedByMove(doc: ScreenplayDoc, transaction: Y.Transaction): StructuralMoveConflict[] {
  const changed = transaction.changed as Map<unknown, Set<string | null>>;
  if (transaction.local) return [];
  const metaKeys = changed.get(doc.meta);
  if (![...(metaKeys ?? [])].some(key => key?.startsWith(MOVE_KNOWLEDGE_PREFIX))) return [];
  type Operation = { record: MoveKnowledge; mover: number; vector: Map<number, number>; spans: Map<number, MoveSpan[]>; chars: Map<number, MoveSpan[]> };
  const operations: Operation[] = [];
  // An overwritten write may arrive only as a tombstone, so clocks alone do not prove receipt.
  const changes = new Y.YMapEvent(doc.meta, transaction, metaKeys!).keys;
  for (const key of metaKeys ?? []) {
    if (!key?.startsWith(MOVE_KNOWLEDGE_PREFIX)) continue;
    const records = doc.meta.get(key);
    if (!Array.isArray(records) || !records.length) continue;
    const item = doc.meta._map.get(key), mover = Number(key.slice(MOVE_KNOWLEDGE_PREFIX.length));
    // Undo/Redo restores an old array under a new item identity and is deliberately not diagnosed.
    if (!item || item.id.client !== mover || item.id.clock !== records.at(-1)?.at) continue;
    const previous = changes.get(key)?.oldValue;
    const received = new Set(Array.isArray(previous) ? previous.map((record: MoveKnowledge) => record.at) : []);
    for (const record of records as MoveKnowledge[]) {
      if (!record || typeof record.sv !== "string" || !Array.isArray(record.spans) || !Array.isArray(record.chars)) continue;
      if (received.has(record.at)) continue;
      // moveRanges writes the record in the move's own transaction. A record whose deletions arrived earlier
      // cannot tell concurrent typing from typing done since, so it is skipped (a miss, never a false notice).
      // Every recorded deletion must be new here; a scope partly deleted earlier could cover typing done since.
      if (!record.spans.every(([client, clock, length]: [number, number, number]) =>
        Y.isDeleted(transaction.deleteSet, Y.createID(client, clock)) && Y.isDeleted(transaction.deleteSet, Y.createID(client, clock + length - 1)))) continue;
      try {
        operations.push({ record, mover, vector: Y.decodeStateVector(Uint8Array.from(atob(record.sv), char => char.charCodeAt(0))),
          spans: spanIndex(record.spans), chars: spanIndex(record.chars) });
      } catch { continue; }
    }
  }
  if (!operations.length) return [];
  const boundaries = new Map<number, number[]>();
  const boundary = (client: number, clock: number) => {
    const list = boundaries.get(client) ?? [];
    list.push(clock); boundaries.set(client, list);
  };
  for (const { record, mover, vector } of operations) {
    for (const [client, clock] of vector) boundary(client, clock);
    boundary(mover, record.at);
    for (const [client, clock, length] of [...record.spans, ...record.chars]) { boundary(client, clock); boundary(client, clock + length); }
  }
  for (const [client, values] of boundaries) boundaries.set(client, [...new Set(values)].sort((a, b) => a - b));
  type Source = { id: string; sceneId: string; headingId: string };
  type Token = { item: Y.Item; clock: number; length: number; start: number; paragraphId: string;
    text?: string; attributes?: Record<string, unknown>; source?: Source };
  const tokens: Token[] = [], attributes: Record<string, unknown> = {};
  let at = 0, paragraphId = "";
  for (let item = doc.body._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentFormat) format(attributes, item.content);
    const from = item.id.clock, end = from + item.length, list = boundaries.get(item.id.client) ?? [];
    let low = 0, high = list.length;
    while (low < high) { const mid = (low + high) >>> 1; if (list[mid]! <= from) low = mid + 1; else high = mid; }
    const cuts = [from, end];
    for (let i = low; i < list.length && list[i]! < end; i++) cuts.push(list[i]!);
    const text = !item.deleted && item.content instanceof Y.ContentString ? item.content.str : undefined;
    if (text !== undefined) for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) cuts.push(from + i, from + i + 1);
    const sorted = [...new Set(cuts)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const clock = sorted[i]!, length = sorted[i + 1]! - clock, part = text?.slice(clock - from, clock - from + length);
      tokens.push({ item, clock, length, start: at, paragraphId, ...(part !== undefined ? { text: part, attributes: { ...attributes } } : {}) });
      if (part !== undefined) {
        at += length;
        if (part === "\n" && !attributes.soft && typeof attributes.id === "string") paragraphId = attributes.id;
      }
    }
  }
  for (const { record, mover, vector, spans, chars } of operations) {
    const total = record.chars.reduce((sum, [, , length]) => sum + length, 0);
    const labels: { offset: number; source: Source }[] = [];
    let copied = 0, original = 0, sceneId = "", headingId = "";
    for (const token of tokens) {
      if (inSpans(chars, token.item.id.client, token.clock)) original += token.length;
      if (token.text === undefined || token.item.id.client !== mover || token.clock < (vector.get(mover) ?? 0) || token.clock + token.length > record.at) continue;
      const attrs = token.attributes!;
      if (token.text === "\n" && !attrs.soft && typeof attrs.id === "string") {
        if (!labels.length || attrs.type === "sceneHeading" || attrs.type === "section") {
          sceneId = typeof attrs.sceneId === "string" ? attrs.sceneId : attrs.id; headingId = attrs.id;
        }
        labels.push({ offset: copied, source: { id: attrs.id, sceneId, headingId } });
      }
      copied += token.length;
    }
    // Without an intact copy, GC may have erased the source paragraph identities. Prefer a miss.
    if (!total || original !== total || copied !== total || labels[0]?.offset !== 0) continue;
    type Entry = { token: Token; source: Source; scoped: boolean; char: boolean };
    let region: Entry[] = [], ordinal = 0, label = 0;
    const covered = (token: Token) => token.clock < (vector.get(token.item.id.client) ?? 0);
    const flush = () => {
      if (!region.some(entry => entry.scoped && entry.char)) { region = []; return; }
      const first = region.findIndex(entry => entry.scoped);
      let last = region.length - 1;
      while (!region[last]!.scoped) last--;
      const members = new Map<number, [number, number][]>();
      const include = ({ token, source }: Entry) => {
        const list = members.get(token.item.id.client) ?? [];
        list.push([token.clock, token.clock + token.length]); members.set(token.item.id.client, list);
        if (token.text !== undefined && token.item.id.client === doc.ydoc.clientID && !covered(token)) token.source ??= source;
      };
      for (let i = first; i <= last; i++) include(region[i]!);
      for (let i = last + 1; i < region.length; i++) {
        const entry = region[i]!, origin = entry.token.item.origin;
        if (origin && members.get(origin.client)?.some(([from, to]) => origin.clock >= from && origin.clock < to)) include(entry);
        else if (!entry.token.item.deleted) break;
      }
      region = [];
    };
    for (const token of tokens) {
      const char = inSpans(chars, token.item.id.client, token.clock), scoped = token.item.deleted && inSpans(spans, token.item.id.client, token.clock);
      if (char) {
        ordinal += token.length;
        while (label + 1 < labels.length && labels[label + 1]!.offset < ordinal) label++;
      }
      const unscopedDeletion = token.item.deleted && !scoped;
      if (unscopedDeletion || token.text !== undefined && covered(token)) flush();
      else region.push({ token, source: labels[label]!.source, scoped, char });
    }
    flush();
  }
  const conflicts: StructuralMoveConflict[] = [];
  for (let i = 0; i < tokens.length;) {
    const first = tokens[i]!;
    if (!first.source || first.text === undefined) { i++; continue; }
    const run: Token[] = [first]; i++;
    while (i < tokens.length) {
      const next = tokens[i]!;
      if (next.text === undefined) {
        if (next.item.deleted && operations.some(operation => inSpans(operation.chars, next.item.id.client, next.clock))) break;
        i++; continue;
      }
      if (next.source?.id !== first.source.id || next.start !== run.at(-1)!.start + run.at(-1)!.length) break;
      run.push(next); i++;
    }
    const delta: Delta[] = [];
    for (const token of run) append(delta, token.text!, token.attributes!);
    conflicts.push({ id: `${first.item.id.client}-${first.clock}`, paragraphId: first.source.id,
      sceneId: first.source.sceneId, heading: doc.has(first.source.headingId) ? plainText(doc.paragraph(first.source.headingId).runs) : "",
      text: run.map(token => token.text).join(""), currentParagraphId: first.paragraphId || doc.paragraphs()[0]?.id || "",
      spans: run.map(token => ({ client: token.item.id.client, clock: token.clock, length: token.length })), delta });
  }
  const ranges = locateRanges(doc, conflicts);
  return conflicts.filter(conflict => {
    const range = ranges.get(conflict);
    if (!range || range.paragraphId === conflict.paragraphId) return false;
    conflict.boundary = range.boundary;
    return true;
  });
}

function locateRanges(doc: ScreenplayDoc, conflicts: readonly StructuralMoveConflict[]): Map<StructuralMoveConflict, Range> {
  type Ref = { span: Span; conflict: StructuralMoveConflict };
  type Match = { start: number; matched: number; paragraphId: string; boundary?: Span; delta: Delta[]; valid: boolean };
  const refs = new Map<number, Ref[]>(), matches = new Map<StructuralMoveConflict, Match>();
  for (const conflict of conflicts) {
    matches.set(conflict, { start: -1, matched: 0, paragraphId: "", delta: [], valid: true });
    for (const span of conflict.spans) {
      const list = refs.get(span.client) ?? [];
      list.push({ span, conflict }); refs.set(span.client, list);
    }
  }
  for (const list of refs.values()) list.sort((a, b) => a.span.clock - b.span.clock);
  const attributes: Record<string, unknown> = {};
  let at = 0, paragraphId = "", boundary: Span | undefined;
  for (let item = conflicts.length ? doc.body._start : null; item; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentFormat) { format(attributes, item.content); continue; }
    if (!(item.content instanceof Y.ContentString)) continue;
    const list = refs.get(item.id.client) ?? [];
    let clock = item.id.clock;
    for (const text of item.content.str.match(/\n|[^\n]+/g) ?? []) {
      let low = 0, high = list.length;
      while (low < high) { const mid = (low + high) >>> 1; if (list[mid]!.span.clock + list[mid]!.span.length <= clock) low = mid + 1; else high = mid; }
      for (let i = low; i < list.length && list[i]!.span.clock < clock + text.length; i++) {
        const { span, conflict } = list[i]!, match = matches.get(conflict)!;
        const from = Math.max(clock, span.clock), to = Math.min(clock + text.length, span.clock + span.length), start = at + from - clock;
        if (match.start < 0) { match.start = start; match.paragraphId = paragraphId; match.boundary = boundary; }
        if (start !== match.start + match.matched) match.valid = false;
        match.matched += to - from;
        append(match.delta, text.slice(from - clock, to - clock), attributes);
      }
      if (text === "\n" && !attributes.soft && typeof attributes.id === "string") {
        paragraphId = attributes.id;
        boundary = { client: item.id.client, clock, length: 1 };
      }
      at += text.length; clock += text.length;
    }
  }
  const ranges = new Map<StructuralMoveConflict, Range>();
  for (const [conflict, match] of matches) if (match.valid && match.start >= 0 && match.matched === conflict.text.length && signature(match.delta) === signature(conflict.delta)) {
    ranges.set(conflict, { start: match.start, length: match.matched, paragraphId: match.paragraphId, boundary: match.boundary });
  }
  return ranges;
}

function touchesNotices(doc: ScreenplayDoc, conflicts: readonly StructuralMoveConflict[], transaction: Y.Transaction): boolean {
  const spans = conflicts.flatMap(conflict => [...conflict.spans, ...(conflict.boundary ? [conflict.boundary] : [])]);
  const ids = new Set(conflicts.flatMap(conflict => [conflict.paragraphId, conflict.currentParagraphId, conflict.sceneId]));
  const contains = (id: Y.ID | null) => id !== null && spans.some(span => span.client === id.client && id.clock >= span.clock && id.clock < span.clock + span.length);
  if (spans.some(span => transaction.deleteSet.clients.get(span.client)?.some(range => range.clock < span.clock + span.length && range.clock + range.len > span.clock))) return true;
  return changedItems(doc, transaction).some(item => {
    if (item.content instanceof Y.ContentFormat && item.content.key === "id" && typeof item.content.value === "string" && ids.has(item.content.value)) return true;
    if (contains(item.origin) || contains(item.rightOrigin)) return true;
    let left = item.left, right = item.right;
    while (left && (left.deleted || !left.countable)) left = left.left;
    while (right && (right.deleted || !right.countable)) right = right.right;
    if (!!left && contains(Y.createID(left.id.client, left.id.clock + left.length - 1)) || !!right && contains(right.id)) return true;
    if (item.content instanceof Y.ContentFormat) {
      for (let next = item.right; next; next = next.right) {
        if (next.deleted) continue;
        if (next.content instanceof Y.ContentFormat && next.content.key === item.content.key) break;
        if (next.countable && spans.some(span => span.client === next.id.client && span.clock < next.id.clock + next.length && span.clock + span.length > next.id.clock)) return true;
      }
    }
    return false;
  });
}

export function refreshStrandedMoves(doc: ScreenplayDoc, conflicts: StructuralMoveConflict[], transaction: Y.Transaction): StructuralMoveConflict[] {
  if (!conflicts.length || !touchesNotices(doc, conflicts, transaction)) return conflicts;
  const ranges = locateRanges(doc, conflicts);
  return conflicts.filter(conflict => {
    const range = ranges.get(conflict);
    if (!range || range.paragraphId === conflict.paragraphId) return false;
    conflict.currentParagraphId = range.paragraphId || conflict.currentParagraphId;
    conflict.boundary = range.boundary;
    return true;
  });
}

export function strandedMoveRange(doc: ScreenplayDoc, conflict: StructuralMoveConflict): { start: number; length: number } | undefined {
  const range = locateRanges(doc, [conflict]).get(conflict);
  if (range && range.paragraphId !== conflict.paragraphId) return { start: range.start, length: range.length };
}

export function structuralMoveScene(doc: ScreenplayDoc, conflict: StructuralMoveConflict): { headingId?: string; reason?: string } {
  const scene = doc.scenes().find(scene => scene.sceneId === conflict.sceneId);
  if (scene) return { headingId: scene.headingId };
  if (doc.has(conflict.sceneId) && doc.paragraph(conflict.sceneId).type === "section") return { headingId: conflict.sceneId };
  return { reason: "The source scene or section no longer exists." };
}
