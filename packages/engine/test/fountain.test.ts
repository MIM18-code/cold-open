import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ScreenplayDoc, type Paragraph, type Run, type Script, fountainRuns, isOmitted, omitScene, parseFdx, parseFountain, plainText, readInline,
  unomitScene, writeFountain, writeInline,
} from "../src/index.ts";

const source = readFileSync(new URL("./fixtures/synthetic.fountain", import.meta.url), "utf8");
const fdxSource = readFileSync(new URL("./fixtures/synthetic.fdx", import.meta.url), "utf8");

/** A script without IDs, for comparing two parses. Dual blocks are compared by position, not ID. */
function shape(script: Script) {
  const blocks = new Map<string, number>();
  return {
    titlePage: script.titlePage,
    paragraphs: script.paragraphs.map(({ id, sceneId, dual, ...rest }: Paragraph) => ({
      ...rest,
      ...(sceneId !== undefined ? { sceneId: sceneId === id } : {}),
      ...(dual ? { dual: { block: blocks.get(dual.block) ?? (blocks.set(dual.block, blocks.size), blocks.size - 1), side: dual.side } } : {}),
    })),
  };
}

test("reads every Fountain element in the fixture", () => {
  const script = parseFountain(source);
  assert.deepEqual(script.titlePage, [
    { key: "Title", values: ["**KEYS**"] },
    { key: "Credit", values: ["Written by"] },
    { key: "Author", values: ["Test Writer"] },
    { key: "Draft date", values: ["29 October 2026"] },
    { key: "Contact", values: ["1 Example Lane", "Nowhere, CA"] },
  ]);
  const rows = script.paragraphs.map((p) => [p.type, plainText(p.runs)]);
  assert.deepEqual(rows, [
    ["section", "Act One"],
    ["synopsis", "Nell wants the forklift to obey."],
    ["sceneHeading", "EXT. SALVAGE YARD - DAWN"],
    ["action", "Rows of crushed sedans. A forklift idles with nobody in it.\nNELL (40s, grease to the elbow) kicks the tire."],
    ["action", "    Indented action keeps its indent."],
    ["character", "NELL"],
    ["parenthetical", "(to the forklift)"],
    ["dialogue", "You and me had a deal. You & me.\n\nSecond paragraph of the speech, held by two spaces."],
    ["character", "McCLANE"],
    ["dialogue", "Lowercase name, forced."],
    ["character", "NELL"],
    ["dialogue", "Start."],
    ["character", "FORKLIFT (V.O.)"],
    ["dialogue", "No."],
    ["action", "SALVAGE RULES APPLY."],
    ["action", "THE END OF THE BEGINNING"],
    ["transition", "SMASH CUT TO:"],
    ["sceneHeading", "FLASHBACK - THE YARD, YEARS AGO"],
    ["note", "Check the year with the art department."],
    ["note", "A cut scene that stays in the file.\n\nTwo paragraphs of it."],
    ["lyrics", "Hang them up, hang them high\nNobody drives tonight"],
    ["transition", "BURN TO WHITE."],
    ["sceneHeading", "INT./EXT. FORKLIFT CAB - LATER"],
    ["action", "Literal *asterisks* and _underscores_ and 5 * 3 * 2."],
  ]);
  const p = script.paragraphs;
  assert.equal(p[0]!.depth, 1);
  assert.equal(p[2]!.sceneNumber, "1");
  assert.equal(p[2]!.sceneId, p[2]!.id);
  assert.deepEqual(p[3]!.runs.find((r) => r.text === "kicks"), { text: "kicks", bold: true, underline: true });
  assert.deepEqual(p[7]!.runs[1], { text: "You", italic: true });
  assert.equal(p[10]!.dual?.side, 1);
  assert.equal(p[12]!.dual?.side, 2);
  assert.equal(p[10]!.dual?.block, p[13]!.dual?.block);
  assert.equal(p[8]!.dual, undefined);
  assert.equal(p[15]!.alignment, "Center");
  assert.equal(p[17]!.startsNewPage, true);
  assert.equal(p[19]!.boneyard, true);
  assert.equal(p[22]!.sceneNumber, "2A");
  assert.equal(p[23]!.runs.length, 1, "escaped and unpaired markers stay literal");
});

test("Fountain round trip: write then read gives the same script, and writing is stable", () => {
  const first = parseFountain(source);
  const written = writeFountain(first);
  assert.deepEqual(shape(parseFountain(written)), shape(first));
  assert.equal(writeFountain(parseFountain(written)), written);
});

test("FDX to Fountain keeps the text and settles after one pass", () => {
  const script = parseFdx(fdxSource);
  const written = writeFountain(script);
  const back = parseFountain(written);
  assert.equal(writeFountain(back), written);
  const words = (s: Script) => s.paragraphs.flatMap((p) => plainText(p.runs).split(/\s+/)).filter(Boolean).join(" ");
  assert.equal(words(back), words(script));
  assert.deepEqual(back.paragraphs.filter((p) => p.dual).map((p) => [p.type, p.dual!.side]),
    [["character", 1], ["dialogue", 1], ["character", 2], ["parenthetical", 2], ["dialogue", 2]]);
  assert.match(written, /^@SALVAGE|^!SALVAGE|^CLOSE ON THE KEY HOOK$/m);
});

