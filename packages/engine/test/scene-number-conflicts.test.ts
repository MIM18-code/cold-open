import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import {
  ScreenplayDoc, dismissSceneNumberRenumberings, issuedSceneNumbers, numberAddedScenes, parseFdx, plainText, resolveSceneNumberConflicts,
  sceneNumberConflicts, sceneNumberRenumberings, sceneNumbersLocked, setSceneNumbersLocked, replaceSceneNumber,
  assertUniqueSceneNumbers, isOmitted, omittedParagraphs, omitScene, unomitScene, writeFdx, type Paragraph,
} from "../src/index.ts";

const heading = (id: string, number: string | undefined, text: string): Paragraph => ({
  id, sceneId: `s-${id}`, type: "sceneHeading", ...(number !== undefined ? { sceneNumber: number } : {}), runs: [{ text }],
});

const numbersOf = (doc: ScreenplayDoc) => doc.paragraphs()
  .filter((p) => p.type === "sceneHeading").map((p) => `${p.id}:${p.sceneNumber}`);

test("three peers repair delayed formatting updates through a FIFO central relay without losing numbers", () => {
  const relay = new ScreenplayDoc();
  relay.ydoc.clientID = 1;
  relay.load({ titlePage: [], paragraphs: [
    heading("first", "12", "INT. HALL - DAY"), heading("last", "13", "EXT. ROAD - DAY"),
  ] });
  setSceneNumbersLocked(relay, true);
  const peers = [10, 20, 30].map((clientID) => {
    const peer = ScreenplayDoc.fromUpdate(relay.encodeState());
    peer.ydoc.clientID = clientID;
    return peer;
  });
  const queue: (() => void)[] = [];
  for (const peer of peers) peer.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "net") return;
    queue.push(() => {
      relay.applyUpdate(update, "net");
      for (const other of peers) if (other !== peer) other.applyUpdate(update, "net");
      // This writer repairs intermediate merges while the other writers' checks are delayed.
      peers[2]!.ydoc.transact(() => resolveSceneNumberConflicts(peers[2]!), "repair");
    });
  });
  try {
    peers.forEach((peer, index) => {
      peer.insertParagraph(1, { type: "sceneHeading", sceneNumber: "12A", runs: [{ text: `INT. ADDITION ${index} - DAY` }] });
    });
    let deliveries = 0;
    do {
      while (queue.length) {
        assert.ok(++deliveries < 1000, "repair reaches quiescence");
        queue.shift()!();
      }
      for (const peer of peers) peer.ydoc.transact(() => resolveSceneNumberConflicts(peer), "repair");
    } while (queue.length);
    for (const peer of peers) {
      assert.deepEqual(peer.paragraphs().map((p) => p.sceneNumber), ["12", "12A", "12AA", "12B", "13"]);
      assert.deepEqual(peer.paragraphs(), relay.paragraphs());
      assertUniqueSceneNumbers(peer.toScript());
    }
  } finally { for (const doc of [relay, ...peers]) doc.ydoc.destroy(); }
});

