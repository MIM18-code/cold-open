import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import { ScreenplayDoc, moveScene, parseFountain, plainText, type Paragraph } from "../src/index.ts";

const SAMPLE = "INT. OFFICE - DAY\n\nNell waits.\n\nNELL\nWell?\n\nEXT. YARD - NIGHT\n\nRain.\n";

/** Two replicas that exchange every update, like peers on a live sync. */
function pair() {
  const a = ScreenplayDoc.fromScript(parseFountain(SAMPLE));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const sync = () => {
    a.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
    b.applyUpdate(Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
  };
  return { a, b, sync };
}

const rows = (doc: ScreenplayDoc) => doc.toScript().paragraphs.map((p) => [p.type, plainText(p.runs)]);

test("loads a script and reports scenes with stable IDs", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SAMPLE));
  const scenes = doc.scenes();
  assert.deepEqual(scenes.map((s) => s.heading), ["INT. OFFICE - DAY", "EXT. YARD - NIGHT"]);
  assert.equal(scenes[0]!.sceneId, scenes[0]!.headingId);
  assert.equal(scenes[0]!.paragraphIds.length, 4);
  assert.deepEqual(doc.validate(), []);
});

test("concurrent edits from two writers merge and keep every ID", () => {
  const { a, b, sync } = pair();
  const before = a.toScript().paragraphs.map((p) => p.id);
  const [office, yard] = a.scenes();
  // Writer A types into the first scene while writer B adds a line to the second.
  a.insertText(before[1]!, "Nell waits".length, " by the window");
  b.insertParagraph(b.indexOf(yard!.headingId) + 2, { type: "action", runs: [{ text: "Thunder." }] });
  b.insertText(before[1]!, 0, "Still, ");
  sync();
  assert.deepEqual(rows(a), rows(b));
  assert.equal(plainText(a.paragraph(before[1]!).runs), "Still, Nell waits by the window.");
  const after = a.toScript().paragraphs.map((p) => p.id);
  assert.ok(before.every((id) => after.includes(id)));
  assert.deepEqual(a.scenes().map((s) => s.sceneId), [office!.sceneId, yard!.sceneId]);
  assert.deepEqual(a.validate(), []);
});

test("a new scene heading splits a scene without moving any paragraph", () => {
  const { a, b, sync } = pair();
  const rain = a.toScript().paragraphs.at(-1)!.id;
  const nell = a.toScript().paragraphs[2]!.id;
  const heading = a.insertParagraph(a.indexOf(nell), { type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] });
  b.insertText(nell, 4, " (OS)");
  sync();
  assert.deepEqual(a.scenes().map((s) => s.heading), ["INT. OFFICE - DAY", "INT. HALL - DAY", "EXT. YARD - NIGHT"]);
  assert.equal(a.scenes()[1]!.sceneId, heading);
  assert.equal(plainText(b.paragraph(nell).runs), "NELL (OS)");
  assert.equal(a.indexOf(rain), b.indexOf(rain));
});

test("split and merge keep the ID with the text that stays", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SAMPLE));
  const action = doc.toScript().paragraphs[1]!.id;
  doc.format(action, 0, 4, { bold: true });
  const tail = doc.splitParagraph(action, 5);
  assert.deepEqual(doc.paragraph(action).runs, [{ text: "Nell", bold: true }, { text: " " }]);
  assert.deepEqual(doc.paragraph(tail).runs, [{ text: "waits." }]);
  assert.equal(doc.mergeWithPrevious(tail), action);
  assert.deepEqual(doc.paragraph(action).runs, [{ text: "Nell", bold: true }, { text: " waits." }]);

  // Return at the start of a heading opens a line above; the heading keeps its ID and scene.
  const [scene] = doc.scenes();
  const above = doc.splitParagraph(scene!.headingId, 0, "action");
  assert.equal(doc.indexOf(above), 0);
  assert.equal(plainText(doc.paragraph(scene!.headingId).runs), "INT. OFFICE - DAY");
  // Backspace from the heading into that empty line removes the empty line instead.
  assert.equal(doc.mergeWithPrevious(scene!.headingId), scene!.headingId);
  assert.equal(doc.indexOf(scene!.headingId), 0);
});

