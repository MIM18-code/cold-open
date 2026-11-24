// Text with no line break at all: one writer removes every paragraph while another types in one. See "Text with
// no line break" at the top of src/doc.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import { ScreenplayDoc, changeScriptNote, omitScene, plainText, scriptNotes, unomitScene, type ElementType, type Paragraph } from "../src/index.ts";

const LOCAL = "local";

function exchange(...docs: ScreenplayDoc[]): void {
  // Twice: a repair made on hearing an update is itself an update.
  for (let round = 0; round < 3; round++) {
    for (const from of docs) for (const to of docs) if (from !== to) to.applyUpdate(Y.encodeStateAsUpdate(from.ydoc, Y.encodeStateVector(to.ydoc)), "remote");
  }
}

/**
 * Peers whose only paragraph was deleted by the first while the second typed " world" in it. Yjs orders text typed at
 * the same place by client ID, so the tests fix the IDs and try every order.
 */
function broken(clients: number[] = [1, 2]): ScreenplayDoc[] {
  const a = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "p", type: "action", runs: [{ text: "Hello" }] }] });
  const docs = [a, ...clients.slice(1).map(() => ScreenplayDoc.fromUpdate(a.encodeState()))];
  docs.forEach((doc, index) => { doc.ydoc.clientID = clients[index]!; });
  a.deleteParagraph("p");
  docs[1]!.insertText("p", 5, " world");
  exchange(...docs);
  for (const doc of docs) assert.equal(doc.body.toString(), " world");
  return docs;
}

const texts = (doc: ScreenplayDoc) => doc.paragraphs().map((p) => plainText(p.runs));

/** What a copy that has just opened this document reads, without repairing anything. */
function reread(doc: ScreenplayDoc): ScreenplayDoc {
  const copy = new ScreenplayDoc(new Y.Doc(), { repair: false });
  copy.applyUpdate(doc.encodeState());
  return copy;
}

/** The paragraph list a peer holds is what the text says, and positions map both ways. */
function consistent(doc: ScreenplayDoc, message = ""): void {
  assert.deepEqual(doc.toScript().paragraphs, reread(doc).toScript().paragraphs, message);
  for (const paragraph of doc.paragraphs()) {
    const length = plainText(paragraph.runs).length;
    for (const offset of [0, length]) {
      const index = doc.bodyIndex({ paragraphId: paragraph.id, offset });
      assert.ok(index >= 0 && index <= doc.body.length, `${message} body index ${index}`);
    }
  }
}

test("text left with no line break reads as one paragraph with an ID, the same on every peer", () => {
  const [a, b] = broken() as [ScreenplayDoc, ScreenplayDoc];
  for (const doc of [a, b]) {
    assert.deepEqual(doc.validate(), []);
    assert.deepEqual(texts(doc), [" world"]);
    assert.equal(doc.repairDuplicates(), 0);
  }
  const id = a.paragraphs()[0]!.id;
  assert.match(id, /^y\d+-\d+$/);
  assert.deepEqual(b.toScript(), a.toScript());
  assert.equal(a.has(""), false);
  // Reading wrote nothing.
  assert.equal(a.body.toString(), " world");
  assert.equal(a.lead(), 6);
  assert.deepEqual(a.positionAt(0), { paragraphId: id, offset: 0 });
  assert.deepEqual(a.positionAt(6), { paragraphId: id, offset: 6 });
  assert.equal(a.bodyIndex({ paragraphId: id, offset: 3 }), 3);
  assert.equal(a.bodyIndex({ paragraphId: id, offset: 6 }), 6);

  // The edits of the report: at the start, at the end, a deletion. Each lands where it was asked.
  a.insertText(id, 0, "X");
  assert.deepEqual(texts(a), ["X world"]);
  a.insertText(id, 7, "Z");
  assert.deepEqual(texts(a), ["X worldZ"]);
  a.deleteText(id, 0, 1);
  assert.deepEqual(texts(a), [" worldZ"]);
  assert.equal(a.paragraphs()[0]!.id, id);
  assert.equal(a.body.toString(), "\n worldZ");
  assert.equal(a.lead(), 0);
  consistent(a);
  exchange(a, b);
  assert.deepEqual(b.toScript(), a.toScript());
  assert.deepEqual(b.validate(), []);
});

