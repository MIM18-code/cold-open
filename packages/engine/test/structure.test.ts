import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Y from "yjs";

import {
  newId, ScreenplayDoc, SCENE_COLORS, addSection, moveScene, moveScenes, moveSection, numberScenes, outlineOf, parseFdx,
  parseFountain, parseSceneHeading, plainText, removeSceneNumbers, removeSection, sceneBlocks, sceneColor, sceneSummaries,
  sceneEndAnchor, sceneSynopsis, sectionEndAnchor, setSectionSynopsis, sectionStartAnchor, setSceneColor, setSceneSynopsis, setSectionTitle, writeFdx,
  compareSceneNumbers, lockedSceneNumbers, sceneNumberBetween, sceneNumbersLocked, setSceneNumbersLocked,
  type Paragraph, type Run,
} from "../src/index.ts";

const SCRIPT = `# ACT ONE

= Nell loses the keys.

INT. OFFICE - DAY

= Nell waits.

Nell waits by the phone.

NELL
Well?

BOB (V.O.)
Hold on.

EXT. YARD - NIGHT

Rain on the sedans.

## SEQUENCE B

INT. GARAGE - DAWN

A forklift idles.

# ACT TWO

= The bargain.

INT. DINER - DAY

Coffee.

NELL (CONT'D)
Two.

EXT. ROAD - CONTINUOUS

Dust.
`;

const make = () => ScreenplayDoc.fromScript(parseFountain(SCRIPT));
const headings = (doc: ScreenplayDoc) => doc.scenes().map((scene) => scene.heading);
const outline = (doc: ScreenplayDoc) => doc.toScript().paragraphs.map((p) => `${p.type}:${plainText(p.runs)}`);
const sceneId = (doc: ScreenplayDoc, heading: string) => doc.scenes().find((scene) => scene.heading === heading)!.sceneId;