test("retyping a heading keeps its scene ID for when it comes back", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SAMPLE));
  const [, yard] = doc.scenes();
  doc.setType(yard!.headingId, "action");
  assert.equal(doc.scenes().length, 1);
  doc.setType(yard!.headingId, "sceneHeading");
  assert.equal(doc.scenes()[1]!.sceneId, yard!.sceneId);
});

test("formatting runs survive the CRDT unchanged", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SAMPLE));
  const id = doc.toScript().paragraphs[1]!.id;
  doc.setField(id, "alignment", "Center");
  doc.insertText(id, 0, "Quietly: ", { italic: true });
  doc.format(id, 0, 7, { italic: false, underline: true });
  const copy = ScreenplayDoc.fromUpdate(doc.encodeState());
  assert.deepEqual(copy.paragraph(id).runs, [
    { text: "Quietly", underline: true }, { text: ": ", italic: true }, { text: "Nell waits." },
  ]);
  assert.equal(copy.paragraph(id).alignment, "Center");
});

test("validate catches duplicate IDs written by a buggy peer", () => {
  const doc = new ScreenplayDoc(new Y.Doc(), { repair: false });
  doc.load(parseFountain(SAMPLE));
  const first = doc.toScript().paragraphs[0]!;
  doc.insertParagraph(1, { ...first, id: first.id });
  assert.match(doc.validate().join("\n"), /repeats ID/);
});

test("a repeated paragraph ID gets a new ID by itself, and both copies keep their text", () => {
  const ydoc = new Y.Doc();
  ydoc.clientID = 7;
  const doc = ScreenplayDoc.fromScript(parseFountain(SAMPLE), ydoc);
  const [heading, action] = doc.toScript().paragraphs;
  let observed = 0;
  doc.body.observe(() => observed++);
  const reports: unknown[] = [];
  doc.onRepair((report) => reports.push(report));
  doc.insertParagraph(4, { ...action!, runs: [{ text: "A stray copy." }] });
  assert.deepEqual(doc.validate(), []);
  assert.deepEqual(rows(doc), [
    ["sceneHeading", "INT. OFFICE - DAY"], ["action", "Nell waits."], ["character", "NELL"], ["dialogue", "Well?"],
    ["action", "A stray copy."], ["sceneHeading", "EXT. YARD - NIGHT"], ["action", "Rain."],
  ]);
  // The first copy keeps the ID; the later one takes an ID made from its own line break.
  assert.equal(doc.paragraph(action!.id).runs[0]!.text, "Nell waits.");
  const copy = doc.toScript().paragraphs[4]!;
  assert.match(copy.id, /^y7-\d+$/);
  assert.equal(copy.type, "action");
  // The insert and the repair: two transactions, so views see the new ID.
  assert.equal(observed, 2);
  assert.deepEqual(reports, [{ copies: [copy.id], headings: [], missing: 0 }]);
  // A heading copy before the original keeps the ID instead (the first one in the text does, on every peer), and
  // the original takes a new ID and the same as its scene ID.
  doc.insertParagraph(0, { ...heading!, runs: [{ text: "EXT. EARLIER - DAY" }] });
  const [first, second] = doc.toScript().paragraphs;
  assert.deepEqual([plainText(first!.runs), first!.id, first!.sceneId], ["EXT. EARLIER - DAY", heading!.id, heading!.id]);
  assert.deepEqual([plainText(second!.runs), second!.sceneId, /^y7-/.test(second!.id)], ["INT. OFFICE - DAY", second!.id, true]);
  assert.deepEqual(doc.validate(), []);
  assert.deepEqual((reports[1] as { headings: string[] }).headings, ["INT. OFFICE - DAY"]);
  // Typing never pays for the check.
  assert.equal(doc.repairDuplicates(), 0);
});