for (const divergent of [false, true]) test(`concurrent omissions ${divergent ? "retain different content for review" : "collapse identical copies before numbering"}`, () => {
  const a = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("first", "12", "INT. HALL - DAY"), heading("middle", "12A", "INT. STAIRS - DAY"),
    { id: "body", type: "action", runs: [{ text: "A footstep." }] }, heading("last", "13", "EXT. ROAD - DAY"),
  ] });
  setSceneNumbersLocked(a, true);
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  try {
    if (divergent) b.insertText("body", 0, "Another sound. ");
    omitScene(a, "s-middle"); omitScene(b, "s-middle");
    a.applyUpdate(b.encodeState()); b.applyUpdate(a.encodeState());
    const before = a.paragraphs().filter(isOmitted).map(omittedParagraphs);
    assert.equal(before.length, 2);
    const resolvedA = resolveSceneNumberConflicts(a), resolvedB = resolveSceneNumberConflicts(b);
    assert.deepEqual(resolvedA.renumbered, []);
    assert.deepEqual(resolvedA, resolvedB);
    a.applyUpdate(b.encodeState()); b.applyUpdate(a.encodeState());
    assert.deepEqual(a.paragraphs(), b.paragraphs());
    const omitted = a.paragraphs().filter(isOmitted);
    assert.deepEqual(omitted.map((p) => p.sceneNumber), divergent ? ["12A", "12A"] : ["12A"]);
    if (divergent) {
      assert.equal(resolvedA.conflicts.length, 1);
      assert.deepEqual(omitted.map(omittedParagraphs), before);
      assert.throws(() => assertUniqueSceneNumbers(a.toScript()), /Duplicate scene numbers/);
    } else {
      assert.deepEqual(resolvedA.conflicts, []);
      assert.equal(unomitScene(a, omitted[0]!.id), true);
      assert.deepEqual(a.paragraphs().map((p) => p.id), ["first", "middle", "body", "last"]);
      assert.equal(a.paragraph("middle").sceneNumber, "12A");
    }
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

for (const issued of [" 12A ", "12a"]) test(`missing-number repair before ${JSON.stringify(issued)} preserves the issued number`, () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("first", "12", "INT. HALL - DAY"), heading("missing", undefined, "INT. STAIRS - DAY"),
    heading("issued", issued, "INT. GARAGE - DAY"), heading("last", "13", "EXT. ROAD - DAY"),
  ] });
  setSceneNumbersLocked(doc, true);
  try {
    const result = resolveSceneNumberConflicts(doc);
    assert.deepEqual(numbersOf(doc), ["first:12", "missing:12AA", `issued:${issued}`, "last:13"]);
    assert.deepEqual(result, { renumbered: [], conflicts: [] });
    assert.deepEqual(sceneNumberRenumberings(doc), []);
    assert.deepEqual(resolveSceneNumberConflicts(doc), result);
  } finally { doc.ydoc.destroy(); }
});

test("whitespace and case comparisons preserve the raw expected number and report applied changes only", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("a", "12A", "INT. HALL - DAY"), heading("b", " 12a ", "INT. STAIRS - DAY"), heading("c", "13", "EXT. ROAD - DAY"),
  ] });
  try {
    const result = resolveSceneNumberConflicts(doc);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.renumbered, [{ id: "b", heading: "INT. STAIRS - DAY", from: " 12a ", to: "12B" }]);
    assert.equal(doc.paragraph("b").sceneNumber, "12B");
    assert.deepEqual(sceneNumberRenumberings(doc), result.renumbered);
    assert.deepEqual(resolveSceneNumberConflicts(doc).renumbered, []);
  } finally { doc.ydoc.destroy(); }
});

