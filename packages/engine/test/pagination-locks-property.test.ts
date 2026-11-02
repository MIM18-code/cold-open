// Locking an unedited pagination must reproduce it exactly: page numbers, every line's place and text, and the
// generated lines ((MORE), CHARACTER (CONT'D), (CONTINUED) and CONTINUED:). Checked on random scripts with long
// speeches, dual dialogue taller than a page and every pagination option that changes where pages break.
import assert from "node:assert/strict";
import { test } from "node:test";

import { locksFromPagination, paginate, type Pagination, type PaginationOptions, type Paragraph, type Script } from "../src/index.ts";

/** A small seeded generator (mulberry32), so a failure can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["the", "door", "opens", "slowly", "and", "Nell", "steps", "into", "a", "cold", "kitchen", "where", "nothing", "moves",
  "rain-soaked", "coat", "window", "light", "Mr.", "O'Hara", "never", "quite", "whispers", "back", "toward", "the", "hall"];

function generator(seed: number) {
  const next = random(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(list: readonly T[]) => list[int(0, list.length - 1)]!;
  const sentence = () => {
    const words = Array.from({ length: int(2, 14) }, () => pick(WORDS));
    words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
    return `${words.join(" ")}${pick([".", ".", ".", "?", "!", "..."])}`;
  };
  const sentences = (count: number) => Array.from({ length: count }, sentence).join(" ");
  return { next, int, pick, sentences };
}

function randomScript(seed: number): Script {
  const { next, int, pick, sentences } = generator(seed);
  const paragraphs: Paragraph[] = [];
  let n = 0;
  const id = () => `p${seed}-${n++}`;
  const add = (paragraph: Omit<Paragraph, "id">) => paragraphs.push({ id: id(), ...paragraph });
  const speech = (dual?: { block: string; side: 1 | 2 }, long = false) => {
    add({ type: "character", runs: [{ text: pick(["NELL", "BOB", "NELL (V.O.)", "MR. O'HARA"]) }], ...(dual ? { dual } : {}) });
    if (next() < 0.3) add({ type: "parenthetical", runs: [{ text: "(quietly)" }], ...(dual ? { dual } : {}) });
    const parts = long ? 1 : int(1, 3);
    for (let k = 0; k < parts; k++) {
      if (k) add({ type: "parenthetical", runs: [{ text: "(beat)" }], ...(dual ? { dual } : {}) });
      add({ type: "dialogue", runs: [{ text: sentences(long ? int(60, 160) : int(1, next() < 0.15 ? 60 : 8)) }], ...(dual ? { dual } : {}) });
    }
  };
  const scenes = int(4, 14);
  for (let s = 0; s < scenes; s++) {
    if (next() < 0.1) add({ type: "section", runs: [{ text: "ACT" }], depth: 1 });
    add({ type: "sceneHeading", runs: [{ text: `INT. ROOM ${s} - ${pick(["DAY", "NIGHT"])}` }], ...(next() < 0.1 ? { startsNewPage: true } : {}) });
    if (next() < 0.2) add({ type: "synopsis", runs: [{ text: "Card text." }] });
    const beats = int(2, 9);
    for (let b = 0; b < beats; b++) {
      const roll = next();
      if (roll < 0.35) {
        const runs = next() < 0.15 ? [{ text: `${sentences(int(1, 6))} ` }, { text: "a note", note: true as const }, { text: ` ${sentences(int(1, 6))}` }]
          : [{ text: sentences(int(1, next() < 0.1 ? 70 : 12)) }];
        add({ type: "action", runs });
      } else if (roll < 0.75) {
        speech();
      } else if (roll < 0.87) {
        const block = id();
        const long = next() < 0.35;
        speech({ block, side: 1 }, long);
        speech({ block, side: 2 }, long && next() < 0.7);
      } else if (roll < 0.94) {
        add({ type: "transition", runs: [{ text: "CUT TO:" }] });
      } else {
        add({ type: "shot", runs: [{ text: "CLOSE ON THE DOOR" }] });
      }
    }
  }
  return { titlePage: [], paragraphs };
}

/** Everything about a pagination a reader could see. */
function printed(pagination: Pagination) {
  return pagination.pages.map((page) => ({
    number: page.number, added: !!page.added, sceneIds: page.sceneIds,
    lines: page.lines.map((line) => [line.paragraphId, line.type, line.from, line.to, line.x, line.y, line.generated ?? "", line.column ?? 0,
      line.runs.map((run) => run.text).join("")]),
  }));
}

const OPTIONS: PaginationOptions[] = [
  {},
  { sceneContinueds: true },
  { dialogueBreaks: false },
  { autoContinueds: false, sceneContinueds: true },
  { breakAtSentences: false },
];

test("locking an unedited pagination reproduces it exactly, on random scripts", () => {
  let pages = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const script = randomScript(seed);
    for (const options of OPTIONS) {
      const free = paginate(script, options);
      const locked = paginate(script, { ...options, locks: locksFromPagination(free) });
      assert.deepEqual(printed(locked), printed(free), `seed ${seed}, options ${JSON.stringify(options)}`);
      assert.deepEqual([...locked.positions], [...free.positions], `seed ${seed}, options ${JSON.stringify(options)}`);
      pages += free.pages.length;
    }
  }
  assert.ok(pages > 1000, `a fair amount of pages (${pages})`);
});

test("relocking an unedited locked pagination keeps it too", () => {
  for (let seed = 100; seed < 115; seed++) {
    const script = randomScript(seed);
    const free = paginate(script, { sceneContinueds: true });
    const once = paginate(script, { sceneContinueds: true, locks: locksFromPagination(free) });
    const twice = paginate(script, { sceneContinueds: true, locks: locksFromPagination(once) });
    assert.deepEqual(printed(twice), printed(free), `seed ${seed}`);
  }
});