test("every peer makes the same new IDs, and a line break that lost its ID gets one", () => {
  const { a, b, sync } = pair();
  const action = a.toScript().paragraphs[1]!;
  a.insertParagraph(5, { ...action, runs: [{ text: "Copy from A." }] });
  // B repairs the copy itself before hearing A's repair: same IDs, so they converge.
  b.applyUpdate(Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)), "remote");
  assert.deepEqual(b.toScript().paragraphs.map((p) => p.id), a.toScript().paragraphs.map((p) => p.id));
  sync();
  assert.deepEqual(b.toScript(), a.toScript());
  // A bare line break (a restored one whose attributes did not come back) gets a type-less paragraph with an ID.
  const length = a.body.length;
  a.body.insert(length, "\nLoose text.");
  const last = a.toScript().paragraphs.at(-1)!;
  assert.match(last.id, /^y\d+-\d+$/);
  assert.equal(plainText(last.runs), "Loose text.");
  assert.deepEqual(a.validate(), []);
  sync();
  assert.deepEqual(b.toScript(), a.toScript());
});

test("a paragraph with no ID can still be read on a copy that leaves repairs to others", () => {
  // A read-only follower draws a restored line break without an ID until a writer's repair arrives; its caret
  // there asks for the paragraph by its empty ID.
  const doc = new ScreenplayDoc(new Y.Doc(), { repair: false });
  doc.load(parseFountain(SAMPLE));
  doc.body.insert(doc.body.length, "\nLoose text.");
  const last = doc.toScript().paragraphs.length - 1;
  assert.equal(doc.toScript().paragraphs[last]!.id, "");
  assert.equal(doc.indexOf(""), last);
  assert.equal(plainText(doc.paragraph("").runs), "Loose text.");
  assert.match(doc.validate().join("\n"), /has no ID/);
  // Turning repairs on gives it an ID.
  doc.setRepairs(true);
  assert.deepEqual(doc.validate(), []);
  assert.equal(doc.has(""), false);
});

test("replaceText keeps the formatting of the text it replaces, also at offset zero", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "a", type: "action", runs: [
    { text: "teh", bold: true }, { text: " cat sat on " }, { text: "teh", italic: true, fdx: { Font: "Courier Final Draft" } }, { text: " mat." },
  ] }] });
  doc.replaceText("a", 0, 3, "the");
  doc.replaceText("a", 15, 18, "the");
  assert.deepEqual(doc.paragraph("a").runs, [
    { text: "the", bold: true }, { text: " cat sat on " }, { text: "the", italic: true, fdx: { Font: "Courier Final Draft" } }, { text: " mat." },
  ]);
  // A longer or shorter replacement keeps it too; an empty range is an insert that continues the text before it.
  doc.replaceText("a", 0, 3, "That");
  doc.replaceText("a", 4, 4, "!");
  assert.deepEqual(doc.paragraph("a").runs.slice(0, 2), [{ text: "That!", bold: true }, { text: " cat sat on " }]);
  const copy = ScreenplayDoc.fromUpdate(doc.encodeState());
  assert.deepEqual(copy.paragraph("a").runs, doc.paragraph("a").runs);
});

test("formatRuns sets FDX run attributes and patches the paragraph list instead of re-reading it", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SAMPLE));
  const [, action, , dialogue] = doc.toScript().paragraphs;
  const before = doc.paragraphs();
  let reads = 0;
  const toDelta = doc.body.toDelta.bind(doc.body);
  doc.body.toDelta = (...args: Parameters<Y.Text["toDelta"]>) => (reads++, toDelta(...args));
  doc.formatRuns(action!.id, 5, 5, { "fdx:RevisionID": "2" });
  doc.formatRuns(dialogue!.id, 0, 5, { bold: true });
  assert.equal(reads, 0);
  assert.deepEqual(doc.paragraph(action!.id).runs, [{ text: "Nell " }, { text: "waits", fdx: { RevisionID: "2" } }, { text: "." }]);
  assert.equal(doc.paragraphs()[0], before[0]);
  doc.formatRuns(action!.id, 0, 11, { "fdx:RevisionID": null });
  assert.deepEqual(doc.paragraph(action!.id).runs, [{ text: "Nell waits." }]);
  doc.body.toDelta = toDelta;
  // The patched list matches a fresh read.
  assert.deepEqual(ScreenplayDoc.fromUpdate(doc.encodeState()).toScript().paragraphs, doc.toScript().paragraphs);
});