test("concurrent production additions preserve their words and expose duplicate A-numbers until resolved", () => {
  const a = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "first", sceneId: "s1", type: "sceneHeading", sceneNumber: "12", runs: [{ text: "INT. HALL - DAY" }] },
    { id: "last", sceneId: "s2", type: "sceneHeading", sceneNumber: "13", runs: [{ text: "EXT. ROAD - DAY" }] },
  ] });
  setSceneNumbersLocked(a, true);
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  try {
    const one = a.insertParagraph(1, { type: "sceneHeading", runs: [{ text: "INT. STAIRS - DAY" }] });
    const two = b.insertParagraph(1, { type: "sceneHeading", runs: [{ text: "INT. GARAGE - DAY" }] });
    numberAddedScenes(a); numberAddedScenes(b);
    a.applyUpdate(b.encodeState()); b.applyUpdate(a.encodeState());
    assert.deepEqual(sceneNumberConflicts(a.paragraphs()).map((c) => c.number), ["12A"]);
    assert.deepEqual(sceneNumberConflicts(a.paragraphs()), sceneNumberConflicts(b.paragraphs()));
    assert.throws(() => assertUniqueSceneNumbers(a.toScript()), /Duplicate scene numbers/);
    assert.equal(a.paragraph(one).sceneNumber, "12A"); assert.equal(a.paragraph(two).sceneNumber, "12A");
    const undo = new Y.UndoManager(a.body);
    replaceSceneNumber(a, two, "12A", "12B");
    assertUniqueSceneNumbers(a.toScript());
    assert.equal(a.paragraph("first").sceneNumber, "12"); assert.equal(a.paragraph("last").sceneNumber, "13");
    undo.undo(); assert.equal(sceneNumberConflicts(a.paragraphs()).length, 1);
    undo.destroy();
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("two peers adding a scene in the same locked gap resolve to 12A and 12B on both replicas", () => {
  const a = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [heading("first", "12", "INT. HALL - DAY"), heading("last", "13", "EXT. ROAD - DAY")] });
  setSceneNumbersLocked(a, true);
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  try {
    const one = a.insertParagraph(1, { type: "sceneHeading", runs: [{ text: "INT. STAIRS - DAY" }] });
    const two = b.insertParagraph(1, { type: "sceneHeading", runs: [{ text: "INT. GARAGE - DAY" }] });
    numberAddedScenes(a); numberAddedScenes(b);
    a.applyUpdate(b.encodeState()); b.applyUpdate(a.encodeState());

    const resolvedA = resolveSceneNumberConflicts(a);
    const resolvedB = resolveSceneNumberConflicts(b);
    assert.deepEqual(resolvedA.conflicts, []);
    assert.deepEqual(resolvedB.conflicts, []);
    assert.deepEqual(resolvedA.renumbered, resolvedB.renumbered, "both replicas plan the same renumbering");
    const order = a.paragraphs().filter((p) => p.id === one || p.id === two).map((p) => p.id);
    assert.equal(order.length, 2);
    assert.deepEqual(numbersOf(a), ["first:12", `${order[0]}:12A`, `${order[1]}:12B`, "last:13"]);
    assert.deepEqual(numbersOf(a), numbersOf(b));
    assertUniqueSceneNumbers(a.toScript());
    assert.deepEqual(resolveSceneNumberConflicts(a).renumbered, [], "resolving again changes nothing");

    // The notice names the scene that moved, and dismissing it changes no number.
    assert.deepEqual(sceneNumberRenumberings(a), [{ id: order[1]!, heading: plainText(a.paragraph(order[1]!).runs), from: "12A", to: "12B" }]);
    dismissSceneNumberRenumberings(a);
    assert.deepEqual(sceneNumberRenumberings(a), []);
    assert.deepEqual(numbersOf(a), ["first:12", `${order[0]}:12A`, `${order[1]}:12B`, "last:13"]);
  } finally { a.ydoc.destroy(); b.ydoc.destroy(); }
});

test("resolution keeps every unique number and nests a duplicate between two issued A-numbers", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("a", "1", "INT. ONE - DAY"),
    heading("b", "12", "INT. TWELVE - DAY"),
    heading("c", "12A", "INT. TWELVE A - DAY"),
    heading("d", "12A", "INT. TWELVE A AGAIN - DAY"),
    heading("e", "12B", "INT. TWELVE B - DAY"),
    heading("f", "13", "INT. THIRTEEN - DAY"),
  ] });
  try {
    const { renumbered, conflicts } = resolveSceneNumberConflicts(doc);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(renumbered, [{ id: "d", heading: "INT. TWELVE A AGAIN - DAY", from: "12A", to: "12AA" }]);
    assert.deepEqual(numbersOf(doc), ["a:1", "b:12", "c:12A", "d:12AA", "e:12B", "f:13"]);
  } finally { doc.ydoc.destroy(); }
});

test("resolution numbers scenes before 1 and nested A-scenes without reusing an issued number", () => {
  const before = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("a1", "A1", "EXT. FIELD - DAWN"), heading("a1b", "A1", "EXT. FIELD - LATER"), heading("one", "1", "INT. HOUSE - DAY"),
  ] });
  const nested = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("n", "12", "INT. ROOM - DAY"), heading("na", "12AA", "INT. ROOM - CLOSER"),
    heading("nb", "12AA", "INT. ROOM - CLOSEST"), heading("nc", "12AB", "INT. ROOM - BACK"), heading("n2", "13", "EXT. ROAD - DAY"),
  ] });
  try {
    assert.deepEqual(resolveSceneNumberConflicts(before).renumbered.map((c) => c.to), ["B1"]);
    assert.deepEqual(numbersOf(before), ["a1:A1", "a1b:B1", "one:1"]);
    assert.deepEqual(resolveSceneNumberConflicts(nested).renumbered.map((c) => c.to), ["12AAA"]);
    assert.deepEqual(numbersOf(nested), ["n:12", "na:12AA", "nb:12AAA", "nc:12AB", "n2:13"]);
    // 12AA < 12AAA < 12AB: the renumbered scene still sits between its neighbours in scene order.
    assert.deepEqual(nested.paragraphs().filter((p) => p.type === "sceneHeading").map((p) => p.sceneNumber),
      ["12", "12AA", "12AAA", "12AB", "13"]);
  } finally { before.ydoc.destroy(); nested.ydoc.destroy(); }
});