test("lines that look like other elements are forced", () => {
  const cases: [Paragraph["type"], string][] = [
    ["action", "INT. NOT A HEADING"], ["action", "SHOUTING"], ["action", "CUT TO:"], ["action", "Title: not a title page"],
    ["action", "= not a synopsis"], ["action", "# not a section"], ["action", "~not a lyric"], ["action", "[[not a note]]"], ["action", "Literal [[brackets]] in text"],
    ["character", "dr. lowercase"], ["character", "INT. GUY"], ["sceneHeading", "THE MOON"], ["transition", "FADE OUT."],
    ["action", "===="], ["action", ">sideways<"], ["action", "NELL\nsays nothing"], ["action", "===\nHello."],
  ];
  for (const [type, text] of cases) {
    const script: Script = { titlePage: [], paragraphs: [{ id: "a", type, runs: [{ text }] }] };
    if (type === "character") script.paragraphs.push({ id: "b", type: "dialogue", runs: [{ text: "Hi." }] });
    const back = parseFountain(writeFountain(script));
    assert.equal(back.paragraphs[0]?.type, type, `${type}: ${text}`);
    assert.equal(plainText(back.paragraphs[0]!.runs), text, `${type}: ${text}`);
  }
});

test("emphasis reads back exactly, for random formatting", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const alphabet = ["a", "b", " ", "*", "_", "\\", "x y", "\n"];
  for (let round = 0; round < 3000; round++) {
    const runs: Run[] = [];
    for (let k = 0, n = 1 + Math.floor(random() * 6); k < n; k++) {
      const run: Run = { text: Array.from({ length: 1 + Math.floor(random() * 3) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("") };
      if (random() < 0.4) run.bold = true;
      if (random() < 0.4) run.italic = true;
      if (random() < 0.3) run.underline = true;
      runs.push(run);
    }
    const written = writeInline(runs);
    assert.deepEqual(readInline(written), fountainRuns(runs), JSON.stringify({ runs, written }));
  }
});

test("emphasis edge cases from hand-written Fountain", () => {
  assert.deepEqual(readInline("***both*** then **bold** and *it*"), [
    { text: "both", bold: true, italic: true }, { text: " then " }, { text: "bold", bold: true }, { text: " and " }, { text: "it", italic: true },
  ]);
  assert.deepEqual(readInline("_under **and bold**_"), [{ text: "under ", underline: true }, { text: "and bold", underline: true, bold: true }]);
  assert.deepEqual(readInline("not * emphasis * here"), [{ text: "not * emphasis * here" }]);
  assert.deepEqual(readInline("*across\nlines*"), [{ text: "*across\nlines*" }]);
});

test("inline notes stay with their paragraph and never print", async () => {
  const { writeFdx } = await import("../src/index.ts");
  const script = parseFountain("BOB\nHello [[check this line]] there.\n");
  const runs = script.paragraphs[1]!.runs;
  assert.deepEqual(runs, [{ text: "Hello " }, { text: "check this line", note: true }, { text: " there." }]);
  assert.match(writeFountain(script), /Hello \[\[check this line\]\] there\./);
  assert.deepEqual(readInline("**Hello [[check]] there.**"), [
    { text: "Hello ", bold: true }, { text: "check", note: true }, { text: " there.", bold: true },
  ]);
  const warnings: string[] = [];
  const xml = writeFdx(script, { warnings });
  assert.doesNotMatch(xml, /check this line/);
  assert.equal(warnings.length, 1);
});

test("an omitted scene's text survives a Fountain save, and Restore Omitted Scene brings it back (final review #3)", () => {
  const source = "Title: T\n\nINT. A - DAY\n\nAction one.\n\nEXT. B - NIGHT #2#\n\nSecret middle scene text.\n\nBOB\nHello there.\n\n"
    + "/*\nAn old boneyard with a */ in it? No: closed here.\n*/\n\nNEL\nA path: C:\\scripts\\*/x\n\nINT. C - DAY\n\nEnd.\n";
  const doc = ScreenplayDoc.fromScript(parseFountain(source));
  const middle = doc.paragraphs().find((p) => plainText(p.runs) === "EXT. B - NIGHT")!;
  const before = doc.paragraphs().map((p) => [p.type, plainText(p.runs)]);
  omitScene(doc, middle.sceneId!);
  const written = writeFountain(doc.toScript());
  assert.match(written, /\.OMITTED #2#\n\n\/\*\nOMITTED SCENE\nEXT\. B - NIGHT #2#\n\nSecret middle scene text\./);

  const reopened = ScreenplayDoc.fromScript(parseFountain(written));
  const placeholder = reopened.paragraphs().find((p) => isOmitted(p))!;
  assert.equal(plainText(placeholder.runs), "OMITTED");
  assert.equal(placeholder.sceneNumber, "2");
  // Saving again writes the same file.
  assert.equal(writeFountain(reopened.toScript()), written);
  assert.equal(unomitScene(reopened, placeholder.id), true);
  assert.deepEqual(reopened.paragraphs().map((p) => [p.type, plainText(p.runs)]), before);

  // A boneyard after a heading that does not start with the marker stays a boneyard note.
  const note = parseFountain("INT. A - DAY\n\n/*\nOMITTED SCENES list\n*/\n");
  assert.deepEqual(note.paragraphs.map((p) => p.type), ["sceneHeading", "note"]);
});
