// Positions in the text as the editor last drew it, carried onto today's text after co-writers changed it: what
// an input method's composition needs when it commits after a co-writer's edit. Pure functions of the Y.Text.
import * as Y from "yjs";

/**
 * A relative position for a body offset counted in the text as it was at a snapshot: the character that was there,
 * which Yjs then finds in today's text (or where it was, if it is gone). The end of the text is the end of the body.
 */
export function relativeAt(body: Y.Text, state: Y.Snapshot, index: number): Y.RelativePosition {
  const at = (client: number, clock: number) => Y.createRelativePositionFromJSON({ type: null, tname: "body", item: { client, clock }, assoc: 0 });
  let count = 0;
  for (let item = body._start; item; item = item.right) {
    if (!item.countable) continue;
    const { client, clock } = item.id;
    // Characters added after the snapshot were not in the text; deleted ones were, if deleted since.
    const existed = Math.min(item.length, Math.max(0, (state.sv.get(client) ?? 0) - clock));
    if (!item.deleted) {
      if (index < count + existed) return at(client, clock + index - count);
      count += existed;
      continue;
    }
    for (let k = 0; k < existed; k++) {
      if (Y.isDeleted(state.ds, Y.createID(client, clock + k))) continue;
      if (count === index) return at(client, clock + k);
      count++;
    }
  }
  return Y.createRelativePositionFromJSON({ type: null, tname: "body", item: null, assoc: 0 });
}

/** The Yjs IDs of the characters between two body offsets counted in the text as it was at a snapshot, by client. */
export function charactersAt(body: Y.Text, state: Y.Snapshot, from: number, to: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const add = (client: number, clock: number) => {
    const clocks = out.get(client);
    if (clocks) clocks.push(clock);
    else out.set(client, [clock]);
  };
  let count = 0;
  for (let item = body._start; item && count < to; item = item.right) {
    if (!item.countable) continue;
    const { client, clock } = item.id;
    const existed = Math.min(item.length, Math.max(0, (state.sv.get(client) ?? 0) - clock));
    if (!item.deleted && count + existed <= from) {
      count += existed;
      continue;
    }
    for (let k = 0; k < existed && count < to; k++) {
      if (item.deleted && Y.isDeleted(state.ds, Y.createID(client, clock + k))) continue;
      if (count >= from) add(client, clock + k);
      count++;
    }
  }
  for (const clocks of out.values()) clocks.sort((a, b) => a - b);
  return out;
}

/** Where those characters are in today's text, as half-open body ranges in order. Characters deleted since are left out. */
export function liveRanges(body: Y.Text, characters: Map<number, number[]>): [number, number][] {
  const ranges: [number, number][] = [];
  let index = 0;
  for (let item = body._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const clocks = characters.get(item.id.client);
    if (clocks) {
      const first = item.id.clock, last = first + item.length;
      // The first wanted clock in this item, by binary search.
      let low = 0, high = clocks.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (clocks[mid]! < first) low = mid + 1;
        else high = mid;
      }
      for (let k = low; k < clocks.length && clocks[k]! < last; k++) {
        const at = index + clocks[k]! - first;
        const previous = ranges.at(-1);
        if (previous && previous[1] === at) previous[1] = at + 1;
        else ranges.push([at, at + 1]);
      }
    }
    index += item.length;
  }
  return ranges;
}
