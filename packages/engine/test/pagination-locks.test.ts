// Locked pages and A-pages, A-numbers, and inline notes in pagination.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareNumbers, locksFromPagination, numberBetween, paginate, plainText, type Line, type Page, type Paragraph, type Script,
} from "../src/index.ts";

const sentences = (count: number, word = "Sentence") => Array.from({ length: count }, (_, i) => `${word} ${String(i).padStart(2, "0")} is here.`).join(" ");
const text = (line: Line) => line.runs.map((run) => run.text).join("");
const firstLine = (page: Page) => page.lines.find((line) => !line.generated)!;

function scenes(count: number): Paragraph[] {
  const out: Paragraph[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({ id: `h${i}`, type: "sceneHeading", sceneId: `s${i}`, runs: [{ text: `INT. ROOM ${i} - DAY` }] });
    out.push({ id: `a${i}`, type: "action", runs: [{ text: sentences(8) }] });
    out.push({ id: `c${i}`, type: "character", runs: [{ text: "NELL" }] });
    out.push({ id: `d${i}`, type: "dialogue", runs: [{ text: sentences(6) }] });
  }
  return out;
}
const script = (paragraphs: Paragraph[]): Script => ({ titlePage: [], paragraphs });

test("A-numbers: after, between and before, never reusing a number", () => {
  assert.equal(numberBetween("12", "13"), "12A");
  assert.equal(numberBetween("12A", "13"), "12B");
  assert.equal(numberBetween("12A", "12B"), "12AA");
  assert.equal(numberBetween("12", "12A"), "12AA");
  assert.equal(numberBetween("12Z", "13"), "12ZA");
  assert.equal(numberBetween(undefined, "1"), "A1");
  assert.equal(numberBetween("A1", "1"), "B1");
  assert.equal(numberBetween("12", undefined), "12A");
  assert.equal(numberBetween("12", "13", new Set(["12A"])), "12AA");
  assert.equal(numberBetween(undefined, undefined), "1");
  const sorted = ["13", "12B", "A1", "12", "12AA", "1", "12A", "B1", "2"].sort(compareNumbers);
  assert.deepEqual(sorted, ["A1", "B1", "1", "2", "12", "12A", "12AA", "12B", "13"]);
});

test("locked pages paginate as they did when nothing changed", () => {
  const s = script(scenes(12));
  const free = paginate(s);
  const locked = paginate(s, { locks: locksFromPagination(free) });
  assert.deepEqual(locked.pages.map((page) => page.number), free.pages.map((page) => page.number));
  assert.deepEqual(locked.pages.map((page) => page.lines.map(text)), free.pages.map((page) => page.lines.map(text)));
  assert.deepEqual([...locked.positions], [...free.positions]);
});

test("text that outgrows a locked page runs onto A-pages; later pages keep their breaks", () => {
  const paragraphs = scenes(12);
  const locks = locksFromPagination(paginate(script(paragraphs)));
  const grown = paragraphs.map((p) => (p.id === "a6" ? { ...p, runs: [{ text: `${sentences(80, "Extra")} ${plainText(p.runs)}` }] } : p));
  const result = paginate(script(grown), { locks });
  assert.deepEqual(result.pages.map((page) => page.number), ["1", "2", "2A", "3"]);
  // Every locked page still starts where it was locked.
  for (const lock of locks) {
    const page = result.pages.find((p) => p.number === lock.number)!;
    assert.equal(firstLine(page).paragraphId, lock.paragraphId, `page ${lock.number}`);
    assert.equal(firstLine(page).from, lock.offset, `page ${lock.number}`);
  }
});

test("a locked page whose text is gone gives its number to the page before (2-3)", () => {
  const paragraphs = scenes(20);
  const free = paginate(script(paragraphs));
  const locks = locksFromPagination(free);
  // The fixture's pages start on scene headings, so page 3 holds whole paragraphs; delete them all.
  const gone = new Set(free.pages[2]!.lines.map((line) => line.paragraphId));
  const result = paginate(script(paragraphs.filter((p) => !gone.has(p.id))), { locks });
  assert.deepEqual(result.pages.map((page) => page.number), ["1", "2-3", "4", "5"].slice(0, free.pages.length - 1));
  assert.equal(firstLine(result.pages[2]!).paragraphId, locks[3]!.paragraphId);
  // The first page's number moves forward instead.
  const first = new Set(free.pages[0]!.lines.map((line) => line.paragraphId));
  assert.equal(paginate(script(paragraphs.filter((p) => !first.has(p.id))), { locks }).pages[0]!.number, "1-2");
});

