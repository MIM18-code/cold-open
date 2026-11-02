import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDocumentTemplate, entranceRanges, numberScenes, pageOf, paginate, parseFdx, plainText,
  ScreenplayDoc, returnKeyFlow, scriptPaginationOptions, setSceneNumbersLocked, templatePageBreaks, templateParagraphs, templateScript,
  templateStyle, writeFdx, type ElementType, type Paragraph, type Script, type TemplateId,
} from "../src/index.ts";

const PRINT_ELEMENTS = [
  "Scene Heading", "Action", "Character", "Parenthetical", "Dialogue", "Transition", "Shot", "General",
  "Lyrics", "Cast List", "New Act", "End of Act",
];

function elementBlock(xml: string, name: string): string {
  const block = xml.match(new RegExp(`<ElementSettings Type="${name}"[^>]*>[\\s\\S]*?</ElementSettings>`))?.[0];
  assert.ok(block, `FDX has ${name} settings`);
  return block;
}

function spec(type: ElementType, text: string, index: number): Paragraph {
  return { id: `p${index}`, type, runs: text ? [{ text }] : [], ...(type === "sceneHeading" ? { sceneId: `s${index}` } : {}) };
}

function scriptOf(template: TemplateId, ...specs: [ElementType, string][]): Script {
  return { titlePage: [], template, paragraphs: specs.map(([type, text], index) => spec(type, text, index)) };
}

test("every template writes Final Draft element names and the page layout to FDX", () => {
  for (const id of ["oneHourDrama", "halfHourComedy", "multiCamera", "stage"] as const) {
    const xml = writeFdx(templateScript(id));
    assert.match(xml, /<PageLayout /, `${id} writes PageLayout`);
    for (const name of PRINT_ELEMENTS) elementBlock(xml, name);
  }
});

test("the one-hour drama template centers acts, closes them, and breaks a page before each act", () => {
  const style = templateStyle("oneHourDrama");
  assert.equal(style.elements.newAct.align, "center");
  assert.equal(style.elements.newAct.caps, true);
  assert.equal(style.elements.endOfAct.align, "center");
  assert.equal(style.returns.endOfAct, "newAct");

  const xml = writeFdx(templateScript("oneHourDrama"));
  const act = elementBlock(xml, "New Act");
  assert.match(act, /Alignment="Center"/);
  assert.match(act, /ReturnKey="Scene Heading"/);
  const end = elementBlock(xml, "End of Act");
  assert.match(end, /Alignment="Center"/);

  const script = scriptOf("oneHourDrama",
    ["newAct", "TEASER"], ["sceneHeading", "INT. OFFICE - NIGHT"], ["action", "A short teaser."],
    ["endOfAct", "END OF TEASER"], ["newAct", "ACT ONE"], ["sceneHeading", "INT. HALL - DAY"], ["action", "Act one."]);
  const result = paginate(script, scriptPaginationOptions(script));
  // The act heading, not the scene heading after it, is what moves to the new page.
  assert.equal(result.pages.length, 2);
  assert.equal(pageOf(result, "p4"), 1);
  assert.equal(pageOf(result, "p5"), 1);
});

test("the half-hour comedy template breaks a page before acts and leaves scene headings where they fall", () => {
  const style = templateStyle("halfHourComedy");
  assert.equal(style.elements.dialogue.spacing ?? 1, 1);
  assert.equal(style.elements.action.caps, false);
  const parts = templateParagraphs("halfHourComedy");
  assert.deepEqual(parts.filter((part) => part.type === "newAct").map((part) => plainText(part.runs)),
    ["COLD OPEN", "ACT ONE", "ACT TWO", "ACT THREE", "TAG"]);

  const script: Script = { titlePage: [], template: "halfHourComedy", paragraphs: [
    spec("newAct", "COLD OPEN", 0), spec("sceneHeading", "INT. DINER - DAY", 1), spec("action", "Cold open.", 2),
    spec("newAct", "ACT ONE", 3), spec("sceneHeading", "EXT. STREET - DAY", 4), spec("sceneHeading", "INT. CAR - DAY", 5),
  ] };
  const result = paginate(script, scriptPaginationOptions(script));
  assert.equal(pageOf(result, "p3"), 1);
  assert.equal(pageOf(result, "p4"), 1);
  assert.equal(pageOf(result, "p5"), 1);
});