test("joining paragraphs keeps a co-writer's concurrent typing", () => {
  const a = ScreenplayDoc.fromScript(parseFountain("First.\n\nSecond.\n"));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const [first, second] = a.toScript().paragraphs.map((p) => p.id);
  assert.equal(a.mergeWithPrevious(second!), first);
  b.insertText(second!, "Second.".length, " NEW");
  a.applyUpdate(b.encodeState());
  b.applyUpdate(a.encodeState());
  assert.deepEqual(rows(a), [["action", "First.Second. NEW"]]);
  assert.deepEqual(rows(b), rows(a));
  assert.equal(a.toScript().paragraphs[0]!.id, first);
});

test("splitting a paragraph keeps a co-writer's concurrent typing in the tail", () => {
  const a = ScreenplayDoc.fromScript(parseFountain("Nell waits. Rain falls.\n"));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const [id] = a.toScript().paragraphs.map((p) => p.id);
  const tail = a.splitParagraph(id!, "Nell waits. ".length);
  b.insertText(id!, "Nell waits. Rain falls".length, " hard");
  a.applyUpdate(b.encodeState());
  b.applyUpdate(a.encodeState());
  assert.deepEqual(rows(a), [["action", "Nell waits. "], ["action", "Rain falls hard."]]);
  assert.deepEqual(rows(b), rows(a));
  assert.deepEqual(a.toScript().paragraphs.map((p) => p.id), [id, tail]);
});

test("line breaks inside a paragraph stay inside it", () => {
  const script = parseFountain("NELL\nOne line.\nAnother line.\n");
  const doc = ScreenplayDoc.fromScript(script);
  assert.equal(plainText(doc.toScript().paragraphs[1]!.runs), "One line.\nAnother line.");
  assert.equal(doc.toScript().paragraphs.length, 2);
  const id = doc.toScript().paragraphs[1]!.id;
  doc.insertText(id, 0, "Typed\nline, and a literal \u2028. ");
  assert.equal(plainText(doc.paragraph(id).runs), "Typed\nline, and a literal \u2028. One line.\nAnother line.");
  assert.equal(doc.toScript().paragraphs.length, 2);
});

/** Run one edit on each of two replicas, then exchange updates. */
function concurrently(source: string, left: (doc: ScreenplayDoc, ids: string[]) => void, right: (doc: ScreenplayDoc, ids: string[]) => void) {
  const a = ScreenplayDoc.fromScript(parseFountain(source));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const ids = a.toScript().paragraphs.map((p) => p.id);
  left(a, ids);
  right(b, ids);
  a.applyUpdate(b.encodeState());
  b.applyUpdate(a.encodeState());
  assert.deepEqual(rows(a), rows(b));
  assert.deepEqual(a.validate(), []);
  return { a, ids };
}

test("two writers splitting one paragraph get distinct IDs", () => {
  const { a, ids } = concurrently("abcdefghi\n", (d, [p]) => d.splitParagraph(p!, 3), (d, [p]) => d.splitParagraph(p!, 6));
  assert.deepEqual(rows(a).map(([, text]) => text), ["abc", "def", "ghi"]);
  assert.equal(a.toScript().paragraphs[0]!.id, ids[0]);
});

test("a split racing a join keeps IDs unique", () => {
  const { a, ids } = concurrently("First.\n\nSecond half.\n", (d, [, p]) => d.mergeWithPrevious(p!), (d, [, p]) => d.splitParagraph(p!, 7));
  assert.deepEqual(rows(a).map(([, text]) => text), ["First.Second ", "half."]);
  assert.equal(a.toScript().paragraphs[0]!.id, ids[0]);
});