function pair() {
  const a = make();
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const sync = () => {
    a.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
    b.applyUpdate(Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
  };
  return { a, b, sync };
}

test("a scene ends at the next heading or section, so act titles stay put", () => {
  const { paragraphs } = make().toScript();
  const blocks = sceneBlocks(paragraphs);
  assert.equal(blocks.length, 5);
  const garage = blocks[2]!;
  assert.equal(paragraphs[garage.end]!.type, "section");
  assert.equal(plainText(paragraphs[garage.end]!.runs), "ACT TWO");
});

test("moveScene keeps every paragraph ID, scene ID and attribute", () => {
  const doc = make();
  const before = doc.toScript();
  const yard = sceneId(doc, "EXT. YARD - NIGHT");
  assert.equal(moveScene(doc, yard, sceneId(doc, "INT. OFFICE - DAY")), true);
  assert.deepEqual(headings(doc).slice(0, 2), ["EXT. YARD - NIGHT", "INT. OFFICE - DAY"]);
  const after = doc.toScript();
  assert.deepEqual([...after.paragraphs.map((p) => p.id)].sort(), [...before.paragraphs.map((p) => p.id)].sort());
  const byId = (paragraphs: Paragraph[]) => new Map(paragraphs.map((p) => [p.id, p]));
  const oldById = byId(before.paragraphs);
  for (const paragraph of after.paragraphs) assert.deepEqual(paragraph, oldById.get(paragraph.id));
  assert.equal(doc.scenes()[0]!.sceneId, yard);
  assert.deepEqual(doc.validate(), []);
});

test("moveScene to the end, before a section, and as a no-op", () => {
  const doc = make();
  const office = sceneId(doc, "INT. OFFICE - DAY");
  assert.equal(moveScene(doc, office, null), true);
  assert.equal(headings(doc).at(-1), "INT. OFFICE - DAY");
  assert.equal(plainText(doc.toScript().paragraphs.at(-1)!.runs), "Hold on.");

  const fresh = make();
  const sections = fresh.toScript().paragraphs.filter((p) => p.type === "section");
  const actTwo = sections.find((p) => plainText(p.runs) === "ACT TWO")!;
  // Landing before the section puts the scene at the end of Act One's last sequence.
  assert.equal(moveScene(fresh, sceneId(fresh, "INT. DINER - DAY"), actTwo.id), true);
  const rows = outline(fresh);
  assert.ok(rows.indexOf("sceneHeading:INT. DINER - DAY") < rows.indexOf("section:ACT TWO"));

  const same = make();
  const yard = sceneId(same, "EXT. YARD - NIGHT");
  assert.equal(moveScene(same, yard, yard), false);
  // Before the next section is where it already is; before the scene after that section is a real move.
  assert.equal(moveScene(same, yard, same.toScript().paragraphs.find((p) => plainText(p.runs) === "SEQUENCE B")!.id), false);
  assert.equal(moveScene(same, yard, same.toScript().paragraphs.find((p) => plainText(p.runs) === "Rain on the sedans.")!.id), false);
  assert.throws(() => moveScene(same, "nope", null), RangeError);
  assert.throws(() => moveScene(same, yard, "nope"), RangeError);
});

test("moving the last scene before the first, and the first to the end, round-trip the text", () => {
  const doc = make();
  const original = outline(doc);
  const first = doc.scenes()[0]!.sceneId, last = doc.scenes().at(-1)!.sceneId;
  moveScene(doc, last, first);
  assert.equal(doc.scenes()[0]!.sceneId, last);
  moveScene(doc, last, sceneId(doc, "EXT. YARD - NIGHT"));
  moveScene(doc, last, null);
  assert.deepEqual(outline(doc), original);
});

test("moving a run of scenes keeps script order and moves them together", () => {
  const doc = make();
  const ids = ["INT. OFFICE - DAY", "INT. GARAGE - DAWN"].map((heading) => sceneId(doc, heading));
  assert.equal(moveScenes(doc, [ids[1]!, ids[0]!], sceneId(doc, "EXT. ROAD - CONTINUOUS")), true);
  assert.deepEqual(headings(doc), ["EXT. YARD - NIGHT", "INT. DINER - DAY", "INT. OFFICE - DAY", "INT. GARAGE - DAWN", "EXT. ROAD - CONTINUOUS"]);
  assert.deepEqual(doc.validate(), []);
});

test("moveSection carries its sequences and scenes", () => {
  const doc = make();
  const actTwo = doc.toScript().paragraphs.find((p) => plainText(p.runs) === "ACT TWO")!;
  const actOne = doc.toScript().paragraphs.find((p) => plainText(p.runs) === "ACT ONE")!;
  assert.equal(moveSection(doc, actTwo.id, actOne.id), true);
  assert.deepEqual(headings(doc), ["INT. DINER - DAY", "EXT. ROAD - CONTINUOUS", "INT. OFFICE - DAY", "EXT. YARD - NIGHT", "INT. GARAGE - DAWN"]);
  const tree = outlineOf(doc.toScript());
  assert.deepEqual(tree.map((node) => node.kind === "section" && node.title), ["ACT TWO", "ACT ONE"]);
});

test("section anchors place a scene first or last inside a section", () => {
  const doc = make();
  const script = doc.toScript();
  const actTwo = script.paragraphs.find((p) => plainText(p.runs) === "ACT TWO")!;
  const diner = sceneId(doc, "INT. DINER - DAY");
  // Act Two's synopsis stays with the section; the scene goes after it.
  assert.equal(sectionStartAnchor(script, actTwo.id), doc.scenes().find((s) => s.heading === "INT. DINER - DAY")!.headingId);
  assert.equal(sectionEndAnchor(script, actTwo.id), null);
  const actOne = script.paragraphs.find((p) => plainText(p.runs) === "ACT ONE")!;
  assert.equal(sectionEndAnchor(script, actOne.id), actTwo.id);
  moveScene(doc, diner, sectionStartAnchor(script, actOne.id));
  assert.equal(headings(doc)[0], "INT. DINER - DAY");
  const rows = outline(doc);
  assert.equal(rows[0], "section:ACT ONE");
  assert.equal(rows[1], "synopsis:Nell loses the keys.");
  assert.equal(rows[2], "sceneHeading:INT. DINER - DAY");
});

test("scene and section synopsis helpers", () => {
  const doc = make();
  const script = doc.toScript();
  const actTwo = script.paragraphs.find((p) => plainText(p.runs) === "ACT TWO")!;
  const sequence = script.paragraphs.find((p) => plainText(p.runs) === "SEQUENCE B")!;
  setSectionSynopsis(doc, actTwo.id, "The bargain, revised.");
  setSectionSynopsis(doc, sequence.id, "Dawn in the garage.");
  const tree = outlineOf(doc.toScript());
  assert.equal((tree[1] as { synopsis: string }).synopsis, "The bargain, revised.");
  assert.equal(doc.toScript().paragraphs[doc.indexOf(sequence.id) + 1]!.type, "synopsis");
  setSectionSynopsis(doc, actTwo.id, "");
  assert.equal((outlineOf(doc.toScript())[1] as { synopsis: string }).synopsis, "");
  // After the Yard scene comes the SEQUENCE B section; after the last scene, the end of the script.
  assert.equal(sceneEndAnchor(doc.toScript(), sceneId(doc, "EXT. YARD - NIGHT")), sequence.id);
  assert.equal(sceneEndAnchor(doc.toScript(), sceneId(doc, "EXT. ROAD - CONTINUOUS")), null);
  assert.equal(sceneEndAnchor(doc.toScript(), sceneId(doc, "INT. OFFICE - DAY")), doc.scenes().find((s) => s.heading === "EXT. YARD - NIGHT")!.headingId);
});

test("two replicas converge after a move, and a concurrent edit inside the moving scene lands outside it", () => {
  const { a, b, sync } = pair();
  const office = a.scenes()[0]!;
  const bobLine = office.paragraphIds.at(-1)!;
  moveScene(a, office.sceneId, null);
  // B types into the scene A is moving, before hearing about the move.
  b.insertText(bobLine, 0, "STRAY ");
  sync();
  assert.deepEqual(outline(a), outline(b));
  assert.deepEqual(a.validate(), []);
  assert.equal(a.scenes().at(-1)!.sceneId, office.sceneId);
  // The moved scene is intact and the typed text is the documented loss: it did not travel with the scene.
  assert.equal(plainText(a.paragraph(bobLine).runs), "Hold on.");
  assert.ok(outline(a).some((row) => row.includes("STRAY ")));
});

test("the move is one undo step", () => {
  const doc = make();
  const manager = new Y.UndoManager([doc.body], { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
  const original = outline(doc);
  doc.ydoc.transact(() => moveScene(doc, sceneId(doc, "EXT. YARD - NIGHT"), sceneId(doc, "INT. OFFICE - DAY")), "local");
  assert.notDeepEqual(outline(doc), original);
  manager.undo();
  assert.deepEqual(outline(doc), original);
});

test("synopsis: read, create, update in place, delete", () => {
  const doc = make();
  const office = sceneId(doc, "INT. OFFICE - DAY"), yard = sceneId(doc, "EXT. YARD - NIGHT");
  assert.equal(sceneSynopsis(doc.toScript(), office), "Nell waits.");
  assert.equal(sceneSynopsis(doc.toScript(), yard), "");

  const synopsisId = doc.toScript().paragraphs.find((p) => p.type === "synopsis" && plainText(p.runs) === "Nell waits.")!.id;
  setSceneSynopsis(doc, office, "Nell waits, then gives up.");
  assert.equal(sceneSynopsis(doc.toScript(), office), "Nell waits, then gives up.");
  assert.equal(doc.paragraph(synopsisId).type, "synopsis");

  setSceneSynopsis(doc, yard, "Rain starts.\nThe sedans hum.");
  assert.equal(sceneSynopsis(doc.toScript(), yard), "Rain starts.\nThe sedans hum.");
  const yardScene = doc.scenes().find((s) => s.sceneId === yard)!;
  assert.equal(doc.toScript().paragraphs[yardScene.start + 1]!.type, "synopsis");

  setSceneSynopsis(doc, office, "  ");
  assert.equal(sceneSynopsis(doc.toScript(), office), "");
  assert.throws(() => doc.paragraph(synopsisId), RangeError);
  assert.deepEqual(doc.validate(), []);
});

test("a synopsis edit leaves the paragraph's formatting alone outside the changed text", () => {
  const doc = make();
  const office = sceneId(doc, "INT. OFFICE - DAY");
  const id = doc.toScript().paragraphs.find((p) => p.type === "synopsis" && plainText(p.runs) === "Nell waits.")!.id;
  doc.format(id, 0, 4, { bold: true });
  setSceneSynopsis(doc, office, "Nell waits here.");
  assert.deepEqual(doc.paragraph(id).runs, [{ text: "Nell", bold: true }, { text: " waits here." }]);
});

test("section titles: add, rename, remove", () => {
  const doc = make();
  const diner = doc.scenes().find((s) => s.heading === "INT. DINER - DAY")!;
  const id = addSection(doc, { title: "THE DINER", depth: 2, beforeId: diner.sceneId });
  assert.equal(doc.paragraph(id).depth, 2);
  assert.equal(outline(doc)[doc.indexOf(id)], "section:THE DINER");
  setSectionTitle(doc, id, "THE DINER SCENE");
  assert.equal(plainText(doc.paragraph(id).runs), "THE DINER SCENE");
  setSectionSynopsis(doc, id, "About the diner.");
  const count = doc.toScript().paragraphs.length;
  removeSection(doc, id);
  assert.throws(() => doc.paragraph(id), RangeError);
  assert.equal(doc.toScript().paragraphs.length, count - 2);
  assert.throws(() => setSectionTitle(doc, diner.headingId, "x"), RangeError);
  assert.throws(() => removeSection(doc, diner.headingId), RangeError);
  const end = addSection(doc, { title: "END" });
  assert.equal(doc.indexOf(end), doc.toScript().paragraphs.length - 1);
});

test("the outline nests sections by depth and lists scenes inside them", () => {
  const tree = outlineOf(make().toScript());
  assert.equal(tree.length, 2);
  const [one, two] = tree as [Extract<(typeof tree)[number], { kind: "section" }>, Extract<(typeof tree)[number], { kind: "section" }>];
  assert.deepEqual([one.title, one.synopsis, one.depth], ["ACT ONE", "Nell loses the keys.", 1]);
  assert.deepEqual(one.children.map((n) => n.kind), ["scene", "scene", "section"]);
  const sequence = one.children[2] as typeof one;
  assert.deepEqual([sequence.title, sequence.depth, sequence.children.length], ["SEQUENCE B", 2, 1]);
  assert.deepEqual(two.children.map((n) => n.kind), ["scene", "scene"]);
});

test("scene headings split into setting, location and time of day", () => {
  assert.deepEqual(parseSceneHeading("INT. KITCHEN - NIGHT"), { setting: "INT", location: "KITCHEN", timeOfDay: "NIGHT" });
  assert.deepEqual(parseSceneHeading("EXT. SALVAGE YARD - DAWN"), { setting: "EXT", location: "SALVAGE YARD", timeOfDay: "DAWN" });
  assert.deepEqual(parseSceneHeading("INT./EXT. CAR - MOVING - DAY"), { setting: "INT/EXT", location: "CAR - MOVING", timeOfDay: "DAY" });
  assert.deepEqual(parseSceneHeading("I/E TRUCK - LATER"), { setting: "INT/EXT", location: "TRUCK", timeOfDay: "LATER" });
  assert.deepEqual(parseSceneHeading("EXT. EASTWOOD - LATER THAT NIGHT"), { setting: "EXT", location: "EASTWOOD", timeOfDay: "LATER THAT NIGHT" });
  assert.deepEqual(parseSceneHeading("INT. HOUSE - KITCHEN"), { setting: "INT", location: "HOUSE - KITCHEN" });
  assert.deepEqual(parseSceneHeading("INTERIOR HALL"), { location: "INTERIOR HALL" });
  assert.deepEqual(parseSceneHeading("INT. STUDIO"), { setting: "INT", location: "STUDIO" });
});

test("scene summaries carry heading parts, characters, length, words and synopsis", () => {
  const summaries = sceneSummaries(make().toScript());
  assert.equal(summaries.length, 5);
  const office = summaries[0]!;
  assert.deepEqual([office.setting, office.location, office.timeOfDay, office.index], ["INT", "OFFICE", "DAY", 0]);
  assert.deepEqual(office.characters, ["NELL", "BOB"]);
  assert.equal(office.synopsis, "Nell waits.");
  assert.equal(office.words, 4 + 5 + 1 + 1 + 2 + 2);
  assert.ok(office.eighths >= 1);
  assert.equal(office.page, "1");
  assert.deepEqual(summaries[3]!.characters, ["NELL"]);
  assert.equal(summaries[4]!.synopsis, "");
  assert.equal(new Set(summaries.map((s) => s.sceneId)).size, 5);
});

test("scene color reads Final Draft's SceneProperties and writes it back through FDX", () => {
  const fdx = readFileSync(new URL("./fixtures/synthetic.fdx", import.meta.url), "utf8");
  const doc = ScreenplayDoc.fromScript(parseFdx(fdx));
  const [first] = doc.scenes();
  assert.equal(sceneColor(doc.paragraph(first!.headingId)), undefined);

  setSceneColor(doc, first!.sceneId, "#3e63dd");
  assert.equal(sceneColor(doc.paragraph(first!.headingId)), "#3E63DD");
  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<SceneProperties Color="#3E3E6363DDDD" Length="1 1\/8" Page="1" Title="Opening">/);
  // The arc beats inside SceneProperties survive.
  assert.match(xml, /Wants the keys back\./);
  const back = ScreenplayDoc.fromScript(parseFdx(xml));
  assert.equal(sceneColor(back.paragraph(first!.headingId)), "#3E63DD");
  assert.equal(sceneSummaries(back.toScript())[0]!.color, "#3E63DD");

  setSceneColor(doc, first!.sceneId, null);
  assert.equal(sceneColor(doc.paragraph(first!.headingId)), undefined);
  assert.doesNotMatch(writeFdx(doc.toScript()), /Color="#3E3E/);
  assert.throws(() => setSceneColor(doc, first!.sceneId, "blue"), RangeError);
});

test("scene color on a script with no FDX data creates a SceneProperties node", () => {
  const doc = make();
  const office = doc.scenes()[0]!;
  setSceneColor(doc, office.sceneId, SCENE_COLORS[0]!.value);
  const xml = writeFdx(doc.toScript());
  // The scene's synopsis rides along as Final Draft's index card Summary.
  assert.match(xml, /<SceneProperties Color="#E5E548484D4D">\s*<Summary>/);
  assert.equal(sceneColor(doc.paragraph(office.headingId)), SCENE_COLORS[0]!.value);
  // Clearing it removes the node, leaving the paragraph as it was.
  setSceneColor(doc, office.sceneId, null);
  assert.equal(doc.paragraph(office.headingId).fdx, undefined);
});

test("a six-digit color in a file stays six digits", () => {
  const xml = `<?xml version="1.0"?><FinalDraft DocumentType="Script"><Content><Paragraph Type="Scene Heading" id="h1"><SceneProperties Color="#112233"/><Text>INT. A - DAY</Text></Paragraph></Content></FinalDraft>`;
  const doc = ScreenplayDoc.fromScript(parseFdx(xml));
  assert.equal(sceneColor(doc.paragraph("h1")), "#112233");
  setSceneColor(doc, "h1", "#445566");
  assert.match(writeFdx(doc.toScript()), /Color="#445566"/);
});

test("numberScenes and removeSceneNumbers", () => {
  const doc = make();
  assert.equal(numberScenes(doc), 5);
  assert.deepEqual(doc.scenes().map((s) => s.number), ["1", "2", "3", "4", "5"]);
  assert.equal(numberScenes(doc), 0);
  assert.match(writeFdx(doc.toScript()), /Type="Scene Heading" Number="5"/);
  moveScene(doc, doc.scenes()[4]!.sceneId, doc.scenes()[0]!.sceneId);
  assert.deepEqual(doc.scenes().map((s) => s.number), ["5", "1", "2", "3", "4"]);
  assert.equal(numberScenes(doc), 5);
  assert.deepEqual(doc.scenes().map((s) => s.number), ["1", "2", "3", "4", "5"]);
  assert.equal(removeSceneNumbers(doc), 5);
  assert.deepEqual(doc.scenes().map((s) => s.number), [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(removeSceneNumbers(doc), 0);
  assert.deepEqual(doc.validate(), []);
});

test("locked scene numbers: Number Scenes keeps every number and gives new scenes A-numbers", () => {
  assert.deepEqual(lockedSceneNumbers(["1", undefined, "2", undefined, undefined, "3"]), ["1", "1A", "2", "2A", "2B", "3"]);
  assert.deepEqual(lockedSceneNumbers([undefined, "1", "1A", undefined, "2"]), ["A1", "1", "1A", "1B", "2"]);
  assert.deepEqual(lockedSceneNumbers(["12", undefined, "12A"]), ["12", "12AA", "12A"]);
  assert.deepEqual(lockedSceneNumbers([undefined, undefined]), [undefined, undefined], "nothing to keep: no numbers yet");
  assert.equal(sceneNumberBetween("12A", "12B"), "12AA");
  assert.ok(compareSceneNumbers("12A", "12B") < 0 && compareSceneNumbers("A1", "1") < 0 && compareSceneNumbers("9", "10") < 0);

  const doc = make();
  numberScenes(doc);
  setSceneNumbersLocked(doc, true);
  assert.equal(sceneNumbersLocked(doc), true);
  // A new scene after scene 2 and one before scene 1.
  const second = doc.scenes()[1]!;
  doc.insertParagraph(doc.indexOf(doc.scenes()[2]!.headingId), { type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] });
  doc.insertParagraph(doc.indexOf(doc.scenes()[0]!.headingId), { type: "sceneHeading", runs: [{ text: "EXT. STREET - DAY" }] });
  moveScene(doc, doc.scenes().at(-1)!.sceneId, second.sceneId);
  assert.equal(numberScenes(doc), 2);
  assert.deepEqual(doc.scenes().map((s) => s.number), ["A1", "1", "5", "2", "2A", "3", "4"]);
  assert.throws(() => removeSceneNumbers(doc), /locked/);
  setSceneNumbersLocked(doc, false);
  assert.equal(numberScenes(doc), 7);
  assert.deepEqual(doc.scenes().map((s) => s.number), ["1", "2", "3", "4", "5", "6", "7"]);
});

test("a 3,000-paragraph script moves, summarizes and numbers quickly", () => {
  const lines: string[] = [];
  for (let scene = 1; scene <= 300; scene++) {
    if (scene % 50 === 1) lines.push(`# ACT ${Math.ceil(scene / 50)}`, "");
    lines.push(`INT. LOCATION ${scene} - DAY`, "", `= Synopsis of scene ${scene}.`, "");
    for (let k = 0; k < 3; k++) lines.push(`Action line ${k} in scene ${scene} with several words to wrap around.`, "", `CHAR${k}`, `Line ${k} of dialogue.`, "");
  }
  const doc = ScreenplayDoc.fromScript(parseFountain(lines.join("\n")));
  const count = doc.toScript().paragraphs.length;
  assert.ok(count >= 3000, `only ${count} paragraphs`);
  const time = <T>(label: string, run: () => T): T => {
    const start = performance.now();
    const result = run();
    const ms = performance.now() - start;
    console.log(`  ${label}: ${ms.toFixed(0)} ms (${count} paragraphs)`);
    assert.ok(ms < 3000, `${label} took ${ms} ms`);
    return result;
  };
  const script = doc.toScript();
  const summaries = time("sceneSummaries", () => sceneSummaries(script));
  assert.equal(summaries.length, 300);
  time("outlineOf", () => outlineOf(script));
  const ids = doc.scenes().map((s) => s.sceneId);
  time("moveScene", () => moveScene(doc, ids[250]!, ids[3]!));
  time("moveScenes", () => moveScenes(doc, [ids[10]!, ids[200]!, ids[201]!], ids[290]!));
  time("numberScenes", () => numberScenes(doc));
  time("setSceneSynopsis", () => setSceneSynopsis(doc, ids[100]!, "New words."));
  assert.equal(doc.toScript().paragraphs.length, count);
  assert.deepEqual(doc.validate(), []);
});

// Randomized: every paragraph (ID, type, runs, attributes) survives any sequence of scene and section moves.
function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }

function randomScript(r: () => number): Paragraph[] {
  const out: Paragraph[] = [];
  const types = ["action", "character", "dialogue", "parenthetical", "synopsis", "note"] as const;
  for (let i = 0; i < 4 + Math.floor(r() * 10); i++) {
    const kind = r();
    if (kind < 0.18) out.push({ id: newId(), type: "section", depth: 1 + Math.floor(r() * 3), runs: [{ text: "SEC " + i }] });
    else if (kind < 0.55) {
      const id = newId();
      out.push({ id, type: "sceneHeading", sceneId: id, runs: [{ text: "INT. PLACE " + i + " - DAY" }] });
      if (r() < 0.4) out.push({ id: newId(), type: "synopsis", runs: [{ text: "syn " + i }] });
    } else {
      const t = types[Math.floor(r() * types.length)]!;
      const runs: Run[] = r() < 0.4 ? [{ text: "bo", bold: true as const }, { text: "ld\nsoft " + i }] : [{ text: "text " + i }];
      out.push({ id: newId(), type: t, runs });
    }
  }
  return out;
}
const sig = (p: Paragraph) => JSON.stringify(p);

test("random moves keep every paragraph intact, place scenes before the anchor and sync to a replica", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const paras = randomScript(r);
    const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: paras });
    const before = new Map(doc.toScript().paragraphs.map((p) => [p.id, sig(p)]));
    for (let step = 0; step < 6; step++) {
      const script = doc.toScript();
      const blocks = sceneBlocks(script.paragraphs);
      const sections = script.paragraphs.filter((p) => p.type === "section");
      const ids = script.paragraphs.map((p) => p.id);
      const anchor = r() < 0.15 ? null : ids[Math.floor(r() * ids.length)]!;
      try {
        if (r() < 0.6 && blocks.length) {
          const pick = blocks.filter(() => r() < 0.4).map((b) => b.sceneId);
          if (!pick.length) pick.push(blocks[0]!.sceneId);
          // anchor must not be inside a picked scene for sane case
          const pre = doc.toScript().paragraphs;
          const bl = sceneBlocks(pre).filter((b) => pick.includes(b.sceneId));
          const moving = new Set(bl.flatMap((b) => pre.slice(b.start, b.end).map((p) => p.id)));
          const changed = moveScenes(doc, pick, anchor);
          const post = doc.toScript().paragraphs.map((p) => p.id);
          if (anchor && !moving.has(anchor)) {
            const ai = post.indexOf(anchor);
            const movedList = pre.map((p) => p.id).filter((id) => moving.has(id));
            assert.deepEqual(post.slice(ai - movedList.length, ai), movedList, `seed ${seed} placement`);
          } else if (anchor === null) {
            const movedList = pre.map((p) => p.id).filter((id) => moving.has(id));
            assert.deepEqual(post.slice(post.length - movedList.length), movedList, `seed ${seed} end placement`);
          }
          void changed;
        } else if (sections.length) {
          moveSection(doc, sections[Math.floor(r() * sections.length)]!.id, anchor);
        }
      } catch (e) { assert.fail(`seed ${seed} step ${step}: ${e}`); }
      assert.deepEqual(doc.validate(), [], `seed ${seed}`);
      const after = doc.toScript().paragraphs;
      assert.equal(after.length, paras.length, `seed ${seed} count`);
      for (const p of after) assert.equal(sig(p), before.get(p.id), `seed ${seed} paragraph ${p.id} changed`);
      // sync into a fresh replica
      const copy = ScreenplayDoc.fromUpdate(doc.encodeState());
      assert.deepEqual(copy.toScript().paragraphs.map(sig), after.map(sig));
      // FDX keeps no sections or notes (the writer warns), and only a scene's own synopsis (as its Summary, which
      // comes back with a new ID); everything else keeps its ID and order.
      const re = parseFdx(writeFdx(doc.toScript()));
      const key = (p: Paragraph) => (p.type === "synopsis" ? "synopsis" : p.id + p.type);
      const kept = after.filter((p, i) => !["section", "note"].includes(p.type) && (p.type !== "synopsis" || after[i - 1]?.type === "sceneHeading"));
      assert.deepEqual(re.paragraphs.map(key), kept.map(key));
    }
  }
});