test("the multi-camera template uses double spacing, capitals, underlined headings and a page per scene", () => {
  const style = templateStyle("multiCamera");
  assert.equal(style.elements.dialogue.spacing, 2);
  assert.equal(style.elements.parenthetical.spacing, 2);
  assert.equal(style.elements.parenthetical.caps, true);
  assert.equal(style.elements.action.caps, true);
  assert.equal(style.elements.sceneHeading.underline, true);
  assert.equal(style.returns.dialogue, "character");

  const xml = writeFdx(templateScript("multiCamera"));
  assert.match(elementBlock(xml, "Dialogue"), /Spacing="2"/);
  assert.match(elementBlock(xml, "Action"), /AllCaps/);
  assert.match(elementBlock(xml, "Scene Heading"), /Underline/);

  const script: Script = { titlePage: [], template: "multiCamera", paragraphs: [
    spec("newAct", "ACT ONE", 0), spec("sceneHeading", "INT. APARTMENT - NIGHT", 1), spec("action", "MAYA ENTERS.", 2),
    spec("sceneHeading", "INT. KITCHEN - NIGHT", 3), spec("action", "The kettle boils.", 4),
  ] };
  const result = paginate(script, scriptPaginationOptions(script));
  // ACT ONE and its first scene share page 1; the second scene starts page 2.
  assert.equal(pageOf(result, "p1"), 0);
  assert.equal(pageOf(result, "p3"), 1);
  // Plain pagination reads the same rule, so reports and scene lengths agree with printing.
  assert.equal(pageOf(paginate(script), "p3"), 1);

  const round = parseFdx(writeFdx(script));
  assert.equal(round.paragraphs.find((part) => part.id === "p3")?.startsNewPage, true);
  assert.equal(round.paragraphs.find((part) => part.id === "p1")?.startsNewPage, undefined);
});

test("the stage template centers names and scene headings, widens dialogue and indents italic directions", () => {
  const style = templateStyle("stage");
  assert.equal(style.elements.character.align, "center");
  assert.deepEqual([style.elements.dialogue.left, style.elements.dialogue.right], [1.5, 7.0]);
  assert.equal(style.elements.action.italic, true);
  assert.ok(style.elements.action.left > style.elements.dialogue.left);
  assert.equal(style.elements.sceneHeading.align, "center");
  assert.equal(style.elements.newAct.bold, false);
  assert.equal(style.returns.dialogue, "character");

  const xml = writeFdx(templateScript("stage"));
  assert.match(elementBlock(xml, "Character"), /Alignment="Center"/);
  assert.match(elementBlock(xml, "Action"), /Italic/);
  assert.match(elementBlock(xml, "Scene Heading"), /Alignment="Center"/);

  const parts = templateParagraphs("stage");
  assert.deepEqual(parts.map((part) => [part.type, plainText(part.runs)]), [["newAct", "ACT ONE"], ["sceneHeading", "SCENE 1"]]);

  const script: Script = { titlePage: [], template: "stage", paragraphs: [
    spec("newAct", "ACT ONE", 0), spec("sceneHeading", "SCENE 1", 1), spec("action", "A kitchen at night.", 2),
    spec("newAct", "ACT TWO", 3), spec("sceneHeading", "SCENE 1", 4),
  ] };
  const result = paginate(script, scriptPaginationOptions(script));
  assert.equal(pageOf(result, "p3"), 1);
  assert.equal(pageOf(result, "p4"), 1);
});

test("new template scripts begin with their act structure", () => {
  const texts = (id: TemplateId) => templateParagraphs(id).map((part) => `${part.type}:${plainText(part.runs)}`);
  assert.deepEqual(texts("oneHourDrama").slice(0, 3), ["newAct:TEASER", "sceneHeading:", "endOfAct:END OF TEASER"]);
  assert.ok(texts("oneHourDrama").includes("newAct:ACT FIVE"));
  assert.deepEqual(texts("multiCamera").filter((line) => line.startsWith("newAct:")), ["newAct:COLD OPEN", "newAct:ACT ONE", "newAct:ACT TWO", "newAct:TAG"]);
  assert.equal(templateScript("oneHourDrama").template, "oneHourDrama");
  assert.equal(templateScript("feature").paragraphs.length, 1);
});