test("joining neighbouring pairs at once keeps the first paragraph", () => {
  const { a, ids } = concurrently("INT. A - DAY\n\nOne.\n\nTwo.\n", (d, [, p]) => d.mergeWithPrevious(p!), (d, [, , p]) => d.mergeWithPrevious(p!));
  assert.deepEqual(rows(a), [["sceneHeading", "INT. A - DAYOne.Two."]]);
  assert.equal(a.toScript().paragraphs[0]!.id, ids[0]);
});

test("typing in an empty first paragraph while it is removed lands in the next one", () => {
  const { a, ids } = concurrently("!\n\nINT. A - DAY\n", (d, [, q]) => d.mergeWithPrevious(q!), (d, [p]) => d.insertText(p!, 0, "NEW "));
  assert.deepEqual(rows(a), [["sceneHeading", "NEW INT. A - DAY"]]);
  assert.equal(a.toScript().paragraphs[0]!.id, ids[1]);
});

test("edits in a first paragraph with text before its line break keep the paragraph list true to the document", () => {
  const { a, ids } = concurrently("!\n\nINT. A - DAY\n", (d, [, q]) => d.mergeWithPrevious(q!), (d, [p]) => d.insertText(p!, 0, "NEW "));
  const id = ids[1]!;
  const fresh = () => ScreenplayDoc.fromUpdate(a.encodeState()).toScript().paragraphs.map((p) => plainText(p.runs));
  a.insertText(id, 2, "Z");
  assert.deepEqual(rows(a).map(([, text]) => text), fresh());
  a.deleteText(id, 1, 2);
  assert.deepEqual(rows(a).map(([, text]) => text), fresh());
  a.format(id, 0, 3, { bold: true });
  assert.deepEqual(a.toScript().paragraphs, ScreenplayDoc.fromUpdate(a.encodeState()).toScript().paragraphs);
  a.replaceText(id, 0, 2, "Q");
  assert.deepEqual(a.toScript().paragraphs, ScreenplayDoc.fromUpdate(a.encodeState()).toScript().paragraphs);
  assert.deepEqual(a.validate(), []);
});

test("Find and Replace in a first paragraph that a co-writer's typing left text before replaces what is shown", () => {
  // The final review's case: A moves the first scene to the end while B types at the start of its heading.
  const { a } = concurrently(
    "INT. KITCHEN - DAY\n\nNell pours coffee.\n\nEXT. YARD - DAY\n\nThe dog barks at the mailman.\n",
    (d, [, , yard]) => {
      // moveScene's effect on the body: the scene's text is deleted and a copy goes to the end.
      const { end } = d.range(d.toScript().paragraphs[1]!.id);
      const copy = d.toScript().paragraphs.slice(0, 2);
      d.body.delete(0, end);
      d.insertParagraph(d.paragraphs().length, { ...copy[0]!, id: "kitchen" });
      d.insertParagraph(d.paragraphs().length, { ...copy[1]!, id: "nell" });
      assert.equal(d.indexOf(yard!), 0);
    },
    (d, [kitchen]) => d.insertText(kitchen!, 0, "BIG "),
  );
  assert.equal(a.lead(), 4);
  const first = a.toScript().paragraphs[0]!;
  const shown = plainText(first.runs);
  assert.equal(shown, "BIG EXT. YARD - DAY");
  const from = shown.indexOf("YARD");
  a.replaceText(first.id, from, from + 4, "FIELD");
  assert.equal(plainText(a.paragraph(first.id).runs), "BIG EXT. FIELD - DAY");
  assert.deepEqual(a.toScript().paragraphs, ScreenplayDoc.fromUpdate(a.encodeState()).toScript().paragraphs);
});

/** A script whose first paragraph has `lead` before its line break, as a co-writer's typing can leave it. */
function withLead(source: string, lead: string, bold = false): { doc: ScreenplayDoc; ids: string[] } {
  const doc = ScreenplayDoc.fromScript(parseFountain(source));
  doc.body.insert(0, lead, bold ? { bold: true } : {});
  assert.equal(doc.lead(), lead.length);
  return { doc, ids: doc.toScript().paragraphs.map((p) => p.id) };
}