for (const clients of [[1, 2], [2, 1]]) test(`two peers that both give the text its line break converge and keep every character (client IDs ${clients})`, () => {
  const [a, b] = broken(clients) as [ScreenplayDoc, ScreenplayDoc];
  const id = a.paragraphs()[0]!.id;
  a.insertText(id, 0, "A");
  b.insertText(id, 6, "B");
  assert.deepEqual(texts(a), ["A world"]);
  assert.deepEqual(texts(b), [" worldB"]);
  exchange(a, b);
  assert.deepEqual(b.toScript(), a.toScript());
  assert.deepEqual(a.validate(), []);
  assert.deepEqual(b.validate(), []);
  assert.equal([...texts(a).join("")].sort().join(""), [..."A worldB"].sort().join(""));
  // Each added a line break with the same ID: two paragraphs. The second holds the text that was there, and keeps
  // the ID both were using; the first has a new one.
  assert.equal(a.paragraphs().length, 2);
  assert.equal(a.paragraphs()[1]!.id, id);
  assert.ok(plainText(a.paragraphs()[1]!.runs).includes("world"));
  assert.match(a.paragraphs()[0]!.id, /^y\d+-\d+$/);
  assert.notEqual(a.paragraphs()[0]!.id, id);
  consistent(a);
  consistent(b);
  // Both go on editing by the IDs they now read.
  for (const paragraph of a.paragraphs()) a.insertText(paragraph.id, 0, "!");
  exchange(a, b);
  assert.deepEqual(b.toScript(), a.toScript());
  assert.deepEqual(b.validate(), []);
});

const EDITS: Record<string, (doc: ScreenplayDoc, id: string) => string[]> = {
  "typing in the middle": (doc, id) => (doc.insertText(id, 3, "-"), [" wo-rld"]),
  "deleting text": (doc, id) => (doc.deleteText(id, 1, 2), [" rld"]),
  "replacing text": (doc, id) => (doc.replaceText(id, 1, 6, "there"), [" there"]),
  "formatting": (doc, id) => (doc.format(id, 1, 5, { bold: true }), [" world"]),
  "a type": (doc, id) => (doc.setType(id, "character"), [" world"]),
  "a field": (doc, id) => (doc.setField(id, "alignment", "center"), [" world"]),
  "a split": (doc, id) => (doc.splitParagraph(id, 3), [" wo", "rld"]),
  "a split at the start": (doc, id) => (doc.splitParagraph(id, 0), ["", " world"]),
  "a split at the end": (doc, id) => (doc.splitParagraph(id, 6), [" world", ""]),
  "a paragraph above": (doc) => (doc.insertParagraph(0, { type: "action", runs: [{ text: "Up" }] }), ["Up", " world"]),
  "a paragraph below": (doc) => (doc.insertParagraph(1, { type: "action", runs: [{ text: "Down" }] }), [" world", "Down"]),
  "a deleted range": (doc, id) => (doc.deleteRange({ paragraphId: id, offset: 1 }, { paragraphId: id, offset: 6 }), [" "]),
  "a paste": (doc, id) => (doc.insertParagraphsAt({ paragraphId: id, offset: 3 }, [{ id: "x", type: "action", runs: [{ text: "Pasted" }] }]), [" wo", "Pasted", "rld"]),
  "a join": (doc, id) => (doc.mergeWithPrevious(id), [" world"]),
  "a deleted paragraph": (doc, id) => (doc.deleteParagraph(id), []),
};