test("multi-camera Number Scenes letters scenes and keeps the alphabet when numbers are locked", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], template: "multiCamera", paragraphs: [
    spec("sceneHeading", "INT. A - DAY", 0), spec("sceneHeading", "INT. B - DAY", 1), spec("sceneHeading", "INT. C - DAY", 2),
  ] });
  numberScenes(doc);
  assert.deepEqual(doc.paragraphs().filter((part) => part.type === "sceneHeading").map((part) => part.sceneNumber), ["A", "B", "C"]);
  assert.equal(doc.toScript().template, "multiCamera");

  const wide = ScreenplayDoc.fromScript({ titlePage: [], template: "multiCamera", paragraphs: Array.from({ length: 28 }, (_, index) => spec("sceneHeading", `INT. ${index} - DAY`, index)) });
  numberScenes(wide);
  assert.deepEqual(wide.paragraphs().filter((part) => part.type === "sceneHeading").slice(-2).map((part) => part.sceneNumber), ["AA", "AB"]);
  wide.ydoc.destroy();

  // A scene added between B and C while numbers are locked takes a label between them.
  const locked = ScreenplayDoc.fromScript({ titlePage: [], template: "multiCamera", paragraphs: [
    spec("sceneHeading", "INT. A - DAY", 0), spec("sceneHeading", "INT. B - DAY", 1), spec("sceneHeading", "INT. C - DAY", 2),
  ] });
  numberScenes(locked);
  setSceneNumbersLocked(locked, true);
  locked.insertParagraph(2, { type: "sceneHeading", sceneId: "added", runs: [{ text: "INT. NEW - DAY" }] });
  numberScenes(locked);
  assert.deepEqual(locked.paragraphs().filter((part) => part.type === "sceneHeading").map((part) => part.sceneNumber), ["A", "B", "BA", "C"]);
  locked.ydoc.destroy();
  doc.ydoc.destroy();
});

test("applying a template keeps the words and underlines multi-camera entrances in one edit", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    spec("action", "MAYA ENTERS THE ROOM AND DROPS HER BAG.", 0),
    spec("action", "The coffee is cold.", 1),
    spec("character", "MAYA", 2), spec("dialogue", "Hello.", 3),
  ] });
  applyDocumentTemplate(doc, "multiCamera");
  const script = doc.toScript();
  assert.equal(script.template, "multiCamera");
  assert.deepEqual(script.paragraphs.map((part) => plainText(part.runs)), [
    "MAYA ENTERS THE ROOM AND DROPS HER BAG.", "The coffee is cold.", "MAYA", "Hello.",
  ]);
  assert.deepEqual(script.paragraphs[0]!.runs.map((run) => [run.text, run.underline === true]), [["MAYA ENTERS", true], [" THE ROOM AND DROPS HER BAG.", false]]);
  assert.equal(script.paragraphs[1]!.runs.some((run) => run.underline), false);
  assert.match(writeFdx(script), /<ElementSettings Type="Dialogue"[\s\S]*?Spacing="2"/);
  doc.ydoc.destroy();
});

test("stage directions can be put in parentheses without changing their words", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    spec("action", "A kitchen at night. The kettle boils.", 0),
    spec("action", "(The door opens.)", 1),
  ] });
  applyDocumentTemplate(doc, "stage", { parenthesizeStageDirections: true });
  const text = doc.paragraphs().map((part) => plainText(part.runs));
  assert.deepEqual(text, ["(A kitchen at night. The kettle boils.)", "(The door opens.)"]);
  doc.ydoc.destroy();
});

