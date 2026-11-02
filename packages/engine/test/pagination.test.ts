import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PAGE, fdxPaginationOptions, formatEighths, linesPerPage, pageCount, pageOf, paginate, parseFdx, sceneEighths,
  scriptPaginationOptions, wrap, type ElementType, type Line, type Page, type Paragraph, type Script,
} from "../src/index.ts";

// Synthetic scripts: every paragraph gets a readable ID from its position so tests can point at it.
type Spec = [ElementType, string, Partial<Paragraph>?];
function script(...specs: Spec[]): Script {
  return {
    titlePage: [],
    paragraphs: specs.map(([type, text, extra], index) => ({
      id: `p${index}`, type, runs: [{ text }], ...(type === "sceneHeading" ? { sceneId: `s${index}` } : {}), ...extra,
    })),
  };
}

const text = (line: Line) => line.runs.map((run) => run.text).join("");
const body = (page: Page) => page.lines.filter((line) => !line.generated);
const CAPACITY = linesPerPage(PAGE);
/** A one-line action paragraph. */
const short = (n: number): Spec => ["action", `Short action ${n}.`];
/** Action that fills the first page down to line `last` (one-line paragraphs, one blank line between). */
function fillTo(last: number): Spec[] {
  assert.equal(last % 2, 0);
  return Array.from({ length: last / 2 + 1 }, (_, i) => short(i));
}
/** Sentences of dialogue or action, each "Sentence n is here." (20 characters). */
const sentences = (count: number) => Array.from({ length: count }, (_, i) => `Sentence ${String(i).padStart(2, "0")} is here.`).join(" ");

test("wraps at spaces and after hyphens, breaks long words, keeps hard line breaks", () => {
  assert.deepEqual(wrap("one two three", 7), [[0, 7], [8, 13]]);
  assert.deepEqual(wrap("well-known", 7), [[0, 5], [5, 10]]);
  assert.deepEqual(wrap("abcdefghij", 4), [[0, 4], [4, 8], [8, 10]]);
  assert.deepEqual(wrap("one\ntwo", 20), [[0, 3], [4, 7]]);
  assert.deepEqual(wrap("", 10), [[0, 0]]);
});

test("line widths follow Final Draft 13: 61 characters of action, 35 of dialogue, 26 then 25 of parenthetical", () => {
  const action = "x".repeat(61) + " y";
  const dialogue = "x".repeat(35) + " y";
  const paren = "(" + "x".repeat(24) + " " + "x".repeat(25) + " y)";
  const result = paginate(script(["action", action], ["character", "BOB"], ["parenthetical", paren], ["dialogue", dialogue]));
  const lines = result.pages[0]!.lines;
  assert.deepEqual(lines.filter((l) => l.type === "action").map((l) => text(l).length), [61, 1]);
  assert.deepEqual(lines.filter((l) => l.type === "dialogue").map((l) => text(l).length), [35, 1]);
  assert.deepEqual(lines.filter((l) => l.type === "parenthetical").map((l) => text(l).length), [25, 25, 2]);
  const parenLines = lines.filter((l) => l.type === "parenthetical");
  assert.ok(Math.abs(parenLines[0]!.x - 2.9) < 1e-9, "the parenthetical's first line hangs 0.1 inch left");
  assert.equal(parenLines[1]!.x, 3.0);
});

test("a page holds 54 lines; space before is dropped at the top of a page", () => {
  assert.equal(CAPACITY, 54);
  const result = paginate(script(...fillTo(52), short(99), ["sceneHeading", "INT. ROOM - DAY"], short(100)));
  assert.equal(result.pages.length, 2);
  // Line 53 is free but the next action needs a blank line first, so it starts page 2 at the very top.
  assert.equal(body(result.pages[1]!)[0]!.y, 0);
  assert.equal(body(result.pages[1]!)[0]!.paragraphId, "p27");
});