test("every text offset in a first paragraph with text before its line break counts that text as it is shown", () => {
  const source = "INT. A - DAY\n\nTwo.\n";
  const shown = "NEW INT. A - DAY";
  const same = (doc: ScreenplayDoc, label: string) => {
    assert.deepEqual(doc.toScript().paragraphs, ScreenplayDoc.fromUpdate(doc.encodeState()).toScript().paragraphs, label);
    assert.deepEqual(doc.validate(), [], label);
  };
  for (let from = 0; from <= shown.length; from++) {
    // The caret maps to the body and back.
    const { doc, ids } = withLead(source, "NEW ");
    const at = { paragraphId: ids[0]!, offset: from };
    assert.deepEqual(doc.positionAt(doc.bodyIndex(at)), at, `offset ${from}`);
    // Typing goes where the caret is shown.
    doc.insertText(ids[0]!, from, "Z");
    assert.equal(plainText(doc.paragraph(ids[0]!).runs), shown.slice(0, from) + "Z" + shown.slice(from), `insert at ${from}`);
    same(doc, `insert at ${from}`);
    for (let to = from + 1; to <= shown.length; to++) {
      const label = `${from}-${to}`;
      const expected = shown.slice(0, from) + shown.slice(to);
      const deleting = withLead(source, "NEW ");
      deleting.doc.deleteText(deleting.ids[0]!, from, to - from);
      assert.equal(plainText(deleting.doc.paragraph(deleting.ids[0]!).runs), expected, `delete ${label}`);
      same(deleting.doc, `delete ${label}`);
      const replacing = withLead(source, "NEW ");
      replacing.doc.replaceText(replacing.ids[0]!, from, to, "Q");
      assert.equal(plainText(replacing.doc.paragraph(replacing.ids[0]!).runs), shown.slice(0, from) + "Q" + shown.slice(to), `replace ${label}`);
      same(replacing.doc, `replace ${label}`);
      const formatting = withLead(source, "NEW ");
      formatting.doc.format(formatting.ids[0]!, from, to - from, { bold: true });
      const bold = formatting.doc.paragraph(formatting.ids[0]!).runs.filter((run) => run.bold).map((run) => run.text).join("");
      assert.equal(bold, shown.slice(from, to), `bold ${label}`);
      same(formatting.doc, `bold ${label}`);
      // Deleting from here to inside the next paragraph keeps the first paragraph's ID and type.
      const across = withLead(source, "NEW ");
      across.doc.deleteRange({ paragraphId: across.ids[0]!, offset: from }, { paragraphId: across.ids[1]!, offset: 2 });
      assert.deepEqual(rows(across.doc), [["sceneHeading", shown.slice(0, from) + "o."]], `deleteRange ${label}`);
      assert.equal(across.doc.toScript().paragraphs[0]!.id, across.ids[0], `deleteRange ${label}`);
      same(across.doc, `deleteRange ${label}`);
    }
  }
});