for (const [name, edit] of Object.entries(EDITS)) {
  test(`an edit made while the text has no line break lands where it is drawn: ${name}`, () => {
    const [a, b] = broken() as [ScreenplayDoc, ScreenplayDoc];
    const id = a.paragraphs()[0]!.id;
    assert.deepEqual(texts(a), [" world"]);
    const expected = edit(a, id);
    assert.deepEqual(texts(a), expected);
    assert.deepEqual(a.validate(), []);
    consistent(a, name);
    if (name === "a type") assert.equal(a.paragraph(id).type, "character" satisfies ElementType);
    if (name === "a field") assert.equal(a.paragraph(id).alignment, "center");
    if (name === "formatting") assert.deepEqual(a.paragraph(id).runs, [{ text: " " }, { text: "world", bold: true }]);
    assert.equal(a.has(id), name !== "a deleted paragraph", name);
    // The new line break took no formatting from the text, nor gave it any.
    for (const op of a.body.toDelta() as { insert: string; attributes?: Record<string, unknown> }[]) {
      if (!op.insert.includes("\n")) assert.equal(op.attributes?.id, undefined, name);
      else assert.equal(op.attributes?.bold, undefined, name);
    }
    exchange(a, b);
    assert.deepEqual(b.toScript(), a.toScript());
    assert.deepEqual(texts(b), expected);
    assert.deepEqual(b.validate(), []);
  });
}

test("a document saved with no line break opens well formed, unchanged, and can be edited", () => {
  const [a] = broken() as [ScreenplayDoc];
  const saved = a.encodeState();
  const opened = ScreenplayDoc.fromUpdate(saved);
  const other = ScreenplayDoc.fromUpdate(saved);
  assert.deepEqual(opened.validate(), []);
  assert.deepEqual(texts(opened), [" world"]);
  assert.equal(opened.paragraphs()[0]!.id, a.paragraphs()[0]!.id);
  // Opening and reading wrote nothing to the text, so two Macs that open the same file do not each add a line break.
  assert.equal(opened.body.toString(), " world");
  assert.equal(other.body.toString(), " world");
  const id = opened.paragraphs()[0]!.id;
  opened.insertText(id, 6, "!");
  opened.splitParagraph(id, 3);
  assert.deepEqual(texts(opened), [" wo", "rld!"]);
  assert.deepEqual(opened.validate(), []);
  exchange(opened, other, a);
  assert.deepEqual(other.toScript(), opened.toScript());
  assert.deepEqual(a.toScript(), opened.toScript());
  // Saved again after the edit, it is an ordinary document.
  const again = ScreenplayDoc.fromUpdate(opened.encodeState());
  assert.deepEqual(again.toScript(), opened.toScript());
  assert.equal(again.lead(), 0);
});

test("undo and redo across the new line break keep the text and the ID", () => {
  const [a, b] = broken() as [ScreenplayDoc, ScreenplayDoc];
  const id = b.paragraphs()[0]!.id;
  const undo = new Y.UndoManager([b.body, b.meta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  b.ydoc.transact(() => b.insertText(id, 6, "!"), LOCAL);
  assert.deepEqual(texts(b), [" world!"]);
  undo.undo();
  assert.deepEqual(texts(b), [" world"]);
  assert.equal(b.paragraphs()[0]!.id, id);
  assert.deepEqual(b.validate(), []);
  consistent(b);
  undo.redo();
  assert.deepEqual(texts(b), [" world!"]);
  assert.equal(b.paragraphs()[0]!.id, id);
  undo.undo();
  // Typing again after the undo works by the same ID.
  b.ydoc.transact(() => b.insertText(id, 0, "?"), LOCAL);
  assert.deepEqual(texts(b), ["? world"]);
  exchange(a, b);
  assert.deepEqual(a.toScript(), b.toScript());
  assert.deepEqual(a.validate(), []);
});

test("undoing the deletion that left the text without a line break, after a peer gave it one", () => {
  const a = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "p", type: "action", runs: [{ text: "Hello" }] }] });
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const undo = new Y.UndoManager([a.body, a.meta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  a.ydoc.transact(() => a.deleteParagraph("p"), LOCAL);
  b.insertText("p", 5, " world");
  exchange(a, b);
  b.insertText(b.paragraphs()[0]!.id, 6, "!");
  exchange(a, b);
  undo.undo();
  exchange(a, b);
  assert.deepEqual(b.toScript(), a.toScript());
  assert.deepEqual(a.validate(), []);
  assert.equal(texts(a).join(""), "Hello world!");
  assert.ok(a.has("p"));
  consistent(a);
  undo.redo();
  exchange(a, b);
  assert.deepEqual(b.toScript(), a.toScript());
  assert.deepEqual(a.validate(), []);
  assert.equal(texts(a).join(""), " world!");
});