test("entrance and exit ranges cover who moves and the verb, not the rest of the sentence", () => {
  assert.deepEqual(entranceRanges("MAYA ENTERS. The room is empty. BOB EXITS.", ["MAYA", "BOB"]), [[0, 11], [32, 41]]);
  const text = "Rain against the glass. MAYA ENTERS, soaked, and slides in.";
  assert.deepEqual(entranceRanges(text, ["MAYA"]).map(([a, b]) => text.slice(a, b)), ["MAYA ENTERS"]);
  const pair = "MAYA AND ELI exit through the kitchen.";
  assert.deepEqual(entranceRanges(pair, ["MAYA", "ELI"]).map(([a, b]) => pair.slice(a, b)), ["MAYA AND ELI exit"]);
  const exiting = "She is exiting when the phone rings.";
  assert.deepEqual(entranceRanges(exiting).map(([a, b]) => exiting.slice(a, b)), ["She is exiting"]);
  assert.deepEqual(entranceRanges("The exit sign flickers."), []);
  assert.deepEqual(entranceRanges("Nobody moves."), []);
});

test("FDX page breaks cover acts and multi-camera scenes but not the scene under an act heading", () => {
  const paragraphs = [
    { id: "act", type: "newAct" as const },
    { id: "first", type: "sceneHeading" as const },
    { id: "second", type: "sceneHeading" as const },
    { id: "act2", type: "newAct" as const },
    { id: "third", type: "sceneHeading" as const },
  ];
  assert.deepEqual([...templatePageBreaks(paragraphs, "multiCamera")], ["act", "second", "act2"]);
  assert.deepEqual([...templatePageBreaks(paragraphs, "oneHourDrama")], ["act", "act2"]);
  assert.deepEqual([...templatePageBreaks(paragraphs, undefined)], []);
});

test("an underlined entrance in capitalized multi-camera action stays in capitals in Final Draft", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [spec("action", "Rain falls. MAYA ENTERS, soaked.", 0), spec("character", "MAYA", 1)] });
  applyDocumentTemplate(doc, "multiCamera");
  const xml = writeFdx(doc.toScript());
  // Final Draft drops ElementSettings AllCaps on a run with its own Style, so the run must repeat it.
  assert.match(xml, /<Text Style="Underline\+AllCaps">MAYA ENTERS<\/Text>/);
  assert.match(xml, /<Text>Rain falls\. <\/Text>/);
});


test("screenplay templates keep Action on Return and performance templates keep Character", () => {
  for (const id of ["feature", "oneHourDrama", "halfHourComedy", "multiCamera", "stage"] as const) {
    const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [spec("action", "He waits.", 0)] });
    applyDocumentTemplate(doc, id);
    assert.equal(returnKeyFlow(doc.toScript()).action, id === "multiCamera" || id === "stage" ? "character" : "action", id);
    doc.ydoc.destroy();
  }
});

test("stage parentheses print around directions with inline notes and leave note-only paragraphs alone", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "direction", type: "action", runs: [{ text: "The door opens." }, { text: "Check prop", note: true }] },
    { id: "notes", type: "action", runs: [{ text: "Private note", note: true }] },
    { id: "wrapped", type: "action", runs: [{ text: "(Already wrapped.)" }, { text: "Another note", note: true }] },
  ] });
  applyDocumentTemplate(doc, "stage", { parenthesizeStageDirections: true });
  const script = doc.toScript();
  const visible = (part: Paragraph) => plainText(part.runs.filter((run) => !run.note));
  assert.deepEqual(script.paragraphs.map(visible), ["(The door opens.)", "", "(Already wrapped.)"]);
  assert.deepEqual(script.paragraphs[1]!.runs, [{ text: "Private note", note: true }]);
  assert.deepEqual(script.paragraphs[0]!.runs.filter((run) => run.note), [{ text: "Check prop", note: true }]);
  assert.equal(plainText(parseFdx(writeFdx(script)).paragraphs[0]!.runs), "(The door opens.)");
  const printed = paginate(script, scriptPaginationOptions(script)).pages.flatMap((page) => page.lines).map((line) => plainText(line.runs)).join("");
  assert.ok(printed.includes("(The door opens.)"));
  doc.ydoc.destroy();
});