// ---- Concurrent moves of the same scene

/** Replicas of one script; pull(x, y) brings x up to date with y. */
function replicas(count: number, script = parseFountain(SCRIPT)) {
  const first = ScreenplayDoc.fromScript(script);
  const docs = [first, ...Array.from({ length: count - 1 }, () => ScreenplayDoc.fromUpdate(first.encodeState()))];
  const pull = (x: ScreenplayDoc, y: ScreenplayDoc) => x.applyUpdate(Y.encodeStateAsUpdate(y.ydoc, Y.encodeStateVector(x.ydoc)), "remote");
  const syncAll = () => {
    for (let round = 0; round < 2; round++) for (const x of docs) for (const y of docs) if (x !== y) pull(x, y);
  };
  return { docs, pull, syncAll };
}

const idCounts = (doc: ScreenplayDoc) => {
  const counts = new Map<string, number>();
  for (const p of doc.toScript().paragraphs) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  return counts;
};

/** Every original ID still there exactly once, plus copies with IDs made from their line breaks. */
function assertOriginalsOnce(doc: ScreenplayDoc, original: Map<string, number>, message?: string) {
  const counts = idCounts(doc);
  for (const id of original.keys()) assert.equal(counts.get(id), 1, `${message ?? ""} ${id}`);
  for (const id of counts.keys()) assert.ok(original.has(id) || /^y\d+-\d+$/.test(id), `${message ?? ""} ${id}`);
}