const note = (doc: ScreenplayDoc, id: string) => changeScriptNote(doc, null, { text: "Check this.", author: "", color: "" }, { from: { paragraphId: id, offset: 2 }, to: { paragraphId: id, offset: 4 } });

test("the line break added apart from the edit stays when the edit is undone, so the ID and a note keep to the text", () => {
  const [, b] = broken() as [ScreenplayDoc, ScreenplayDoc];
  const id = b.paragraphs()[0]!.id;
  const undo = new Y.UndoManager([b.body, b.meta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  // As the app's session does: the line break first, in a transaction of its own, then the edit.
  assert.equal(b.mend(), true);
  assert.equal(b.mend(), false);
  b.ydoc.transact(() => note(b, id), LOCAL);
  assert.equal(scriptNotes(b)[0]!.state, "anchored");
  b.ydoc.transact(() => b.deleteText(id, 0, 1), LOCAL);
  assert.deepEqual(texts(b), ["world"]);
  undo.undo();
  // The first character is back as a new Yjs character. The ID was made from the old one, and is on the line break.
  assert.deepEqual(texts(b), [" world"]);
  assert.equal(b.paragraphs()[0]!.id, id);
  assert.equal(scriptNotes(b)[0]!.state, "anchored");
  assert.equal(b.body.toString(), "\n world");
  undo.undo();
  assert.equal(b.body.toString(), "\n world");
  assert.equal(b.paragraphs()[0]!.id, id);
});

/**
 * At most one line break carries the attribute mend() puts on one: the one that kept the ID it names. The others,
 * which got new IDs, have lost it.
 */
function unmarked(doc: ScreenplayDoc, message = ""): void {
  const marked = (doc.body.toDelta() as { attributes?: Record<string, unknown> }[]).filter((op) => op.attributes?.mend !== undefined);
  assert.ok(marked.length <= 1, message);
  for (const op of marked) assert.equal(op.attributes!.id, op.attributes!.mend, message);
}

test("two pairs of peers that each settled the text's line break apart, then meet: the text keeps the ID and its note on all four", () => {
  const orders = [[1, 2, 3, 4], [4, 3, 2, 1], [1, 3, 2, 4], [3, 1, 4, 2], [2, 4, 1, 3], [4, 1, 2, 3], [2, 1, 4, 3], [3, 4, 1, 2]];
  // How the pairs meet again: all at once, through one peer of each, or one pair hearing the other first.
  const meetings: ((docs: ScreenplayDoc[]) => void)[] = [
    (docs) => exchange(...docs),
    ([a, , c]) => exchange(a!, c!),
    ([, b, , d]) => exchange(d!, b!),
    ([a, b, c]) => { a!.applyUpdate(c!.encodeState(), "remote"); b!.applyUpdate(a!.encodeState(), "remote"); },
  ];
  for (const clients of orders) meetings.forEach((meet, way) => {
    const message = `client IDs ${clients}, meeting ${way}`;
    const docs = broken(clients);
    const [a, b, c, d] = docs as [ScreenplayDoc, ScreenplayDoc, ScreenplayDoc, ScreenplayDoc];
    const id = a.paragraphs()[0]!.id;
    for (const doc of docs) doc.mend();
    note(a, id);
    b.insertText(id, 6, "B");
    d.insertText(id, 6, "D");
    exchange(a, b);
    exchange(c, d);
    for (const doc of docs) {
      assert.equal(doc.paragraphs().length, 2, message);
      assert.equal(doc.paragraphs()[1]!.id, id, message);
    }
    meet(docs);
    exchange(...docs);
    for (const doc of docs) {
      assert.deepEqual(doc.toScript(), a.toScript(), message);
      assert.deepEqual(doc.validate(), [], message);
      assert.equal(doc.paragraphs().length, 4, message);
      const holder = doc.paragraphs()[3]!;
      assert.equal(holder.id, id, message);
      assert.ok(plainText(holder.runs).startsWith(" world"), message);
      assert.deepEqual(texts(doc).slice(0, 3), ["", "", ""], message);
      assert.equal(scriptNotes(doc)[0]!.state, "anchored", message);
      unmarked(doc, message);
    }
  });
});

for (const clients of [[1, 2], [2, 1]]) for (const live of [false, true]) for (const type of ["dialogue", "sceneHeading"] as const) {
  test(`two peers give the text its line break at once, one making it ${type}: the text keeps the ID and its note, and the type stays on that writer's line break (client IDs ${clients}, ${live ? "one update at a time" : "all at once"})`, () => {
    const [a, b] = broken(clients) as [ScreenplayDoc, ScreenplayDoc];
    const id = a.paragraphs()[0]!.id;
    const sent: [ScreenplayDoc, Uint8Array][] = [];
    if (live) for (const doc of [a, b]) doc.ydoc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") sent.push([doc, update]); });
    // One writer changes its type, with a note on it; the other types at its end.
    a.mend();
    a.setType(id, type);
    note(a, id);
    b.mend();
    b.insertText(id, 6, "B");
    // Live, each hears the other's line break before the edit that followed it, and repairs in between.
    for (let i = 0; i < sent.length; i++) {
      const [from, update] = sent[i]!;
      (from === a ? b : a).applyUpdate(update, "remote");
    }
    exchange(a, b);
    assert.deepEqual(b.toScript(), a.toScript());
    assert.deepEqual(a.validate(), []);
    assert.equal(a.paragraphs().length, 2);
    const [first, holder] = a.paragraphs() as [Paragraph, Paragraph];
    // The text is in the second paragraph, with the ID both were using, so the note is still on it.
    assert.deepEqual(texts(a), ["", " worldB"]);
    assert.equal(holder.id, id);
    for (const doc of [a, b]) assert.equal(scriptNotes(doc)[0]!.state, "anchored");
    // The type is on one paragraph only: the line break of the writer who set it. Nothing copies it to the other.
    assert.deepEqual([first.type, holder.type].sort(), ["general", type].sort());
    assert.equal(a.paragraphs().filter((paragraph) => paragraph.type === "sceneHeading").length, type === "sceneHeading" ? 1 : 0);
    assert.equal(a.paragraphs().filter((paragraph) => paragraph.sceneId !== undefined).length, type === "sceneHeading" ? 1 : 0);
    assert.equal(a.scenes().filter((scene) => scene.headingId).length, type === "sceneHeading" ? 1 : 0);
    for (const doc of [a, b]) unmarked(doc);
    consistent(a);
    consistent(b);
  });
}

for (const clients of [[1, 2], [2, 1]]) for (const reopened of [false, true]) {
  test(`after two peers gave the text its line break and synced, an edit to either paragraph changes only that one (client IDs ${clients}${reopened ? ", file reopened" : ""})`, () => {
    let [a, b] = broken(clients) as [ScreenplayDoc, ScreenplayDoc];
    const id = a.paragraphs()[0]!.id;
    // Both only type.
    a.insertText(id, 3, "A");
    b.insertText(id, 6, "B");
    exchange(a, b);
    assert.deepEqual(texts(a), ["", " woArldB"]);
    assert.equal(a.paragraphs()[1]!.id, id);
    for (const doc of [a, b]) unmarked(doc);
    if (reopened) [a, b] = [ScreenplayDoc.fromUpdate(a.encodeState()), ScreenplayDoc.fromUpdate(b.encodeState())];
    const empty = a.paragraphs()[0]!.id;
    const rows = (doc: ScreenplayDoc) => doc.paragraphs().map((paragraph) => [paragraph.id, paragraph.type, paragraph.alignment, plainText(paragraph.runs)]);
    // The empty paragraph, much later: Character, then centered. The text stays as it was.
    a.setType(empty, "character");
    exchange(a, b);
    a.setField(empty, "alignment", "center");
    exchange(a, b);
    for (const doc of [a, b]) assert.deepEqual(rows(doc), [[empty, "character", "center", ""], [id, "general", undefined, " woArldB"]]);
    // And the other way round.
    b.setType(id, "action");
    b.setType(empty, "general");
    exchange(a, b);
    for (const doc of [a, b]) assert.deepEqual(rows(doc), [[empty, "general", "center", ""], [id, "action", undefined, " woArldB"]]);
    b.setType(empty, "sceneHeading");
    exchange(a, b);
    for (const doc of [a, b]) {
      assert.deepEqual(rows(doc), [[empty, "sceneHeading", "center", ""], [id, "action", undefined, " woArldB"]]);
      assert.deepEqual(doc.validate(), []);
      unmarked(doc);
    }
  });
}

test("a third peer's line break that arrives after two were settled still leaves the ID with the text", () => {
  for (const clients of [[1, 2, 3], [3, 2, 1], [2, 3, 1], [1, 3, 2], [2, 1, 3], [3, 1, 2]]) {
    const [a, b, c] = broken(clients) as [ScreenplayDoc, ScreenplayDoc, ScreenplayDoc];
    const id = a.paragraphs()[0]!.id;
    a.insertText(id, 6, "A");
    b.insertText(id, 6, "B");
    c.insertText(id, 6, "C");
    exchange(a, b);
    exchange(a, b, c);
    for (const doc of [a, b, c]) {
      assert.deepEqual(doc.toScript(), a.toScript(), `${clients}`);
      assert.deepEqual(doc.validate(), [], `${clients}`);
      assert.equal(doc.paragraphs().length, 3, `${clients}`);
      assert.equal(doc.paragraphs()[2]!.id, id, `${clients}`);
      assert.ok(plainText(doc.paragraphs()[2]!.runs).startsWith(" world"), `${clients}`);
      unmarked(doc, `${clients}`);
    }
  }
});

test("restoring the only OMITTED scene, with a co-writer's text before its line break, puts that text in the restored heading", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", sceneId: "s", sceneNumber: "1", runs: [{ text: "INT. A - DAY" }] },
    { id: "x", type: "action", runs: [{ text: "Rain." }] },
  ] });
  omitScene(doc, "s");
  const omitted = doc.paragraphs()[0]!.id;
  doc.body.insert(0, "LEAD ");
  assert.equal(unomitScene(doc, omitted), true);
  // As before this file knew of text with no line break: the text ends the heading (and Restore, which read it as part
  // of the OMITTED line, also gives it a line of its own). No General paragraph is made for it.
  assert.deepEqual(doc.paragraphs().map((p) => [p.type, plainText(p.runs)]), [["sceneHeading", "INT. A - DAYLEAD "], ["action", "Rain."], ["action", "LEAD"]]);
  assert.deepEqual(doc.paragraphs().slice(0, 2).map((p) => p.id), ["h", "x"]);
  assert.deepEqual(doc.validate(), []);
});