test("a scene heading is never the last thing on a page", () => {
  // The heading would land on line 52 with its action on 54, past the foot: both move.
  const specs = [...fillTo(48), ["sceneHeading", "INT. HOUSE - NIGHT"] as Spec, ["action", "Two lines of action here, long enough to wrap onto a second line of the page."] as Spec];
  const result = paginate(script(...specs));
  const heading = specs.findIndex(([type]) => type === "sceneHeading");
  assert.equal(pageOf(result, `p${heading}`), 1);
  assert.equal(body(result.pages[1]!)[0]!.type, "sceneHeading");
  assert.deepEqual(result.pages[1]!.sceneIds, [`s${heading}`]);
  assert.deepEqual(result.pages[0]!.sceneIds, []);
});

test("a run of scene headings may break between headings", () => {
  const specs: Spec[] = [...fillTo(46), ["sceneHeading", "EXT. A"], ["sceneHeading", "EXT. B"], ["sceneHeading", "EXT. C"], short(1)];
  const result = paginate(script(...specs));
  // A and B fit at lines 49 and 52; C keeps with its action on page 2.
  assert.deepEqual(body(result.pages[0]!).slice(-2).map(text), ["EXT. A", "EXT. B"]);
  assert.deepEqual(body(result.pages[1]!).slice(0, 2).map(text), ["EXT. C", "Short action 1."]);
});

test("a character cue and its parenthetical stay with dialogue", () => {
  const specs: Spec[] = [...fillTo(48), ["character", "BOB"], ["parenthetical", "(quietly)"], ["dialogue", "Just one line."]];
  const result = paginate(script(...specs));
  // Cue on 50, parenthetical 51, dialogue 52 would fit; with one more action line it no longer does.
  assert.equal(result.pages.length, 1);
  const tighter = paginate(script(...fillTo(50), ["character", "BOB"], ["parenthetical", "(quietly)"], ["dialogue", "Just one line."]));
  assert.equal(tighter.pages.length, 2);
  assert.deepEqual(body(tighter.pages[1]!).map((line) => line.type), ["character", "parenthetical", "dialogue"]);
  assert.ok(!tighter.pages[0]!.lines.some((line) => line.generated), "no (MORE) for a speech that moved whole");
});

test("dialogue breaks at a sentence end with (MORE) below and CHARACTER (CONT'D) above", () => {
  const specs: Spec[] = [...fillTo(44), ["character", "Bob"], ["dialogue", sentences(12)]];
  const result = paginate(script(...specs));
  assert.equal(result.pages.length, 2);
  const first = result.pages[0]!.lines, second = result.pages[1]!.lines;
  const more = first.at(-1)!;
  assert.equal(more.generated, "more");
  assert.equal(text(more), "(MORE)");
  assert.equal(more.x, 3.5);
  const lastDialogue = first.filter((line) => line.type === "dialogue").at(-1)!;
  assert.match(text(lastDialogue), /here\.$/, "the first part ends at a sentence end");
  assert.ok(first.filter((line) => line.type === "dialogue").length >= 2);
  const contd = second[0]!;
  assert.equal(contd.generated, "contd");
  assert.equal(text(contd), "BOB (CONT'D)");
  assert.equal(contd.y, -1, "printed on the line above the top margin");
  assert.equal(body(result.pages[1]!)[0]!.y, 0);
  assert.match(text(body(result.pages[1]!)[0]!), /^Sentence/);
  assert.ok(body(result.pages[1]!).length >= 2);
  // The text is all there exactly once.
  const printed = [...first, ...second].filter((line) => line.type === "dialogue").map(text).join(" ");
  assert.equal(printed, sentences(12));
});

test("(MORE) may sit on the line below the bottom margin", () => {
  const result = paginate(script(...fillTo(44), ["character", "BOB"], ["dialogue", sentences(30)]));
  const more = result.pages[0]!.lines.find((line) => line.generated === "more")!;
  assert.equal(more.y, CAPACITY);
  assert.equal(body(result.pages[0]!).at(-1)!.y, CAPACITY - 1);
});