test("two writers moving the same scene to different places converge with both copies kept", () => {
  const { docs: [a, b], syncAll } = replicas(2);
  const original = idCounts(a!);
  const office = sceneId(a!, "INT. OFFICE - DAY");
  moveScene(a!, office, sceneId(a!, "INT. DINER - DAY"));
  moveScene(b!, office, null);
  syncAll();
  assert.deepEqual(a!.validate(), []);
  assert.deepEqual(a!.toScript(), b!.toScript());
  assertOriginalsOnce(a!, original);
  // Both moves show; the copy earlier in the script keeps the scene's IDs, the other has new ones.
  assert.deepEqual(headings(a!), ["EXT. YARD - NIGHT", "INT. GARAGE - DAWN", "INT. OFFICE - DAY", "INT. DINER - DAY", "EXT. ROAD - CONTINUOUS", "INT. OFFICE - DAY"]);
  assert.equal(a!.scenes()[2]!.sceneId, office);
  assert.notEqual(a!.scenes()[5]!.sceneId, office);
});

test("text typed into the surviving copy is kept on every peer", () => {
  const { docs: [a, b], syncAll } = replicas(2);
  const office = a!.scenes().find((scene) => scene.heading === "INT. OFFICE - DAY")!;
  const line = office.paragraphIds.at(-1)!;
  assert.ok(moveScene(a!, office.sceneId, sceneId(a!, "INT. DINER - DAY")));
  a!.insertText(line, 0, "Wait. ");
  assert.ok(moveScene(b!, office.sceneId, null));
  syncAll();
  assert.deepEqual(a!.validate(), []);
  assert.deepEqual(outline(a!), outline(b!));
  assert.equal(plainText(b!.paragraph(line).runs), "Wait. Hold on.");
  assert.deepEqual(headings(b!).slice(2, 4), ["INT. OFFICE - DAY", "INT. DINER - DAY"]);
});