test("a lock whose first paragraph was deleted is found through the paragraphs remembered with it", () => {
  const paragraphs = scenes(12);
  const free = paginate(script(paragraphs));
  const locks = locksFromPagination(free);
  const lock = locks.find((l) => l.offset === 0 && l.paragraphIds?.length)!;
  const result = paginate(script(paragraphs.filter((p) => p.id !== lock.paragraphId)), { locks });
  const page = result.pages.find((p) => p.number === lock.number)!;
  assert.equal(firstLine(page).paragraphId, lock.paragraphIds![0]);
});

test("a speech cut by a locked page keeps (MORE) and CHARACTER (CONT'D)", () => {
  const paragraphs = scenes(6).map((p) => (p.type === "dialogue" ? { ...p, runs: [{ text: sentences(110) }] } : p));
  const free = paginate(script(paragraphs));
  const locks = locksFromPagination(free);
  const cut = free.pages.findIndex((page) => firstLine(page).type === "dialogue" && firstLine(page).from > 0);
  assert.ok(cut > 0, "the fixture breaks a speech inside a dialogue paragraph");
  const same = paginate(script(paragraphs), { locks });
  assert.deepEqual(same.pages.map((page) => page.lines.map((line) => [text(line), line.y, line.from])), free.pages.map((page) => page.lines.map((line) => [text(line), line.y, line.from])));
  // Shorten the speech above the break: the locked break stays inside the speech, with its markers.
  const lock = locks[cut]!;
  const shorter = paragraphs.map((p) => (p.id === "a1" ? { ...p, runs: [{ text: "Short." }] } : p));
  const result = paginate(script(shorter), { locks });
  const page = result.pages.find((p) => p.number === lock.number)!;
  assert.equal(firstLine(page).paragraphId, lock.paragraphId);
  assert.equal(firstLine(page).from, lock.offset);
  assert.deepEqual(page.lines.filter((line) => line.generated === "contd").map(text), ["NELL (CONT'D)"]);
  const before = result.pages[result.pages.indexOf(page) - 1]!;
  assert.equal(text(before.lines.at(-1)!), "(MORE)");
});

test("inline notes print nothing and take no room", () => {
  const result = paginate(script([
    { id: "a", type: "action", runs: [{ text: "One " }, { text: "a long note that would wrap the line", note: true }, { text: " two." }] },
    { id: "b", type: "action", runs: [{ text: "only a note", note: true }] },
    { id: "c", type: "action", runs: [{ text: "Ends with a note " }, { text: "note", note: true }] },
    { id: "d", type: "action", runs: [{ text: "x".repeat(55) + " " }, { text: "n".repeat(30), note: true }, { text: " yyyy" }] },
  ]));
  const lines = result.pages[0]!.lines;
  assert.deepEqual(lines.map((line) => [line.paragraphId, text(line)]), [
    ["a", "One two."], ["c", "Ends with a note"], ["d", `${"x".repeat(55)} yyyy`],
  ]);
  assert.ok(!result.positions.has("b"), "a paragraph of only notes does not print");
  // Offsets still point into the paragraph's own text, past the note.
  const d = lines.find((line) => line.paragraphId === "d")!;
  assert.equal(d.to, 55 + 1 + 30 + 5);
});

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `Sentence ${i + 1} is here.`).join(" ");
const layout = (pagination: ReturnType<typeof paginate>) =>
  pagination.pages.map((page) => [page.number, page.lines.map((line) => [line.paragraphId, line.from, line.to, line.x, line.y, line.generated ?? "", text(line)])]);