test("Return, paste and new paragraphs in a first paragraph with text before its line break split it where it is shown", () => {
  const source = "INT. A - DAY\n\nTwo.\n";
  const shown = "NEW INT. A - DAY";
  for (let offset = 0; offset <= shown.length; offset++) {
    const { doc, ids } = withLead(source, "NEW ", true);
    const created = doc.splitParagraph(ids[0]!, offset);
    const expected = offset === 0 ? ["", shown] : [shown.slice(0, offset), shown.slice(offset)];
    assert.deepEqual(rows(doc).map(([, text]) => text), [...expected, "Two."], `split at ${offset}`);
    // The text before the split keeps the paragraph (at 0, the text itself keeps it).
    assert.equal(doc.indexOf(ids[0]!), offset === 0 ? 1 : 0, `split at ${offset}`);
    assert.equal(doc.indexOf(created), offset === 0 ? 0 : 1, `split at ${offset}`);
    // The text keeps its formatting.
    assert.deepEqual(doc.toScript().paragraphs.flatMap((p) => p.runs).filter((run) => run.bold).map((run) => run.text).join(""), "NEW ");
    assert.deepEqual(doc.validate(), []);
    // A split after the lead leaves the lead where it is.
    assert.equal(doc.lead(), offset <= 4 ? 0 : 4, `split at ${offset}`);

    const pasting = withLead(source, "NEW ");
    pasting.doc.insertParagraphsAt({ paragraphId: pasting.ids[0]!, offset }, [{ id: "x", type: "action", runs: [{ text: "Pasted." }] }]);
    const pasted = offset === 0 ? ["Pasted.", shown] : offset === shown.length ? [shown, "Pasted."] : [shown.slice(0, offset), "Pasted.", shown.slice(offset)];
    assert.deepEqual(rows(pasting.doc).map(([, text]) => text), [...pasted, "Two."], `paste at ${offset}`);
    assert.deepEqual(pasting.doc.validate(), []);
  }
  // A paragraph inserted above the first one leaves its text with it.
  const above = withLead(source, "NEW ");
  above.doc.insertParagraph(0, { type: "action", runs: [{ text: "Above." }] });
  assert.deepEqual(rows(above.doc), [["action", "Above."], ["sceneHeading", shown], ["action", "Two."]]);
  assert.equal(above.doc.indexOf(above.ids[0]!), 1);
});

test("joining onto and deleting a first paragraph whose only text is before its line break", () => {
  const joining = withLead("INT. A - DAY\n\nTwo.\n", "NEW ");
  joining.doc.deleteText(joining.ids[0]!, 4, 12);
  assert.deepEqual(rows(joining.doc), [["sceneHeading", "NEW "], ["action", "Two."]]);
  // Not empty, so Backspace at the start of the next paragraph joins it on and the first paragraph stays.
  assert.equal(joining.doc.mergeWithPrevious(joining.ids[1]!), joining.ids[0]);
  assert.deepEqual(rows(joining.doc), [["sceneHeading", "NEW Two."]]);
  assert.equal(joining.doc.toScript().paragraphs[0]!.id, joining.ids[0]);
  // Deleting the first paragraph leaves its lead, a co-writer's typing, which then starts the next paragraph.
  const deleting = withLead("INT. A - DAY\n\nTwo.\n", "NEW ");
  deleting.doc.deleteParagraph(deleting.ids[0]!);
  assert.deepEqual(rows(deleting.doc), [["action", "NEW Two."]]);
  assert.equal(deleting.doc.lead(), 4);
});

