import * as Y from "yjs";
import type { ScreenplayDoc } from "./doc.ts";

export const MOVE_KNOWLEDGE_PREFIX = "move.";
// Keep at most eight operation-scoped records per client, newest last.
export const MOVE_KNOWLEDGE_LIMIT = 8;
export type MoveSpan = [client: number, clock: number, length: number];
// chars preserves the countable subset after GC merges text and formatting tombstones.
export interface MoveKnowledge { sv: string; at: number; spans: MoveSpan[]; chars: MoveSpan[]; }

function compact(spans: MoveSpan[]): MoveSpan[] {
  spans.sort(([a, x], [b, y]) => a - b || x - y);
  const result: MoveSpan[] = [];
  for (const [client, clock, length] of spans) {
    const last = result.at(-1);
    if (last && last[0] === client && last[1] + last[2] >= clock) last[2] = Math.max(last[1] + last[2], clock + length) - last[1];
    else result.push([client, clock, length]);
  }
  return result;
}

export function moveDeletions(doc: ScreenplayDoc, transaction: Y.Transaction, before: ReturnType<typeof Y.createDeleteSet>): Pick<MoveKnowledge, "spans" | "chars"> {
  const spans: MoveSpan[] = [], chars: MoveSpan[] = [];
  for (const [client, ranges] of transaction.deleteSet.clients) {
    const structs = doc.ydoc.store.clients.get(client)!;
    for (const range of ranges) {
      let intervals: [number, number][] = [[range.clock, range.clock + range.len]];
      for (const old of before.clients.get(client) ?? []) intervals = intervals.flatMap(([from, to]) => {
        if (old.clock >= to || old.clock + old.len <= from) return [[from, to]];
        return [...(from < old.clock ? [[from, old.clock] as [number, number]] : []), ...(to > old.clock + old.len ? [[old.clock + old.len, to] as [number, number]] : [])];
      });
      for (const [from, to] of intervals) for (let i = Y.findIndexSS(structs, from); i < structs.length && structs[i]!.id.clock < to; i++) {
        const item = structs[i]!;
        if (!(item instanceof Y.Item) || item.parent !== doc.body) continue;
        const start = Math.max(from, item.id.clock), end = Math.min(to, item.id.clock + item.length);
        spans.push([client, start, end - start]);
        if (item.content instanceof Y.ContentString) chars.push([client, start, end - start]);
      }
    }
  }
  return { spans: compact(spans), chars: compact(chars) };
}