test("the FDX file carries the scene number lock and its issued numbers, and reads them back", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    heading("h1", "12", "INT. HALL - DAY"), heading("h2", "12A", "INT. STAIRS - DAY"), heading("h3", "13", "EXT. ROAD - DAY"),
  ] });
  try {
    assert.equal(sceneNumbersLocked(doc), false, "no lock, no FDX attributes");
    assert.ok(!writeFdx(doc.toScript()).includes("ColdOpenSceneNumbersLocked"));

    setSceneNumbersLocked(doc, true);
    const xml = writeFdx(doc.toScript());
    assert.ok(xml.includes('ColdOpenSceneNumbersLocked="Yes"'));
    assert.ok(xml.includes("ColdOpenLockedScenes"));

    const back = ScreenplayDoc.fromScript(parseFdx(xml));
    assert.equal(sceneNumbersLocked(back), true);
    assert.deepEqual([...issuedSceneNumbers(back)], [["h1", "12"], ["h2", "12A"], ["h3", "13"]]);

    // Unlocking is recorded too: the attributes go, and reopening the file keeps the numbers free.
    setSceneNumbersLocked(back, false);
    const unlocked = writeFdx(back.toScript());
    assert.ok(!unlocked.includes("ColdOpenSceneNumbersLocked"));
    assert.equal(sceneNumbersLocked(ScreenplayDoc.fromScript(parseFdx(unlocked))), false);
    back.ydoc.destroy();
  } finally { doc.ydoc.destroy(); }
});

test("FDX export keeps Final Draft's own SceneNumberOptions attributes beside the lock", () => {
  const source = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Scene Heading" id="h1" Number="1"><Text>INT. ROOM - DAY</Text></Paragraph>
  </Content>
  <SceneNumberOptions LeftLocation="0.75" NumberScheme="1A" RightLocation="7.38" ShowNumbersOnLeft="Yes" ShowNumbersOnRight="Yes"/>
</FinalDraft>`;
  const doc = ScreenplayDoc.fromScript(parseFdx(source));
  try {
    setSceneNumbersLocked(doc, true);
    const locked = writeFdx(doc.toScript());
    for (const attr of ['LeftLocation="0.75"', 'NumberScheme="1A"', 'RightLocation="7.38"', 'ShowNumbersOnLeft="Yes"', 'ShowNumbersOnRight="Yes"', 'ColdOpenSceneNumbersLocked="Yes"']) {
      assert.ok(locked.includes(attr), attr);
    }
    setSceneNumbersLocked(doc, false);
    const unlocked = writeFdx(doc.toScript());
    assert.ok(unlocked.includes('NumberScheme="1A"'), "Final Draft's attributes stay");
    assert.ok(!unlocked.includes("Inklot"));
  } finally { doc.ydoc.destroy(); }
});

test("explicit scene-number edits reject stale previews and case-insensitive collisions", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "a", type: "sceneHeading", sceneNumber: "1A", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "b", type: "sceneHeading", sceneNumber: "2", runs: [{ text: "EXT. ROAD - NIGHT" }] },
  ] });
  try {
    assert.throws(() => replaceSceneNumber(doc, "b", "2", "1a"), /already assigned/);
    assert.throws(() => replaceSceneNumber(doc, "b", "old", "3"), /changed/);
    assert.throws(() => replaceSceneNumber(doc, "b", "2", ""), /Use a scene number/);
    assertUniqueSceneNumbers(doc.toScript());
  } finally { doc.ydoc.destroy(); }
});