test("the range of text with no line break is empty, at the end of the text", () => {
  const [a] = broken() as [ScreenplayDoc];
  assert.deepEqual(a.range(a.paragraphs()[0]!.id), { start: 6, end: 6 });
});

test("a read-only follower reads the same paragraph and ID as the writers", () => {
  const [a] = broken() as [ScreenplayDoc];
  const follower = reread(a);
  assert.deepEqual(follower.toScript(), a.toScript());
  assert.deepEqual(follower.validate(), []);
  a.insertText(a.paragraphs()[0]!.id, 0, "X");
  follower.applyUpdate(a.encodeState());
  assert.deepEqual(follower.toScript(), a.toScript());
});

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

const ORDERS = [[1, 2, 3], [3, 2, 1], [2, 3, 1], [1, 3, 2], [2, 1, 3], [3, 1, 2]];

/**
 * Writers edit at random from text with no line break, hearing of each other late and out of order. `edit` makes one
 * edit and returns the characters it typed. After each edit the writer's own copy must be sound (`sound`), and at the
 * end all must agree on a valid script.
 */
function race(peers: number, seeds: number, edit: (doc: ScreenplayDoc, pick: (n: number) => number, letter: () => string) => void, sound: (doc: ScreenplayDoc, message: string) => void): void {
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const docs = broken(ORDERS[seed % ORDERS.length]!.slice(0, peers).map((client) => client * 11));
    // Only build() keeps count: raze() deletes.
    let typed = edit === build ? " world" : "";
    let count = 0;
    const letter = () => {
      const text = String.fromCharCode(0x100 + count++);
      typed += text;
      return text;
    };
    for (let step = 0; step < 40; step++) {
      const doc = docs[pick(peers)]!;
      const message = `seed ${seed} step ${step}`;
      edit(doc, pick, letter);
      consistent(doc, message);
      sound(doc, message);
      if (pick(3) === 0) {
        const from = docs[pick(peers)]!, to = docs[pick(peers)]!;
        if (from !== to) to.applyUpdate(Y.encodeStateAsUpdate(from.ydoc, Y.encodeStateVector(to.ydoc)), "remote");
      }
    }
    exchange(...docs);
    for (const doc of docs) {
      assert.deepEqual(doc.toScript(), docs[0]!.toScript(), `seed ${seed}`);
      assert.deepEqual(doc.validate(), [], `seed ${seed}`);
      consistent(doc, `seed ${seed}`);
    }
    // Every character typed is there. (One can be there twice when two writers move the same lead at once, absorbLead
    // in doc.ts; that is as it was, and the line break added here moves nothing.)
    const text = texts(docs[0]!).join("");
    for (const character of typed) assert.ok(text.includes(character), `seed ${seed} lost ${JSON.stringify(character)}`);
  }
}

