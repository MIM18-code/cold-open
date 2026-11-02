import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ScreenplayDoc, moveScenes, strandedByMove, writeFdx, writeFountain, type StructuralMoveConflict } from "../src/index.ts";
import { type MoveKnowledge } from "../src/move-knowledge.ts";

const script = () => ({ titlePage: [], paragraphs: ["a", "b", "c"].flatMap(id => [
  { id, sceneId: id, type: "sceneHeading" as const, runs: [{ text: `INT. ${id} - DAY` }] },
  { id: `${id}t`, type: "action" as const, runs: [{ text: "abcdef" }] },
]) });
const vector = (record: MoveKnowledge) => Y.decodeStateVector(Uint8Array.from(atob(record.sv), char => char.charCodeAt(0)));
const records = (doc: ScreenplayDoc) => doc.meta.get(`move.${doc.ydoc.clientID}`) as MoveKnowledge[];
const keys = (doc: ScreenplayDoc) => [...doc.meta.keys()].filter(key => key.startsWith("move."));

test("a move atomically records its exact prior vector and post-move clock", () => {
  const doc = ScreenplayDoc.fromScript(script()), key = `move.${doc.ydoc.clientID}`;
  let events = 0;
  const before = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc));
  try {
    doc.body.observe((_event, transaction) => {
      events++;
      assert.ok((transaction.changed as Map<unknown, Set<string>>).get(doc.meta)?.has(key));
      const record = (doc.meta.get(key) as MoveKnowledge[]).at(-1)!;
      assert.deepEqual(vector(record), before);
      assert.equal(record.at, doc.meta._map.get(key)!.id.clock);
      assert.equal(record.at + 1, Y.getState(doc.ydoc.store, doc.ydoc.clientID));
    });
    moveScenes(doc, ["b"], null);
    assert.equal(events, 1);
    assert.deepEqual(keys(doc), [key]);
  } finally { doc.ydoc.destroy(); }
});

test("each client retains eight records in one key, and no-op moves do not write a record", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  try {
    for (let i = 0; i < 100; i++) moveScenes(a, ["b"], i % 2 ? "a" : null);
    assert.deepEqual(keys(a), [`move.${a.ydoc.clientID}`]);
    const record = records(a).at(-1)!;
    assert.equal(records(a).length, 8);
    assert.ok(records(a).every((record, index, all) => !index || all[index - 1]!.at < record.at));
    assert.ok(record.sv.length < 100);
    const before = a.encodeState();
    assert.equal(moveScenes(a, ["b"], "a"), false);
    assert.deepEqual(a.encodeState(), before);
    b.applyUpdate(a.encodeState(), "net"); moveScenes(b, ["c"], "b");
    a.applyUpdate(b.encodeState(), "net");
    assert.deepEqual(keys(a).sort(), [`move.${a.ydoc.clientID}`, `move.${b.ydoc.clientID}`].sort());
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("nested moves retain independent knowledge of preceding edits", () => {
  const doc = ScreenplayDoc.fromScript(script());
  try {
    let before!: Map<number, number>;
    doc.ydoc.transact(() => {
      moveScenes(doc, ["b"], null);
      doc.insertText("at", 0, "KNOWN");
      before = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc));
      moveScenes(doc, ["c"], "a");
    });
    assert.deepEqual(vector(records(doc).at(-1)!), before);
    assert.equal(keys(doc).length, 1);
    assert.equal(records(doc).length, 2);
  } finally { doc.ydoc.destroy(); }
});

test("exchange exports omit move knowledge and whole-script replacement clears it", () => {
  const doc = ScreenplayDoc.fromScript(script());
  try {
    moveScenes(doc, ["b"], null);
    const plain = doc.toScript(), fdx = writeFdx(plain), fountain = writeFountain(plain), key = keys(doc)[0]!;
    assert.ok(key);
    doc.meta.delete(key);
    assert.deepEqual(doc.toScript(), plain);
    assert.equal(writeFdx(doc.toScript()), fdx);
    assert.equal(writeFountain(doc.toScript()), fountain);
    moveScenes(doc, ["b"], "a");
    doc.load(script());
    assert.deepEqual(keys(doc), []);
  } finally { doc.ydoc.destroy(); }
});