test("three writers moving the same scene at once, synced in any order, converge with every ID once", () => {
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    const { docs, pull, syncAll } = replicas(3);
    const original = idCounts(docs[0]!);
    const garage = sceneId(docs[0]!, "INT. GARAGE - DAWN");
    moveScene(docs[0]!, garage, sceneId(docs[0]!, "INT. OFFICE - DAY"));
    moveScene(docs[1]!, garage, null);
    moveScene(docs[2]!, garage, sceneId(docs[2]!, "INT. DINER - DAY"));
    // Partial syncs first, so peers repair different subsets of the copies.
    pull(docs[order[0]!]!, docs[order[1]!]!);
    pull(docs[order[1]!]!, docs[order[2]!]!);
    syncAll();
    for (const doc of docs) {
      assert.deepEqual(doc.validate(), [], `order ${order}`);
      assertOriginalsOnce(doc, original, `order ${order}`);
      assert.deepEqual(doc.toScript(), docs[0]!.toScript(), `order ${order}`);
      assert.equal(headings(doc).filter((heading) => heading === "INT. GARAGE - DAWN").length, 3, `order ${order}`);
    }
  }
});

// Sol's round-3 reproductions: a move, its undo and its redo on three peers erased a scene, and undoing the move
// whose copy lost deleted text typed into the copy that won.