test("locking unchanged dual dialogue keeps its pages and rows (Sol round 3, #5)", () => {
  const dual = (side: 1 | 2) => ({ block: "b", side });
  const paragraphs: Paragraph[] = [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "c1", type: "character", runs: [{ text: "NELL" }], dual: dual(1) },
    { id: "d1", type: "dialogue", runs: [{ text: numbered(160) }], dual: dual(1) },
    { id: "c2", type: "character", runs: [{ text: "BOB" }], dual: dual(2) },
    { id: "d2", type: "dialogue", runs: [{ text: numbered(160) }], dual: dual(2) },
  ];
  const free = paginate(script(paragraphs));
  assert.deepEqual(free.pages.map((page) => page.number), ["1", "2", "3"]);
  const locks = locksFromPagination(free);
  assert.ok(locks.slice(1).every((lock) => lock.paragraphId === "d1" && lock.offset > 0), "pages start inside the block");
  const locked = paginate(script(paragraphs), { locks });
  assert.deepEqual(locked.pages.map((page) => page.number), ["1", "2", "3"]);
  assert.deepEqual(layout(locked), layout(free));
  // Text added to the left column above page 2's row runs onto an A-page; pages 2 and 3 still start with their
  // text (the offsets move with it, as the document's anchors move them).
  const added = `${numbered(40)} `;
  const grown = paragraphs.map((p) => (p.id === "d1" ? { ...p, runs: [{ text: added + plainText(p.runs) }] } : p));
  const moved = locks.map((lock, k) => (k ? { ...lock, offset: lock.offset + added.length } : lock));
  const result = paginate(script(grown), { locks: moved });
  assert.deepEqual(result.pages.map((page) => page.number), ["1", "1A", "2", "3"]);
  for (const lock of moved.slice(1)) {
    const page = result.pages.find((p) => p.number === lock.number)!;
    assert.deepEqual([firstLine(page).paragraphId, firstLine(page).from], [lock.paragraphId, lock.offset]);
  }
});

test("locking keeps scene continueds: (CONTINUED) and CONTINUED: (Sol round 3, #9)", () => {
  const paragraphs: Paragraph[] = [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
    ...Array.from({ length: 30 }, (_, i): Paragraph => ({ id: `a${i}`, type: "action", runs: [{ text: sentences(4) }] })),
  ];
  const free = paginate(script(paragraphs), { sceneContinueds: true });
  const generated = (pagination: ReturnType<typeof paginate>) => pagination.pages.map((page) => page.lines.filter((line) => line.generated).map(text));
  assert.deepEqual([generated(free)[0], generated(free)[1]?.[0]], [["(CONTINUED)"], "CONTINUED:"]);
  const locked = paginate(script(paragraphs), { sceneContinueds: true, locks: locksFromPagination(free) });
  assert.deepEqual(generated(locked), generated(free));
  assert.deepEqual(layout(locked), layout(free));
});

test("locking an unchanged dual-dialogue block whose columns differ in spacing keeps its pages (Sol round 4, P2 1)", () => {
  const block = "dual";
  const paragraphs: Paragraph[] = [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "c1", type: "character", runs: [{ text: "LEFT" }], dual: { block, side: 1 } },
    { id: "l1", type: "dialogue", runs: [{ text: "Left sentence. ".repeat(400).trim() }], dual: { block, side: 1 } },
    { id: "c2", type: "character", runs: [{ text: "RIGHT" }], dual: { block, side: 2 } },
    { id: "r1", type: "dialogue", runs: [{ text: "Right sentence. ".repeat(65).trim() }], dual: { block, side: 2 }, fdx: { attrs: [["Spacing", "1.25"]] } },
    { id: "a", type: "action", runs: [{ text: "After." }] },
  ];
  const free = paginate(script(paragraphs));
  const locks = locksFromPagination(free);
  // A page starts in the right column and the next one back in the left: reading order inside the block.
  assert.ok(locks.some((lock, k) => k > 0 && lock.paragraphId === "l1" && locks[k - 1]!.paragraphId === "r1"));
  const locked = paginate(script(paragraphs), { locks });
  assert.deepEqual(locked.pages.map((page) => page.number), free.pages.map((page) => page.number));
  assert.deepEqual(layout(locked), layout(free));
  // A page start that really moved back before the block above it still counts as gone.
  const moved = locks.map((lock, k) => (k === locks.length - 1 ? { ...lock, paragraphId: "h", offset: 0 } : lock));
  assert.equal(paginate(script(paragraphs), { locks: moved }).pages.at(-1)!.number.includes("-"), true);
});