test("multi-camera entrances underline known names and first entrances, and reject exit sign nouns", () => {
  const actions = ["THE EXIT SIGN FLICKERS.", "STRANGER ENTERS.", "MAYA ENTERS.", "MAYA AND ELI EXIT.",
    "MAYA AND STRANGER EXIT.", "She is exiting when the phone rings.", "MAYA EXIT SIGN FLICKERS.", "SIGN EXITS.", "A ENTERS.", "MAYA & ELI EXIT.", "MARY JANE ENTERS."];
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    ...actions.map((text, index) => spec("action", text, index)),
    spec("character", "  Maya (V.O.)  ", 20), spec("character", "ELI (CONT'D)", 21), spec("character", "SIGN", 22), spec("character", "Mary Jane (O.S.)", 23),
  ] });
  applyDocumentTemplate(doc, "multiCamera");
  assert.deepEqual(doc.paragraphs().slice(0, actions.length).map((part) => part.runs.filter((run) => run.underline).map((run) => run.text).join("")),
    ["", "STRANGER ENTERS", "MAYA ENTERS", "MAYA AND ELI EXIT", "MAYA AND STRANGER EXIT", "She is exiting", "", "SIGN EXITS", "", "MAYA & ELI EXIT", "MARY JANE ENTERS"]);
  doc.ydoc.destroy();
});

test("an entrance after capitalized prose still underlines the known name and the verb", () => {
  for (const text of ["SUDDENLY MAYA ENTERS.", "THE DOOR OPENS AND MAYA ENTERS.", "THE DOOR OPENS. MAYA AND ELI EXIT."]) {
    const ranges = entranceRanges(text, ["MAYA", "ELI (V.O.)"]).map(([a, b]) => text.slice(a, b));
    assert.deepEqual(ranges, [text.includes("EXIT") ? "MAYA AND ELI EXIT" : "MAYA ENTERS"], text);
  }
  assert.deepEqual(entranceRanges("THE EXIT SIGN FLICKERS.", ["MAYA"]), []);
});

test("a first entrance underlines the capitalized name before the verb, never a pronoun or the prose before it", () => {
  const cases: [string, string[]][] = [["MARY enters with the mail.", ["MARY enters"]], ["THE DOOR OPENS AND MARY ENTERS.", ["MARY ENTERS"]],
    ["HE ENTERS.", []], ["THEY EXIT.", []], ["WE HEAR THE EXIT SIGN BUZZ.", []], ["THE FIRE EXIT IS LOCKED.", []],
    ["MAYA MOVES TOWARD THE EMERGENCY EXIT.", []], ["THE DOOR EXITS ITS TRACK.", []],
    ["THE SOUND OF TRAFFIC ENTERS THROUGH THE OPEN WINDOW.", []], ["The DOOR exits its track.", []],
    ["THE BROKEN DOOR EXITS ITS TRACK.", []], ["THE SOUND OF LOUD TRAFFIC ENTERS THROUGH THE WINDOW.", []],
    ["AS THE LIGHTS DIM, MARY ENTERS.", ["MARY ENTERS"]], ["SUDDENLY MARY ENTERS.", ["MARY ENTERS"]],
    ["WE HEAR HER BEFORE MARY ENTERS.", ["MARY ENTERS"]]];
  for (const [text, expected] of cases) assert.deepEqual(entranceRanges(text, []).map(([a, b]) => text.slice(a, b)), expected, text);
});

test("TV templates list one starting scene, with an empty line in each later act", () => {
  for (const id of ["oneHourDrama", "halfHourComedy", "multiCamera"] as const) {
    const parts = templateParagraphs(id);
    assert.equal(parts.filter((part) => part.type === "sceneHeading").length, 1, id);
    assert.equal(parts.filter((part) => part.type === "newAct").length, parts.filter((part) => part.type === "endOfAct").length, id);
  }
});

test("a known multi-word cue joined by AND comes along with a first entrance", () => {
  const text = "MARY JANE AND STRANGER EXIT.";
  assert.deepEqual(entranceRanges(text, ["MARY JANE"]).map(([a, b]) => text.slice(a, b)), ["MARY JANE AND STRANGER EXIT"]);
  const long = "THE MAN IN BLACK AND STRANGER EXIT.";
  assert.deepEqual(entranceRanges(long, ["THE MAN IN BLACK"]).map(([a, b]) => long.slice(a, b)), ["THE MAN IN BLACK AND STRANGER EXIT"]);
});