/** Peers with fixed Yjs client IDs on a script written by client 1, each with its own undo. */
function undoPeers(clients: number[], source: string) {
  const ydoc = new Y.Doc();
  ydoc.clientID = 1;
  const base = ScreenplayDoc.fromScript(parseFountain(source), ydoc);
  const peers = clients.map((client) => {
    const peerDoc = new Y.Doc();
    peerDoc.clientID = client;
    const doc = new ScreenplayDoc(peerDoc);
    doc.applyUpdate(base.encodeState(), "remote");
    const undo = new Y.UndoManager([doc.body, doc.meta], { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
    return { doc, undo, edit: (change: () => void) => peerDoc.transact(change, "local") };
  });
  const syncAll = () => {
    for (let round = 0; round < 3; round++) {
      for (const x of peers) for (const y of peers) if (x !== y) x.doc.applyUpdate(Y.encodeStateAsUpdate(y.doc.ydoc, Y.encodeStateVector(x.doc.ydoc)), "remote");
    }
  };
  return { peers, syncAll };
}

const ABCD = "INT. A - DAY\n\nAlpha.\n\nINT. B - DAY\n\nBravo.\n\nINT. C - DAY\n\nCharlie.\n\nINT. D - DAY\n\nDelta.\n";
const allText = (doc: ScreenplayDoc) => doc.toScript().paragraphs.map((p) => plainText(p.runs)).join("\n");

test("a move undone and redone on three peers keeps the scene, and every line break keeps an ID", () => {
  const { peers: [p100, p200, p300], syncAll } = undoPeers([100, 200, 300], ABCD);
  const a = sceneId(p300!.doc, "INT. A - DAY");
  p300!.edit(() => moveScene(p300!.doc, a, sceneId(p300!.doc, "INT. C - DAY")));
  p100!.edit(() => moveScene(p100!.doc, a, sceneId(p100!.doc, "INT. C - DAY")));
  p100!.undo.undo();
  p100!.undo.redo();
  p300!.undo.undo();
  p100!.undo.undo();
  syncAll();
  for (const peer of [p100!, p200!, p300!]) {
    assert.deepEqual(peer.doc.validate(), []);
    assert.deepEqual(peer.doc.toScript(), p100!.doc.toScript());
    assert.ok(allText(peer.doc).includes("INT. A - DAY"), allText(peer.doc));
    assert.ok(allText(peer.doc).includes("Alpha."), allText(peer.doc));
    for (const word of ["Bravo.", "Charlie.", "Delta."]) assert.equal(allText(peer.doc).split(word).length, 2);
  }
});

test("undoing the move whose copy lost keeps the text typed into the copy that won", () => {
  const { peers: [p100, p300], syncAll } = undoPeers([100, 300], ABCD);
  const a = sceneId(p300!.doc, "INT. A - DAY");
  p300!.edit(() => moveScene(p300!.doc, a, sceneId(p300!.doc, "INT. C - DAY")));
  p100!.edit(() => moveScene(p100!.doc, a, null));
  syncAll();
  // Peer 300's copy comes first, so it keeps the scene's IDs; a writer types into it.
  const alpha = p300!.doc.toScript().paragraphs.find((p) => plainText(p.runs) === "Alpha.")!.id;
  assert.equal(headings(p300!.doc).indexOf("INT. A - DAY"), 1);
  p300!.edit(() => p300!.doc.insertText(alpha, 0, "Accepted. "));
  syncAll();
  p100!.undo.undo();
  syncAll();
  for (const peer of [p100!, p300!]) {
    assert.deepEqual(peer.doc.validate(), []);
    assert.deepEqual(peer.doc.toScript(), p300!.doc.toScript());
    assert.ok(allText(peer.doc).includes("Accepted. Alpha."), allText(peer.doc));
  }
});

test("random concurrent moves on two and three replicas converge with no repeated or lost paragraph", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const r = rng(seed);
    const count = 2 + (seed % 2);
    const { docs, pull, syncAll } = replicas(count, { titlePage: [], paragraphs: randomScript(r) });
    const original = idCounts(docs[0]!);
    for (let step = 0; step < 8; step++) {
      const doc = docs[Math.floor(r() * count)]!;
      const script = doc.toScript();
      const blocks = sceneBlocks(script.paragraphs);
      const sections = script.paragraphs.filter((p) => p.type === "section");
      const ids = script.paragraphs.map((p) => p.id);
      const anchor = r() < 0.2 ? null : ids[Math.floor(r() * ids.length)]!;
      try {
        if (r() < 0.7 && blocks.length) {
          const pick = blocks.filter(() => r() < 0.4).map((b) => b.sceneId);
          moveScenes(doc, pick.length ? pick : [blocks[Math.floor(r() * blocks.length)]!.sceneId], anchor);
        } else if (sections.length) moveSection(doc, sections[Math.floor(r() * sections.length)]!.id, anchor);
      } catch {
        // The anchor was inside the moving scenes: nothing moved.
      }
      if (r() < 0.3) pull(docs[Math.floor(r() * count)]!, docs[Math.floor(r() * count)]!);
    }
    syncAll();
    for (const doc of docs) {
      assert.deepEqual(doc.validate(), [], `seed ${seed}`);
      assertOriginalsOnce(doc, original, `seed ${seed}`);
      assert.deepEqual(doc.toScript().paragraphs.map(sig), docs[0]!.toScript().paragraphs.map(sig), `seed ${seed}`);
    }
  }
});