test("dialogue without a sentence end moves whole; custom (MORE) and (CONT'D) text", () => {
  const words = Array.from({ length: 60 }, () => "word").join(" ");
  const result = paginate(script(...fillTo(44), ["character", "BOB"], ["dialogue", words]), { more: "(more)", contd: "(cont)" });
  assert.equal(pageOf(result, "p23"), 1);
  assert.ok(!result.pages[0]!.lines.some((line) => line.generated));
  const split = paginate(script(...fillTo(44), ["character", "BOB"], ["dialogue", sentences(12)]), { more: "(more)", contd: "(cont)" });
  assert.equal(text(split.pages[0]!.lines.at(-1)!), "(more)");
  assert.equal(text(split.pages[1]!.lines[0]!), "BOB (CONT)");
  const plain = paginate(script(...fillTo(44), ["character", "BOB"], ["dialogue", sentences(12)]), { dialogueBreaks: false });
  assert.ok(!plain.pages.some((page) => page.lines.some((line) => line.generated)));
});

test("a speech may break between its paragraphs, even after a parenthetical once dialogue has printed", () => {
  const words = Array.from({ length: 16 }, () => "word").join(" ");
  const speech: Spec[] = [["character", "ANN"], ["dialogue", sentences(2)], ["parenthetical", "(beat)"], ["dialogue", words]];
  const result = paginate(script(...fillTo(46), ...speech));
  assert.equal(result.pages[0]!.lines.at(-1)!.generated, "more");
  assert.deepEqual(body(result.pages[0]!).slice(-4).map((line) => line.type), ["character", "dialogue", "dialogue", "parenthetical"]);
  assert.equal(body(result.pages[1]!)[0]!.type, "dialogue");
  assert.equal(result.pages[1]!.lines[0]!.generated, "contd");
  // With only the cue and a parenthetical room left, the speech moves whole: they never end a page alone.
  const moved = paginate(script(...fillTo(50), ["character", "ANN"], ["parenthetical", "(beat)"], ["dialogue", words]));
  assert.equal(body(moved.pages[1]!)[0]!.type, "character");
});

test("action breaks at a sentence end keeping two lines each side; shorter action moves whole", () => {
  const long = sentences(15); // five lines of action
  const result = paginate(script(...fillTo(48), ["action", long]));
  const head = body(result.pages[0]!).filter((line) => line.paragraphId === "p25");
  const tail = body(result.pages[1]!).filter((line) => line.paragraphId === "p25");
  assert.ok(head.length >= 2 && tail.length >= 2);
  assert.match(text(head.at(-1)!), /here\.$/);
  assert.equal(tail[0]!.from, head.at(-1)!.to + 1, "the second part starts with the next sentence");
  assert.ok(!result.pages.some((page) => page.lines.some((line) => line.generated)), "no (MORE) for action");

  // A three-line paragraph never breaks (two lines on each side would need four).
  const three = sentences(8);
  const moved = paginate(script(...fillTo(50), ["action", three]));
  assert.equal(pageOf(moved, "p26"), 1);
  assert.equal(body(moved.pages[1]!).filter((line) => line.paragraphId === "p26").length, 3);
  assert.equal(body(moved.pages[0]!).at(-1)!.y, 50);
});

test("a transition stays with the line before it", () => {
  const specs: Spec[] = [...fillTo(50), short(1), ["transition", "CUT TO:"]];
  const result = paginate(script(...specs));
  // The action fits on line 52 but the transition would need 54-55, so both start page 2.
  assert.deepEqual(body(result.pages[1]!).map(text), ["Short action 1.", "CUT TO:"]);
  const cut = body(result.pages[1]!)[1]!;
  assert.ok(Math.abs(cut.x + "CUT TO:".length / PAGE.charsPerInch - 7.1) < 1e-9, "right-aligned to the transition's right indent");
});

test("forced page breaks, non-printing elements and page numbers", () => {
  const result = paginate(script(
    ["sceneHeading", "INT. ONE"], ["note", "a note"], ["section", "ACT ONE"], ["action", "Before."],
    ["action", "After.", { startsNewPage: true }], ["synopsis", "summary"],
  ));
  assert.equal(pageCount(result), 2);
  assert.deepEqual(result.pages.map((page) => page.number), ["1", "2"]);
  assert.deepEqual(result.pages.flatMap((page) => page.lines).map(text), ["INT. ONE", "Before.", "After."]);
  assert.equal(result.pages[1]!.lines[0]!.y, 0);
  assert.equal(pageOf(result, "p1"), -1);
  assert.deepEqual(result.positions.get("p4"), { page: 1, line: 0 });
});