for (const acknowledgeTyping of [false, true]) test(`batched moves retain each operation's vector (typing acknowledged=${acknowledgeTyping})`, () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  b.body.observe((_event, transaction) => notices.push(...strandedByMove(b, transaction)));
  try {
    moveScenes(a, ["b"], null); b.insertText("bt", 2, "X");
    if (acknowledgeTyping) a.applyUpdate(b.encodeState(), "net");
    moveScenes(a, ["c"], "a");
    b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices.map(notice => notice.text), ["X"]);
    assert.ok(b.body.toString().includes("X"));
    assert.equal(keys(a).length, 1);
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("a load clears old move knowledge and cannot reuse it for a replacement notice", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  b.body.observe((_event, transaction) => notices.push(...strandedByMove(b, transaction)));
  try {
    moveScenes(a, ["c"], "a"); b.applyUpdate(a.encodeState(), "net");
    a.load(script()); b.insertText("bt", 2, "X");
    b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
    assert.deepEqual(keys(b), []);
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("an older move key does not arm a later plain scene deletion", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  b.body.observe((_event, transaction) => notices.push(...strandedByMove(b, transaction)));
  try {
    moveScenes(a, ["b"], null); b.applyUpdate(a.encodeState(), "net");
    const record = a.meta.get(`move.${a.ydoc.clientID}`);
    a.ydoc.transact(() => { a.deleteParagraph("ct"); a.deleteParagraph("c"); });
    b.insertText("ct", 2, "SURVIVES"); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
    assert.ok(b.body.toString().includes("SURVIVES"));
    assert.deepEqual(a.meta.get(`move.${a.ydoc.clientID}`), record);
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("a record contains only body items deleted by that move, excluding earlier and later deletions", () => {
  const doc = ScreenplayDoc.fromScript(script());
  try {
    const old = [doc.paragraph("b"), doc.paragraph("bt")];
    let previous!: ReturnType<typeof Y.createDeleteSet>;
    doc.ydoc.transact(transaction => {
      doc.deleteParagraph("bt"); doc.deleteParagraph("b");
      old.forEach((paragraph, index) => doc.insertParagraph(2 + index, paragraph));
      previous = Y.createDeleteSet();
      for (const [client, ranges] of transaction.deleteSet.clients) previous.clients.set(client, ranges.map(range => ({ clock: range.clock, len: range.len })));
      moveScenes(doc, ["c"], "a");
      doc.deleteText("at", 0, 1);
    });
    const record = records(doc)[0]!;
    for (const [client, clock, length] of record.spans) {
      assert.ok(!previous.clients.get(client)?.some(range => range.clock < clock + length && range.clock + range.len > clock));
      const structs = doc.ydoc.store.clients.get(client)!;
      for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < clock + length; i++) {
        const item = structs[i]!;
        assert.ok(item instanceof Y.Item && item.parent === doc.body && item.deleted);
      }
    }
    for (const [client, clock, length] of record.chars) assert.ok(record.spans.some(([owner, from, size]) => owner === client && from <= clock && from + size >= clock + length));
    assert.equal(record.chars.reduce((sum, [, , length]) => sum + length, 0), 20);
  } finally { doc.ydoc.destroy(); }
});

for (const count of [8, 9]) test(`the first move remains detectable only while retained (${count} moves)`, () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  b.body.observe((_event, transaction) => notices.push(...strandedByMove(b, transaction)));
  try {
    moveScenes(a, ["b"], null); b.insertText("bt", 2, "X");
    for (let i = 1; i < count; i++) moveScenes(a, ["c"], i % 2 ? "a" : null);
    b.applyUpdate(a.encodeState(), "net");
    assert.equal(records(a).length, 8);
    assert.deepEqual(notices.map(notice => notice.text), count === 8 ? ["X"] : []);
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("if the moved copy loses original characters before receipt, detection conservatively skips the record", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  b.body.observe((_event, transaction) => notices.push(...strandedByMove(b, transaction)));
  try {
    moveScenes(a, ["b"], null); a.deleteText("bt", 0, 1);
    b.insertText("bt", 2, "X"); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
    assert.ok(b.body.toString().includes("X"));
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

for (const operation of ["restore", "delete"]) test(`late records cannot adopt a batched plain ${operation} after source GC`, () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [], set = a.meta.set.bind(a.meta);
  let delayed!: [string, unknown];
  b.ydoc.on("beforeObserverCalls", transaction => notices.push(...strandedByMove(b, transaction)));
  try {
    const copies = [a.paragraph("b"), a.paragraph("bt")];
    a.ydoc.transact(() => {
      a.deleteParagraph("bt"); a.deleteParagraph("b");
      if (operation === "restore") copies.forEach((paragraph, index) => a.insertParagraph(2 + index, paragraph));
    });
    a.meta.set = (key, value) => {
      if (key.startsWith("move.")) { delayed = [key, value]; return value; }
      return set(key, value);
    };
    moveScenes(a, ["c"], "a"); a.meta.set = set;
    b.insertText("bt", 2, "X"); b.applyUpdate(a.encodeState(), "net");
    a.ydoc.transact(() => set(...delayed)); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
    assert.ok(b.body.toString().includes("X"));
  } finally { a.meta.set = set; a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("records that arrive after their deletions are skipped, even when their overwritten key items were received as tombstones", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  let prefix: ScreenplayDoc | undefined;
  b.ydoc.on("beforeObserverCalls", transaction => notices.push(...strandedByMove(b, transaction)));
  try {
    moveScenes(a, ["b"], null); b.insertText("bt", 2, "X");
    a.applyUpdate(b.encodeState(), "net"); moveScenes(a, ["c"], "a");
    prefix = ScreenplayDoc.fromUpdate(a.encodeState());
    const key = `move.${a.ydoc.clientID}`, structs = prefix.ydoc.store.clients.get(a.ydoc.clientID)!;
    assert.equal(structs.at(-1)!.id.clock, records(a).at(-1)!.at);
    structs.pop(); prefix.meta._map.delete(key);
    b.applyUpdate(prefix.encodeState(), "net");
    assert.equal(notices.length, 0);
    assert.ok(Y.getState(b.ydoc.store, a.ydoc.clientID) > records(a)[0]!.at);
    b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
  } finally { prefix?.ydoc.destroy(); a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("typing done after a move arrived is never flagged when the move record comes later", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [], set = a.meta.set.bind(a.meta);
  let delayed!: [string, unknown];
  b.ydoc.on("beforeObserverCalls", transaction => notices.push(...strandedByMove(b, transaction)));
  try {
    a.meta.set = (key, value) => {
      if (key.startsWith("move.")) { delayed = [key, value]; return value; }
      return set(key, value);
    };
    moveScenes(a, ["b"], null); a.meta.set = set;
    b.applyUpdate(a.encodeState(), "net");
    b.insertText("at", 6, "ORDINARY");
    const next = b.splitParagraph("at", 14, "action"); b.insertText(next, 0, "MORE");
    a.ydoc.transact(() => set(...delayed)); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
  } finally { a.meta.set = set; a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("a late older mover cannot cross another move's unseen deleted heading to report a synced child heading", () => {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState()), c = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  let prefix: ScreenplayDoc | undefined;
  b.body.observe((_event, transaction) => notices.push(...strandedByMove(b, transaction)));
  b.meta.observe((_event, transaction) => {
    if (!(transaction.changed as Map<unknown, unknown>).has(b.body)) notices.push(...strandedByMove(b, transaction));
  });
  try {
    const parent = b.splitParagraph("at", 6, "sceneHeading"); b.insertText(parent, 0, "NEW");
    const child = b.splitParagraph(parent, 3, "sceneHeading"); b.insertText(child, 0, "CHILD");
    a.applyUpdate(b.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net");
    moveScenes(a, [parent], null); moveScenes(c, ["a", "b"], null); a.applyUpdate(c.encodeState(), "net");
    prefix = ScreenplayDoc.fromUpdate(a.encodeState());
    const key = `move.${c.ydoc.clientID}`, history = prefix.meta.get(key) as MoveKnowledge[], structs = prefix.ydoc.store.clients.get(c.ydoc.clientID)!;
    assert.equal(structs.at(-1)!.id.clock, history.at(-1)!.at);
    structs.pop(); prefix.meta._map.delete(key);
    b.applyUpdate(prefix.encodeState(), "net");
    assert.equal(notices.length, 0);
    b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
    assert.ok(b.has(child));
  } finally { prefix?.ydoc.destroy(); a.ydoc.destroy(); b.ydoc.destroy(); c.ydoc.destroy(); }
});

test("a move whose scope was partly deleted by another writer's earlier move raises no notice for later typing", () => {
  const four = { titlePage: [], paragraphs: ["a", "b", "c", "d"].flatMap(id => [
    { id, sceneId: id, type: "sceneHeading" as const, runs: [{ text: `INT. ${id} - DAY` }] },
    { id: `${id}t`, type: "action" as const, runs: [{ text: "abcdef" }] },
  ]) };
  const a = ScreenplayDoc.fromScript(four), c = ScreenplayDoc.fromUpdate(a.encodeState()), t = ScreenplayDoc.fromUpdate(a.encodeState());
  const notices: StructuralMoveConflict[] = [];
  t.ydoc.on("beforeObserverCalls", transaction => notices.push(...strandedByMove(t, transaction)));
  try {
    assert.deepEqual(t.paragraphs().filter(p => p.type === "sceneHeading").map(p => p.id), ["a", "b", "c", "d"]);
    moveScenes(a, ["b", "d"], null);
    moveScenes(c, ["b"], null);
    t.applyUpdate(c.encodeState(), "net");
    t.insertText("at", 6, "ORDINARY");
    t.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(notices, []);
  } finally { a.ydoc.destroy(); c.ydoc.destroy(); t.ydoc.destroy(); }
});