test("a read-only follower that leaves repairs to the writers ends with the writers' text", () => {
  const base = ScreenplayDoc.fromScript(parseFountain("INT. Q - DAY\n\nQuiet.\n\nINT. P - DAY\n\nPaper.\n\nINT. Z - DAY\n\nZero.\n"));
  // Fixed client IDs: Yjs orders inserts at the same spot by client, and C's line break must come before B's typing.
  const peer = (client: number) => {
    const ydoc = new Y.Doc();
    ydoc.clientID = client;
    const doc = new ScreenplayDoc(ydoc);
    doc.applyUpdate(base.encodeState(), "remote");
    const sent: Uint8Array[] = [];
    ydoc.on("update", (update: Uint8Array, origin: unknown) => origin !== "remote" && sent.push(update));
    return { doc, sent };
  };
  const a = peer(100), b = peer(300), c = peer(200), reader = peer(400);
  reader.doc.setRepairs(false);
  const take = (to: { doc: ScreenplayDoc }, from: { sent: Uint8Array[] }, ...indexes: number[]) => {
    for (const index of indexes) to.doc.applyUpdate(from.sent[index]!, "remote");
  };
  const paper = base.toScript().paragraphs.find((p) => plainText(p.runs) === "Paper.")!.id;
  const scene = sceneId(base, "INT. P - DAY");
  moveScene(a.doc, scene, sceneId(a.doc, "INT. Q - DAY"));
  moveScene(b.doc, scene, null);
  // C sees B's move and starts a new line after its last line; B types at the end of that line.
  take(c, b, 0);
  c.doc.splitParagraph(paper, 6);
  b.doc.insertText(paper, 6, " Typed.");
  // The follower sees B's typing and A's move before C's new line.
  take(reader, b, 0, 1);
  take(reader, a, 0);
  take(a, b, 0, 1);
  take(a, c, 0);
  take(b, c, 0);
  take(b, a, 0);
  take(c, b, 1);
  take(c, a, 0);
  const all = [a, b, c, reader];
  // The follower sends nothing.
  for (let round = 0; round < 2; round++) for (const x of all) for (const y of [a, b, c]) if (x !== y) x.doc.applyUpdate(Y.encodeStateAsUpdate(y.doc.ydoc, Y.encodeStateVector(x.doc.ydoc)), "remote");
  for (const peer of all) {
    assert.deepEqual(peer.doc.validate(), []);
    assert.deepEqual(outline(peer.doc), outline(a.doc));
  }
  assert.ok(outline(a.doc).includes("action: Typed."), outline(a.doc).join(" | "));
});