test("dual dialogue prints in two columns as tall as the longer side", () => {
  const dual = (side: 1 | 2) => ({ dual: { block: "d1", side } });
  const result = paginate(script(
    ["character", "ANN", dual(1)], ["dialogue", sentences(4), dual(1)],
    ["character", "BOB", dual(2)], ["dialogue", "Short.", dual(2)],
    ["action", "Next."],
  ));
  const lines = result.pages[0]!.lines;
  const left = lines.filter((line) => line.column === 1), right = lines.filter((line) => line.column === 2);
  assert.equal(left[0]!.y, right[0]!.y, "both cues on the same line");
  assert.ok(left.every((line) => line.x < 4.5) && right.every((line) => line.x >= 4.5));
  const next = lines.find((line) => line.paragraphId === "p4")!;
  assert.equal(next.y, left.at(-1)!.y + 2);
});

test("dual dialogue taller than a page carries both columns on to the next page", () => {
  const dual = (side: 1 | 2) => ({ dual: { block: "d1", side } });
  const result = paginate(script(
    ["character", "ANN", dual(1)], ["dialogue", sentences(150), dual(1)],
    ["character", "BOB", dual(2)], ["dialogue", sentences(120), dual(2)],
  ));
  assert.ok(result.pages.length >= 2);
  for (const page of result.pages) {
    for (const line of page.lines) assert.ok(line.y >= 0 && line.y < CAPACITY, `line at ${line.y} is on the page`);
  }
  const second = result.pages[1]!.lines;
  const left = second.filter((line) => line.column === 1), right = second.filter((line) => line.column === 2);
  assert.ok(left.length && right.length, "both columns continue");
  assert.equal(left[0]!.y, 0);
  assert.equal(right[0]!.y, 0);
});

test("automatic (CONT'D) when a character speaks again after only action in a scene", () => {
  const specs: Spec[] = [
    ["sceneHeading", "INT. A"], ["character", "Bob"], ["dialogue", "One."], ["action", "He waits."],
    ["character", "BOB (V.O.)"], ["dialogue", "Two."], ["character", "ANN"], ["dialogue", "Three."],
    ["character", "BOB"], ["dialogue", "Four."], ["action", "Beat."], ["character", "BOB (CONT'D)"], ["dialogue", "Five."],
    ["sceneHeading", "INT. B"], ["character", "BOB"], ["dialogue", "Six."],
  ];
  const cues = (options = {}) => paginate(script(...specs), options).pages[0]!.lines.filter((line) => line.type === "character").map(text);
  assert.deepEqual(cues(), ["BOB", "BOB (V.O.) (CONT'D)", "ANN", "BOB", "BOB (CONT'D)", "BOB"]);
  assert.deepEqual(cues({ autoContinueds: false }), ["BOB", "BOB (V.O.)", "ANN", "BOB", "BOB (CONT'D)", "BOB"]);
  const line = paginate(script(...specs)).pages[0]!.lines.find((l) => l.paragraphId === "p4")!;
  assert.equal(line.suffix, " (CONT'D)");
  assert.deepEqual([line.from, line.to], [0, 10], "the range still covers only the script's own text");
});

test("inline notes do not print and offsets point into the paragraph's own text", () => {
  const result = paginate({
    titlePage: [], paragraphs: [{ id: "a", type: "action", runs: [{ text: "Hello " }, { text: "secret", note: true }, { text: "world." }] }],
  });
  const [line] = result.pages[0]!.lines;
  assert.equal(text(line!), "Hello world.");
  assert.deepEqual([line!.from, line!.to], [0, 18]);
});