test("a Return and two scene moves at once leave the next section title a section on every peer", () => {
  // The final review's case: A presses Return at the end of "SEC 1" and moves scene 2 to the end; B moves scene 6
  // before "SEC 3". Y.Text drops the type marker of SEC 3's line break, which then read as General everywhere.
  const h = (n: number, text: string): Paragraph => ({ id: `h${n}`, type: "sceneHeading", sceneId: `s${n}`, sceneNumber: String(n), runs: [{ text }] });
  const script = {
    titlePage: [],
    paragraphs: [
      h(0, "INT. PLACE 0 - DAY"), { id: "sec1", type: "section", depth: 1, runs: [{ text: "SEC 1" }] }, h(2, "INT. PLACE 2 - DAY"),
      { id: "syn2", type: "synopsis", runs: [{ text: "syn 2" }] }, { id: "sec3", type: "section", depth: 1, runs: [{ text: "SEC 3" }] },
      { id: "a4", type: "action", runs: [{ text: "text 4" }] }, h(6, "INT. PLACE 6 - DAY"),
    ] as Paragraph[],
  };
  const origin = new Y.Doc();
  origin.clientID = 1;
  const base = ScreenplayDoc.fromScript(script, origin).encodeState();
  for (const repair of [true, false]) {
    const peer = (client: number) => {
      const ydoc = new Y.Doc();
      ydoc.clientID = client;
      const doc = new ScreenplayDoc(ydoc, { repair });
      doc.applyUpdate(base);
      return doc;
    };
    const a = peer(10), b = peer(11);
    a.splitParagraph("sec1", 5);
    moveScene(a, "s2", null);
    moveScene(b, "s6", "sec3");
    for (let k = 0; k < 2; k++) {
      b.applyUpdate(Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
      a.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
    }
    assert.deepEqual(a.toScript(), b.toScript());
    const sec3 = a.paragraph("sec3");
    // Without the repair the cause shows: the title reads as General. With it, the title is a section again.
    assert.deepEqual([sec3.type, sec3.depth, plainText(sec3.runs)], [repair ? "section" : "general", 1, "SEC 3"], `repair ${repair}`);
    if (!repair) continue;
    assert.deepEqual(rows(a).map(([type]) => type), ["sceneHeading", "section", "section", "sceneHeading", "section", "action", "sceneHeading", "synopsis"]);
    assert.deepEqual(a.validate(), []);
  }
});

test("a paragraph that lost its type gets it back from a copy of itself or from its scene ID or depth", () => {
  const doc = ScreenplayDoc.fromScript({
    titlePage: [],
    paragraphs: [
      { id: "h", type: "sceneHeading", sceneId: "s", sceneNumber: "4", runs: [{ text: "INT. A - DAY" }] },
      { id: "sec", type: "section", depth: 2, runs: [{ text: "Sequence" }] },
      { id: "c", type: "character", runs: [{ text: "NELL" }] },
      { id: "a", type: "action", runs: [{ text: "Rain." }] },
    ],
  });
  const reports: unknown[] = [];
  doc.onRepair((report) => reports.push(report));
  const drop = (id: string) => doc.ydoc.transact(() => doc.body.format(doc.range(id).start - 1, 1, { type: null }), "peer");
  for (const id of ["h", "sec", "a"]) drop(id);
  // The heading and the section are back; an action has nothing to tell it from General.
  assert.deepEqual(rows(doc).map(([type]) => type), ["sceneHeading", "section", "character", "general"]);
  assert.equal(doc.paragraph("h").sceneNumber, "4");
  assert.deepEqual(reports, [{ copies: [], headings: [], missing: 0, types: 1 }, { copies: [], headings: [], missing: 0, types: 1 }]);
  // A copy of a paragraph whose line break came without a type takes the type of the copy that has one.
  doc.ydoc.transact(() => doc.body.applyDelta([{ retain: doc.body.length }, { insert: "\n", attributes: { id: "c" } }, { insert: "NELL" }]), "peer");
  const copy = doc.toScript().paragraphs[4]!;
  assert.deepEqual([copy.type, plainText(copy.runs), copy.id === "c"], ["character", "NELL", false]);
  assert.deepEqual(doc.validate(), []);
  // A read-only copy leaves it to the writers until it may repair.
  const follower = new ScreenplayDoc(new Y.Doc(), { repair: false });
  follower.applyUpdate(doc.encodeState());
  follower.ydoc.transact(() => follower.body.format(follower.range("sec").start - 1, 1, { type: null }), "peer");
  assert.equal(follower.paragraph("sec").type, "general");
  follower.setRepairs(true);
  assert.equal(follower.paragraph("sec").type, "section");
});

test("peers that give a lost type back at the same time agree", () => {
  const { a, b, sync } = pair();
  const heading = a.toScript().paragraphs[4]!;
  // Both receive the same type loss and repair it independently before hearing from each other.
  const loss = new ScreenplayDoc(new Y.Doc(), { repair: false });
  loss.applyUpdate(a.encodeState());
  loss.ydoc.transact(() => loss.body.format(loss.range(heading.id).start - 1, 1, { type: null }));
  const update = loss.encodeState();
  a.applyUpdate(update);
  b.applyUpdate(update);
  assert.equal(a.paragraph(heading.id).type, "sceneHeading");
  assert.equal(b.paragraph(heading.id).type, "sceneHeading");
  sync();
  assert.deepEqual(a.toScript(), b.toScript());
  assert.deepEqual(a.validate(), []);
});