/** Typing and paragraph edits that delete no text, so every typed character must survive. */
function build(doc: ScreenplayDoc, pick: (n: number) => number, letter: () => string): void {
  const paragraphs = doc.paragraphs();
  if (!paragraphs.length) return void doc.insertParagraph(0, { type: "action" });
  const paragraph = paragraphs[pick(paragraphs.length)]!;
  const length = plainText(paragraph.runs).length;
  const kind = pick(10);
  if (kind < 5) doc.insertText(paragraph.id, pick(length + 1), letter());
  else if (kind === 5) doc.splitParagraph(paragraph.id, pick(length + 1));
  else if (kind === 6) doc.setType(paragraph.id, "dialogue");
  else if (kind === 7) doc.format(paragraph.id, 0, length, { italic: true });
  else if (kind === 8) doc.insertParagraph(pick(paragraphs.length + 1), { type: "action" });
  else doc.mergeWithPrevious(paragraph.id);
}

/** Edits that delete, every paragraph at times, so the text is left with no line break again and again. */
function raze(doc: ScreenplayDoc, pick: (n: number) => number): void {
  const paragraphs = doc.paragraphs();
  if (!paragraphs.length) return void doc.insertParagraph(0, { type: "action", runs: [{ text: "new" }] });
  const paragraph = paragraphs[pick(paragraphs.length)]!;
  const length = plainText(paragraph.runs).length;
  const kind = pick(8);
  if (kind < 3) doc.insertText(paragraph.id, pick(length + 1), "ab");
  else if (kind === 3) doc.deleteText(paragraph.id, pick(length + 1), 1 + pick(3));
  else if (kind === 4) for (const each of paragraphs) doc.deleteParagraph(each.id);
  else if (kind === 5) doc.splitParagraph(paragraph.id, pick(length + 1));
  else if (kind === 6) doc.deleteRange({ paragraphId: paragraphs[0]!.id, offset: 0 }, { paragraphId: paragraph.id, offset: length });
  else doc.replaceText(paragraph.id, pick(length + 1), pick(length + 1), "r");
}

const valid = (doc: ScreenplayDoc, message: string) => assert.deepEqual(doc.validate(), [], message);
// With three writers the ID repair can leave an ID on two paragraphs until the next update arrives: three line breaks
// with one ID at one place, each repaired by a different writer, are more than its passes always settle at once. It
// does the same with three copies of a paragraph in a script that always had line breaks. No paragraph may be without
// an ID at any time, and all must agree on a valid script in the end.
const identified = (doc: ScreenplayDoc, message: string) => assert.ok(doc.paragraphs().every((paragraph) => paragraph.id), message);

test("two writers editing from text with no line break, updates late and out of order: valid at every step, nothing lost, both agree", () => {
  race(2, 150, build, valid);
});

test("two writers who keep deleting every paragraph while the other types: valid at every step, both agree", () => {
  race(2, 150, raze, valid);
});

test("three writers editing from text with no line break: every paragraph has an ID at every step, nothing lost, all agree", () => {
  race(3, 150, build, identified);
});

test("three writers who keep deleting every paragraph while the others type: every paragraph has an ID at every step, all agree", () => {
  race(3, 150, raze, identified);
});