test("scene continueds print (CONTINUED) and CONTINUED: when a scene runs over", () => {
  const result = paginate(script(["sceneHeading", "INT. LONG"], ...fillTo(60).map((spec) => spec)), { sceneContinueds: true });
  assert.equal(result.pages.length, 2);
  assert.equal(text(result.pages[0]!.lines.at(-1)!), "(CONTINUED)");
  assert.equal(text(result.pages[1]!.lines[0]!), "CONTINUED:");
  assert.equal(body(result.pages[1]!)[0]!.y, 2);
});

test("scene eighths and their display", () => {
  const s = script(["sceneHeading", "INT. A"], ...fillTo(52), ["sceneHeading", "INT. B"], short(1));
  const result = paginate(s);
  const eighths = sceneEighths(s, result);
  assert.equal(eighths.get("s0"), 8);
  assert.equal(eighths.get(`s${s.paragraphs.length - 2}`), 1);
  assert.equal(formatEighths(11), "1 3/8");
  assert.equal(formatEighths(3), "3/8");
  assert.equal(formatEighths(16), "2");
});

const FDX = `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Template="No" Version="6">
<Content>
<Paragraph Type="Scene Heading"><Text>INT. ROOM - DAY</Text></Paragraph>
<Paragraph Type="Action"><Text>Something happens.</Text></Paragraph>
<Paragraph Type="Dialogue" LeftIndent="2.00" RightIndent="4.00"><Text>Narrow.</Text></Paragraph>
</Content>
<ElementSettings Type="Scene Heading"><FontSpec Style="Bold+AllCaps"/><ParagraphSpec Alignment="Left" FirstIndent="0.00" LeftIndent="1.25" RightIndent="7.25" SpaceBefore="36" Spacing="1"/><Behavior PaginateAs="Scene Heading"/></ElementSettings>
<ElementSettings Type="Shot"><FontSpec Style="AllCaps"/><ParagraphSpec Alignment="Left" LeftIndent="1.50" RightIndent="7.50" SpaceBefore="12" Spacing="1"/><Behavior PaginateAs="Action"/></ElementSettings>
<PageLayout BottomMargin="36" BreakDialogueAndActionAtSentences="No" TopMargin="72" HeaderMargin="30"/>
<MoresAndContinueds><DialogueBreaks AutomaticCharacterContinueds="No" BottomOfPage="Yes" DialogueBottom="(more)" DialogueTop="(cont'd)" TopOfNext="Yes"/><SceneBreaks SceneBottomOfPage="Yes" SceneTopOfNext="Yes" SceneBottom="(CONT.)" SceneTop="CONT:"/></MoresAndContinueds>
</FinalDraft>`;

test("reads the layout an FDX file carries", () => {
  const parsed = parseFdx(FDX);
  const options = fdxPaginationOptions(parsed);
  assert.deepEqual(options.elements?.sceneHeading, { left: 1.25, right: 7.25, firstIndent: 0, spaceBefore: 3, spacing: 1, align: "left", caps: true, bold: true, italic: false, underline: false });
  assert.equal(options.paginateAs?.shot, "action");
  assert.equal(options.page?.bottom, 0.5);
  assert.equal(options.page?.header, 30 / 72);
  assert.equal(options.breakAtSentences, false);
  assert.equal(options.autoContinueds, false);
  assert.equal(options.more, "(more)");
  assert.equal(options.contd, "(cont'd)");
  assert.equal(options.sceneContinueds, true);
  assert.equal(options.sceneBottom, "(CONT.)");
  assert.deepEqual(fdxPaginationOptions(script(["action", "x"])), {});

  const result = paginate(parsed, scriptPaginationOptions(parsed));
  const [heading, action, dialogue] = result.pages[0]!.lines;
  assert.equal(heading!.x, 1.25);
  assert.equal(action!.y, 2);
  assert.equal(dialogue!.x, 2.0, "a paragraph's own indents win");
  assert.equal(linesPerPage(result.layout.page), 57);
  // Caller settings go on top of the file's own.
  assert.equal(scriptPaginationOptions(parsed, { autoContinueds: true }).autoContinueds, true);
  assert.equal(scriptPaginationOptions(parsed, { elements: { action: { left: 2 } } }).elements?.sceneHeading?.left, 1.25);
});