// Randomized: three writers move scenes and sections, type inside them, undo and redo, and their changes reach each
// other late and out of order. Every writer ends with the same valid script, and every word a writer typed is still
// there unless that writer's own undo took it back.
test("three writers moving, typing, undoing and redoing with late, out-of-order delivery lose no typed text", () => {
  const TOKEN = /<w\d+\.\d+>/g;
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const base = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: randomScript(r) });
    const baseText = allText(base);
    const writers = [0, 1, 2].map((k) => {
      const ydoc = new Y.Doc();
      ydoc.clientID = 10 + k;
      const doc = new ScreenplayDoc(ydoc);
      doc.applyUpdate(base.encodeState(), "net");
      const undo = new Y.UndoManager([doc.body, doc.meta], { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
      // Which word each undo step typed, so a word the writer undid is not expected any more.
      let typing: string | null = null;
      undo.on("stack-item-added", (event: { stackItem: { meta: Map<string, unknown> } }) => {
        if (typing) event.stackItem.meta.set("token", typing);
      });
      const undone = new Set<string>();
      undo.on("stack-item-popped", (event: { stackItem: { meta: Map<string, unknown> }; type: "undo" | "redo" }) => {
        const token = event.stackItem.meta.get("token") as string | undefined;
        if (!token) return;
        const other = event.type === "undo" ? undo.redoStack : undo.undoStack;
        other.at(-1)?.meta.set("token", token);
        if (event.type === "undo") undone.add(token);
        else undone.delete(token);
      });
      return {
        doc, undo, undone, typed: [] as string[], inbox: [] as Uint8Array[],
        edit(change: () => void, token: string | null = null) {
          typing = token;
          try {
            ydoc.transact(change, "local");
          } finally {
            typing = null;
          }
        },
      };
    });
    writers.forEach((writer, k) => writer.doc.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "net") writers.forEach((other, j) => j !== k && other.inbox.push(update));
    }));
    const deliver = (writer: (typeof writers)[number], count: number) => {
      for (let n = 0; n < count && writer.inbox.length; n++) {
        // Any waiting update, not only the oldest: Yjs holds one back until what it builds on arrives.
        const [update] = writer.inbox.splice(Math.floor(r() * writer.inbox.length), 1);
        writer.doc.applyUpdate(update!, "net");
      }
    };
    for (let step = 0; step < 40; step++) {
      const k = Math.floor(r() * 3);
      const writer = writers[k]!;
      const roll = r();
      const script = writer.doc.toScript();
      if (roll < 0.25) {
        const blocks = sceneBlocks(script.paragraphs);
        const sections = script.paragraphs.filter((p) => p.type === "section");
        const ids = script.paragraphs.map((p) => p.id);
        const anchor = r() < 0.2 ? null : ids[Math.floor(r() * ids.length)]!;
        try {
          if (r() < 0.75 && blocks.length) writer.edit(() => moveScene(writer.doc, blocks[Math.floor(r() * blocks.length)]!.sceneId, anchor));
          else if (sections.length) writer.edit(() => moveSection(writer.doc, sections[Math.floor(r() * sections.length)]!.id, anchor));
        } catch {
          // The anchor was inside what was moving: nothing moved.
        }
      } else if (roll < 0.55) {
        // Type a word where it splits no other word, often inside a scene someone else is moving.
        const paragraph = script.paragraphs[Math.floor(r() * script.paragraphs.length)];
        if (!paragraph?.id) continue;
        const text = plainText(paragraph.runs);
        // Text left before the first line break reads as part of the first paragraph but cannot be typed into.
        const { start, end } = writer.doc.range(paragraph.id);
        if (end - start !== text.length) continue;
        const inside = [...text.matchAll(TOKEN)].map((match) => [match.index, match.index + match[0].length] as const);
        const free = Array.from({ length: text.length + 1 }, (_, i) => i).filter((i) => !inside.some(([from, to]) => i > from && i < to));
        const token = `<w${k}.${step}>`;
        writer.typed.push(token);
        writer.edit(() => writer.doc.insertText(paragraph.id, free[Math.floor(r() * free.length)]!, token), token);
      } else if (roll < 0.72) {
        writer.undo.undo();
      } else if (roll < 0.8) {
        writer.undo.redo();
      } else {
        deliver(writers[Math.floor(r() * 3)]!, 1 + Math.floor(r() * 4));
      }
    }
    for (let round = 0; round < 6; round++) for (const writer of writers) deliver(writer, 10_000);
    const final = writers[0]!.doc.toScript();
    const text = allText(writers[0]!.doc);
    for (const writer of writers) {
      assert.deepEqual(writer.doc.validate(), [], `seed ${seed}`);
      assert.deepEqual(writer.doc.toScript(), final, `seed ${seed}`);
      for (const token of writer.typed) if (!writer.undone.has(token)) assert.ok(text.includes(token), `seed ${seed}: ${token} lost`);
    }
    // Nobody deleted anything: every line of the original script is still there.
    const untokened = text.replace(TOKEN, "");
    for (const line of baseText.split("\n")) assert.ok(untokened.includes(line), `seed ${seed}: "${line}" lost`);
  }
});
