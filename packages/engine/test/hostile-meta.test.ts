// Shared-document data written by a co-writer (or carried in a .screenplay file) can have any JSON shape. Readers
// must treat a wrong-shaped value as absent instead of throwing, which would stop Save, Print and Export for every
// writer, and must never write it into the saved script. The bad values go straight into the Y.Doc, the way a remote
// update delivers them.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import {
  LOCK_PARAGRAPH_ATTR, NO_REVISIONS, STRUCTURE_POINT_PREFIX, structurePoints, ScreenplayDoc, clearRevisionMarks, issuedSceneNumbers, moveScenes, omittedParagraphs, pageLocks,
  applyTextEdits, backlotBaseline, isProductionSnapshot, paginate, parseFdx, parseFountain, reanchorPageLocks, revisionState, sceneNumbersLocked, strandedByMove, writeFdx, writeFountain,
  type FdxDocumentExtras, type XmlNode,
} from "../src/index.ts";
import { isMoveKnowledge } from "../src/move-knowledge.ts";
import { fdxExtras, fdxLocksNeedAnchors } from "../src/revisions.ts";
import { SCRIPT_NOTE_ANCHORS, scriptNotes } from "../src/script-notes.ts";
import { parseXml, serializeXml } from "../src/xml.ts";

const fresh = () => ScreenplayDoc.fromScript(parseFountain("INT. ROOM - DAY\n\nA door opens.\n"));
const extras = (after: unknown[] = []) => ({ rootAttrs: [], contentAttrs: [], before: [], after });
const node = (name = "Kept", attrs: unknown[] = [], children: unknown[] = []) => ({ name, attrs, children });
const goodSet = { id: "1", name: "Blue", color: "#C6EDFE", mark: "*", date: "11/17/26", style: "" };
const goodState = { sets: [goodSet], currentSetId: "1", tracking: true, showMarks: true };

/** Every reader the app calls on Save, Print and Export works and gives a usable result. */
function usable(doc: ScreenplayDoc, text = "A door opens."): void {
  doc.paragraphs();
  revisionState(doc).sets.map((set) => set.name.trim());
  const locks = pageLocks(doc);
  fdxExtras(doc);
  sceneNumbersLocked(doc);
  issuedSceneNumbers(doc);
  fdxLocksNeedAnchors(doc);
  reanchorPageLocks(doc);
  scriptNotes(doc);
  const script = doc.toScript();
  assert.ok(script.paragraphs.length);
  assert.ok(writeFountain(script).includes(text));
  assert.equal(parseXml(writeFdx(script)).name, "FinalDraft");
  assert.ok(paginate(script, locks ? { locks } : {}).pages.length);
  // What Save writes reads back.
  ScreenplayDoc.fromScript(JSON.parse(JSON.stringify(script))).toScript();
}

for (const key of ["fdx", "revisions", "pageLocks", "titlePage", "template", "fdxDeletedText", "sceneNumbersLocked"]) {
  for (const bad of [12, "wrong", true, [], {}, null]) {
    test(`wrong-shaped meta ${key} = ${JSON.stringify(bad)}`, () => {
      const doc = fresh();
      doc.meta.set(key, bad);
      usable(doc);
      const script = doc.toScript();
      if (key === "titlePage") assert.deepEqual(script.titlePage, []);
      if (key === "template") assert.equal(script.template, undefined);
      // Two of these are values the app writes itself: Unlock Pages (null) and Lock Scene Numbers (true).
      const own = (key === "pageLocks" && bad === null) || (key === "sceneNumbersLocked" && bad === true);
      if (key !== "titlePage" && key !== "template" && !own) assert.equal(script.fdx, undefined);
      if (key === "revisions") assert.deepEqual(revisionState(doc), NO_REVISIONS);
      if (key === "pageLocks") assert.equal(pageLocks(doc), null);
      // Ignored, never repaired: other clients may run older builds.
      assert.deepEqual(doc.meta.get(key), bad);
    });
  }
}

test("a title page keeps its good fields and drops the bad ones", () => {
  const doc = fresh();
  doc.meta.set("titlePage", [{ key: "title", values: ["DOOR", 3, null] }, null, { key: 5, values: [] }, { key: "author", values: "Nell" }]);
  usable(doc);
  assert.deepEqual(doc.toScript().titlePage, [{ key: "title", values: ["DOOR"] }]);
});

for (const [label, value] of Object.entries({
  lists: { rootAttrs: {}, contentAttrs: [], before: 1, after: null },
  "after is a number": { rootAttrs: [], contentAttrs: [], before: [], after: 7 },
  attributes: extras([node("Kept", [null, 1, ["Good", "yes"], ["Bad", {}], ["Long", "a", "b"]], [12, null, "kept"])]),
  children: extras([null, 12, node("Kept", [], [12, node("Nested", [], [false])])]),
  "node fields": extras([node("Kept"), { name: "NoLists" }, { name: "Bad", attrs: {}, children: [] }, { name: "Bad", attrs: [], children: "x" }]),
})) {
  test(`wrong-shaped raw FDX: ${label}`, () => {
    const doc = fresh();
    doc.meta.set("fdx", value);
    usable(doc);
    if (label === "lists" || label === "after is a number") assert.equal(doc.toScript().fdx, undefined);
    else {
      const after = doc.toScript().fdx!.after;
      assert.equal(after.length, 1);
      if (label === "attributes") assert.deepEqual(after[0], node("Kept", [["Good", "yes"]], ["kept"]));
      if (label === "children") assert.deepEqual(after[0], node("Kept", [], [node("Nested")]));
      if (label === "node fields") assert.deepEqual(after[0], node("Kept"));
    }
    assert.deepEqual(doc.meta.get("fdx"), value);
  });
}

test("a remote revision state keeps its good set beside bad sets and bad page locks", () => {
  const doc = fresh(), remote = new Y.Doc();
  Y.applyUpdate(remote, doc.encodeState());
  const state = { ...goodState, sets: [null, 3, {}, { ...goodSet, date: 7 }, { ...goodSet, color: "#" }, { ...goodSet, fdx: 4, textColor: 9 }] };
  remote.getMap("meta").set("revisions", state);
  remote.getMap("meta").set("pageLocks", { pages: "wrong" });
  Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote));
  usable(doc);
  assert.deepEqual(revisionState(doc), goodState);
  assert.equal(pageLocks(doc), null);
  assert.match(writeFdx(doc.toScript()), /Name="Blue \(11\/17\/26\)"/);
  assert.deepEqual(doc.meta.get("revisions"), state);
});

test("revision state fields of the wrong type fall back to their defaults", () => {
  const doc = fresh();
  doc.meta.set("revisions", { sets: [{ ...goodSet, fdx: [["Good", "yes"], ["Bad", 1], 7] }], currentSetId: 4, tracking: "yes", showMarks: 0, fdx: { Location: "1" } });
  usable(doc);
  assert.deepEqual(revisionState(doc), { sets: [{ ...goodSet, fdx: [["Good", "yes"]] }], currentSetId: null, tracking: false, showMarks: true });
});

test("bad page lock entries and anchors leave the good locks usable", () => {
  const doc = fresh(), id = doc.paragraphs()[0]!.id;
  const good = { number: "1", paragraphId: id, offset: 0 };
  doc.meta.set("pageLocks", { pages: [null, 2, {}, { ...good, offset: "0" }, good,
    { ...good, number: "2", offset: 1, anchor: { item: { client: "bad", clock: -1 } }, paragraphIds: [id, 12], level: "bad" },
    { ...good, number: "3", offset: 2, anchor: { item: { client: 999999, clock: 5 } } }] });
  usable(doc);
  assert.deepEqual(pageLocks(doc), [good, { ...good, number: "2", offset: 1, paragraphIds: [id] }, { ...good, number: "3", offset: 2 }]);
});

const paragraphFields: Record<string, unknown[]> = {
  sceneNumber: [12, {}], sceneId: [12], dual: ["bad", {}, { block: 12, side: 1 }, { block: "b", side: 3 }],
  alignment: [12, {}], depth: ["2", {}, -1, 0, 1.5, Infinity], startsNewPage: ["yes", 1, false], boneyard: ["yes", {}, false],
  fdx: [12, "bad", [], { attrs: 1, before: 2, after: "bad", emptyText: {}, dualWrapper: 3, type: {}, idAttr: 12, textless: "yes" }],
};
for (const [field, values] of Object.entries(paragraphFields)) {
  for (const bad of values) {
    test(`wrong-shaped paragraph ${field} = ${JSON.stringify(bad)}`, () => {
      const doc = fresh();
      doc.body.format(0, 1, { [field]: bad });
      usable(doc);
      const p = doc.toScript().paragraphs[0]!;
      assert.equal(p[field as keyof typeof p], undefined);
    });
  }
}

test("a remote co-writer's bad paragraph and run attributes are ignored", () => {
  const doc = fresh(), remote = new Y.Doc();
  Y.applyUpdate(remote, doc.encodeState());
  remote.getText("body").format(0, 1, { sceneNumber: 12, dual: "x", depth: 1e30 });
  remote.getText("body").format(1, 3, { "fdx:Font": 12, "fdx:a b": "x", "fdx:Size": "12" });
  Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote));
  usable(doc);
  const p = doc.toScript().paragraphs[0]!;
  assert.equal(p.sceneNumber, undefined);
  assert.equal(p.dual, undefined);
  assert.deepEqual(p.runs[0], { text: "INT", fdx: { Size: "12" } });
});

test("paragraph FDX keeps good XML beside bad attributes and children", () => {
  const doc = fresh();
  doc.body.format(0, 1, { fdx: { attrs: [null, ["Good", "yes"], ["Bad", 12]], idAttr: "a b", after: [12, node("Kept", [], [null, "text"])] } });
  usable(doc);
  assert.deepEqual(doc.toScript().paragraphs[0]!.fdx, { attrs: [["Good", "yes"]], after: [node("Kept", [], ["text"])] });
});

const badNames = ["", "1bad", "-bad", "a b", 'a b="x"><Evil/', "a<b", "a>b", 'a"b', "a'b", "a=b", "a/b", "a&b", "a\nb", "a\u0000b", "\uD800"];
for (const name of badNames) {
  test(`invalid XML name ${JSON.stringify(name)} from runs and raw FDX is dropped`, () => {
    const doc = fresh();
    doc.body.format(1, 3, { [`fdx:${name}`]: "hostile", "fdx:Good": "kept", "fdx:BadValue": 12 });
    doc.meta.set("fdx", extras([node(name, [], [node("Evil")]), node("Kept", [[name, "hostile"], ["Good", "kept"]])]));
    usable(doc);
    const script = doc.toScript(), xml = writeFdx(script);
    assert.doesNotMatch(xml, /Evil|hostile|BadValue/);
    assert.deepEqual(script.paragraphs[0]!.runs[0]!.fdx, { Good: "kept" });
    assert.deepEqual(script.fdx!.after, [node("Kept", [["Good", "kept"]])]);
    assert.equal(serializeXml(node(name) as XmlNode), "");
  });
}

test("the serializer drops malformed values, subtrees and repeated attributes, and keeps Unicode XML names", () => {
  const raw = node("Root", [null, 12, ["Bad", {}], ["Good", "yes"], ["Good", "again"], ["x:y", "z"]],
    [null, 12, node("1bad", [], [node("Evil")]), node("Écriture", [["字", "kept"]], ["text"])]);
  assert.equal(serializeXml(raw as XmlNode), '<Root Good="yes" x:y="z">\n  <Écriture 字="kept">text</Écriture>\n</Root>');
  assert.equal(serializeXml(null as unknown as XmlNode), "");
  assert.equal(serializeXml({ name: "Root", attrs: 1, children: [] } as unknown as XmlNode), "");
});

test("invalid own production state falls back to what the FDX file recorded", () => {
  const doc = fresh();
  doc.meta.set("fdx", extras([node("Revisions", [["ActiveSet", "1"]], [node("Revision", [["ID", "1"], ["Name", "Blue"]])]),
    node("SceneNumberOptions", [["ColdOpenSceneNumbersLocked", "Yes"]]),
    node("LockedPages", [], [node("LockedPage", [["PageNumber", "1"], [LOCK_PARAGRAPH_ATTR, doc.paragraphs()[0]!.id]])])]));
  doc.meta.set("revisions", 12);
  doc.meta.set("sceneNumbersLocked", {});
  doc.meta.set("pageLocks", { pages: 1 });
  usable(doc);
  assert.equal(revisionState(doc).sets[0]!.name, "Blue");
  assert.equal(sceneNumbersLocked(doc), true);
  assert.equal(pageLocks(doc)?.[0]?.number, "1");
});

test("malformed deletion XML is ignored and not rewritten", () => {
  const doc = fresh(), bad = node("DeletedText", [], [null, 12, node("DeletedTextLocation", [["RevisionID", {}]])]);
  doc.meta.set("fdxDeletedText", bad);
  usable(doc);
  assert.equal(clearRevisionMarks(doc, null), 0);
  assert.deepEqual(doc.meta.get("fdxDeletedText"), bad);
  // A node that is not DeletedText cannot stand in for another top-level element.
  doc.meta.set("fdxDeletedText", node("TitlePage"));
  usable(doc);
  assert.equal(doc.toScript().fdx, undefined);
});

test("wrong-shaped omitted paragraphs cannot break export", () => {
  const doc = fresh();
  const kept = JSON.stringify([null, 12, {}, { id: "bad", type: "action", runs: [12, { text: "Kept" }], dual: 5 }]);
  doc.body.format(0, 1, { fdx: { after: [node("OmittedScene", [["x-paragraphs", kept]])] } });
  usable(doc);
  assert.deepEqual(omittedParagraphs(doc.paragraphs()[0]!), [{ id: "bad", type: "action", runs: [{ text: "Kept" }] }]);
  assert.match(writeFdx(doc.toScript()), /<OmittedScene>\s*<Paragraph Type="Action" id="bad">\s*<Text>Kept<\/Text>/);
});

test("wrong-shaped ScriptNote anchors cannot break projection", () => {
  const doc = fresh();
  doc.meta.set(SCRIPT_NOTE_ANCHORS, { bad: null, another: 12, detached: { originalNode: 12, scope: "gone" }, half: { start: { paragraphId: "x" } } });
  usable(doc);
});

test("wrong-shaped move records cannot break stranded-move detection or the next move", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain("INT. ONE - DAY\n\nOne.\n\nINT. TWO - DAY\n\nTwo.\n"));
  const remote = new Y.Doc();
  Y.applyUpdate(remote, doc.encodeState());
  const notices: unknown[] = [];
  doc.meta.observe((_event, transaction) => notices.push(...strandedByMove(doc, transaction)));
  const at = Y.getState(remote.store, remote.clientID);
  remote.getMap("meta").set(`move.${remote.clientID}`, [null, 5, { sv: "", at: 1, spans: [5], chars: "x" }, { sv: "AA==", at, spans: [5, [1]], chars: [] }]);
  Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote));
  assert.deepEqual(notices, []);
  doc.meta.set(`move.${doc.ydoc.clientID}`, [null, { at: "x" }]);
  const second = doc.scenes()[1]!.sceneId;
  assert.equal(moveScenes(doc, [second], doc.scenes()[0]!.sceneId), true);
  assert.equal((doc.meta.get(`move.${doc.ydoc.clientID}`) as unknown[]).length, 1);
  usable(doc, "One.");
});

test("valid shared values keep FDX bytes and the stored metadata object", () => {
  const script = parseFdx('<FinalDraft DocumentType="Script" Version="5"><Content><Paragraph Type="Scene Heading" id="h" Number="1"><Text Font="Courier">INT. ROOM - DAY</Text></Paragraph></Content><Custom Good="yes"><Nested>kept</Nested></Custom></FinalDraft>');
  const doc = ScreenplayDoc.fromScript(script);
  assert.equal(writeFdx(doc.toScript()), writeFdx(script));
  const raw = doc.meta.get("fdx") as FdxDocumentExtras;
  assert.equal(fdxExtras(doc), raw);
  assert.deepEqual(doc.toScript(), script);
});

// ----- Follow-up review -------------------------------------------------------------------------------------

test("a section depth is capped at 32, what Fountain export writes", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain("# ACT ONE\n\nINT. ROOM - DAY\n\nA door opens.\n"));
  doc.body.format(0, 1, { depth: 32 });
  usable(doc);
  assert.equal(doc.toScript().paragraphs[0]!.depth, 32);
  assert.match(writeFountain(doc.toScript()), new RegExp(`^${"#".repeat(32)} ACT ONE`));
  for (const depth of [33, 40, 1e15, 1e30]) {
    doc.body.format(0, 1, { depth });
    usable(doc);
    assert.equal(doc.toScript().paragraphs[0]!.depth, 32);
  }
  // A local change reads the same as a rebuild of the paragraph list.
  doc.setField(doc.paragraphs()[0]!.id, "depth", 40);
  assert.equal(doc.paragraphs()[0]!.depth, 32);
  assert.equal(ScreenplayDoc.fromScript(doc.toScript()).paragraphs()[0]!.depth, 32);
  const forty = parseFountain(`${"#".repeat(40)} DEEP\n\nINT. ROOM - DAY\n\nA door opens.\n`);
  assert.match(writeFountain(ScreenplayDoc.fromScript(forty).toScript()), new RegExp(`^${"#".repeat(32)} DEEP`));
});

test("undefined elements that arrive over the wire are left out of every list", () => {
  const doc = fresh(), remote = new Y.Doc(), id = doc.paragraphs()[0]!.id;
  Y.applyUpdate(remote, doc.encodeState());
  const meta = remote.getMap("meta");
  meta.set("fdx", { rootAttrs: [undefined, ["Version", "5"]], contentAttrs: [], before: [undefined],
    after: [undefined, node("Kept", [undefined, ["Good", "yes"]], [undefined, "text"]), node("Nested", [], [node("Inner", [], [undefined])])] });
  meta.set("revisions", { ...goodState, sets: [undefined, goodSet] });
  meta.set("pageLocks", { pages: [undefined, { number: "1", paragraphId: id, offset: 0, paragraphIds: [undefined, id] }] });
  meta.set("titlePage", [undefined, { key: "title", values: [undefined, "DOOR"] }]);
  meta.set("fdxDeletedText", node("DeletedText", [], [undefined]));
  remote.getText("body").format(0, 1, { fdx: { attrs: [undefined], after: [undefined, node("Kept")] } });
  Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote));
  // The wire really delivers undefined, not a dropped element.
  assert.deepEqual((doc.meta.get("revisions") as { sets: unknown[] }).sets, [undefined, goodSet]);
  usable(doc);
  const script = doc.toScript();
  assert.deepEqual(script.fdx!.rootAttrs, [["Version", "5"]]);
  assert.deepEqual(script.fdx!.before, []);
  assert.deepEqual(script.fdx!.after.slice(0, 2), [node("Kept", [["Good", "yes"]], ["text"]), node("Nested", [], [node("Inner")])]);
  assert.deepEqual(script.fdx!.after.find((n) => n.name === "DeletedText"), node("DeletedText"));
  assert.deepEqual(script.paragraphs[0]!.fdx, { attrs: [], after: [node("Kept")] });
  assert.deepEqual(script.titlePage, [{ key: "title", values: ["DOOR"] }]);
  assert.deepEqual(revisionState(doc).sets, [goodSet]);
  assert.deepEqual(pageLocks(doc), [{ number: "1", paragraphId: id, offset: 0, paragraphIds: [id] }]);
  assert.doesNotMatch(JSON.stringify(script), /null/);
});

test("move records with holes or undefined in their spans are not records", () => {
  const sparse = [1, 2];
  sparse.length = 3;
  assert.equal(isMoveKnowledge({ sv: "", at: 1, spans: [sparse], chars: [] }), false);
  assert.equal(isMoveKnowledge({ sv: "", at: 1, spans: [[1, undefined, 2]], chars: [] }), false);
  assert.equal(isMoveKnowledge({ sv: "", at: 1, spans: [[1, 2, 0]], chars: [] }), false);
  assert.equal(isMoveKnowledge({ sv: "", at: 1, spans: [], chars: [[1, 2, 0]] }), false);
  assert.equal(isMoveKnowledge({ sv: "", at: 1, spans: [[1, 2, 3]], chars: [] }), true);
});

test("stranded-move detection still finds typing when a remote move record's spans arrive unsorted", () => {
  const doc = ScreenplayDoc.fromScript({
    titlePage: [],
    paragraphs: ["a", "b", "c", "d"].flatMap((id) => [
      { id, sceneId: id, type: "sceneHeading" as const, runs: [{ text: `INT. ${id} - DAY` }] },
      { id: `${id}t`, type: "action" as const, runs: [{ text: "abcdef" }] },
    ]),
  });
  const peer = ScreenplayDoc.fromUpdate(doc.encodeState());
  const mover = ScreenplayDoc.fromUpdate(doc.encodeState());
  peer.insertText("dt", 3, "XYZ");
  const notices: unknown[] = [];
  peer.body.observe((_event, transaction) => notices.push(...strandedByMove(peer, transaction)));
  const writeMeta = mover.meta.set.bind(mover.meta);
  mover.meta.set = ((key: string, value: unknown) => {
    if (key.startsWith("move.") && Array.isArray(value)) {
      return writeMeta(key, value.map((rec) => ({ ...rec, spans: [...rec.spans].reverse(), chars: [...rec.chars].reverse() })));
    }
    return writeMeta(key, value);
  }) as typeof mover.meta.set;
  moveScenes(mover, ["b", "d"], "a");
  const rec = (mover.meta.get(`move.${mover.ydoc.clientID}`) as { spans: unknown[] }[]).at(-1)!;
  assert.ok(rec.spans.length >= 2, "disjoint move produces multiple spans for one client");
  peer.applyUpdate(mover.encodeState(), "net");
  assert.equal(notices.length, 1);
  doc.ydoc.destroy(); peer.ydoc.destroy(); mover.ydoc.destroy();
});

test("a project tag with a malformed category number cannot break toScript", () => {
  for (const categoryNumber of [{ toString: 1 }, { valueOf: 1, toString: 1 }, "7", -1, 1.5, null]) {
    const doc = fresh();
    doc.meta.set("fdx.tagDefinition.t1", { id: "t1", label: "Lamp", category: "Props", categoryId: "cat", categoryNumber });
    usable(doc);
    assert.match(writeFdx(doc.toScript()), /<TagCategory Id="cat" Name="Props" Number="25"/);
  }
  const doc = fresh();
  doc.meta.set("fdx.tagDefinition.t2", { id: "t2", label: "Lamp", category: "Props", categoryId: "cat", categoryNumber: 6 });
  assert.match(writeFdx(doc.toScript()), /<TagCategory Id="cat" Name="Props" Number="6"/);
});

test("run flags count only when true, as the app writes them", () => {
  const doc = fresh();
  doc.body.format(1, 3, { note: {}, bold: 12, italic: "yes", underline: {}, styleExtra: 5 });
  doc.body.format(6, 4, { note: 12, strikeout: [], allCaps: true });
  usable(doc);
  assert.deepEqual(doc.toScript().paragraphs[0]!.runs, [{ text: "INT. " }, { text: "ROOM", allCaps: true }, { text: " - DAY" }]);
  assert.match(writeFdx(doc.toScript()), /<Text>INT\. <\/Text>\s*<Text Style="AllCaps">ROOM<\/Text>/);
  // A valid document keeps its formatting.
  const styled = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "p", type: "action", runs: [
    { text: "Bold", bold: true }, { text: " note", note: true }, { text: " extra", styleExtra: "Shadow", italic: true }] }] });
  assert.deepEqual(styled.toScript().paragraphs[0]!.runs, [{ text: "Bold", bold: true }, { text: " note", note: true }, { text: " extra", italic: true, styleExtra: "Shadow" }]);
});

test("ScriptNote anchors whose bytes name another root type, or do not decode, are left out", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx('<FinalDraft DocumentType="Script" Version="5"><Content><Paragraph Type="Action" id="a"><Text>A door opens.</Text></Paragraph></Content><ScriptNotes><ScriptNote Range="2,6"><Paragraph><Text>Check.</Text></Paragraph></ScriptNote></ScriptNotes></FinalDraft>'));
  const anchors = doc.meta.get(SCRIPT_NOTE_ANCHORS) as Record<string, { start: { relative: number[] }; end: { relative: number[] } }>;
  assert.equal(scriptNotes(doc)[0]!.state, "anchored");
  const elsewhere = Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(new Y.Doc().getText("intruder"), 0)));
  for (const relative of [elsewhere, [255, 255, 255, 255], []]) {
    const tampered = Object.fromEntries(Object.entries(anchors).map(([key, anchor]) => [key, { ...anchor, start: { ...anchor.start, relative }, end: { ...anchor.end, relative } }]));
    doc.meta.set(SCRIPT_NOTE_ANCHORS, tampered);
    usable(doc);
    assert.doesNotThrow(() => scriptNotes(doc));
    doc.toScript();
    assert.equal(doc.ydoc.share.has("intruder"), false);
  }
});

test("story map points of the wrong shape are skipped", () => {
  const doc = fresh();
  const values = { "a.name": 12, "b.name": "Midpoint", "b.position": "x", "b.sceneId": 5, "c.name": { toString: 1 }, "d.name": "End", "d.position": Number.NaN };
  for (const [key, value] of Object.entries(values)) doc.meta.set(STRUCTURE_POINT_PREFIX + key, value);
  assert.deepEqual(structurePoints(doc), [{ id: "b", name: "Midpoint", position: 0 }, { id: "d", name: "End", position: 0 }].sort((x, y) => x.name.localeCompare(y.name)));
});

// ----- Last review round ------------------------------------------------------------------------------------

const deep = (levels: number, leaf: unknown = node("Leaf")): unknown => {
  let current = leaf;
  for (let i = 0; i < levels; i++) current = node("X", [], [current]);
  return current;
};
const depthOf = (value: XmlNode): number => {
  let levels = 1;
  for (let current = value; current.children[0] && typeof current.children[0] !== "string"; current = current.children[0]) levels++;
  return levels;
};

test("XML nested deeper than 64 levels is cut at 64, wherever it is stored", () => {
  const doc = fresh(), remote = new Y.Doc();
  Y.applyUpdate(remote, doc.encodeState());
  remote.getMap("meta").set("fdx", extras([deep(1000), node("Kept")]));
  remote.getText("body").format(0, 1, { fdx: { after: [deep(1000)], dualWrapper: deep(1000) } });
  Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote));
  usable(doc);
  const script = doc.toScript();
  assert.equal(depthOf(script.fdx!.after[0]!), 64);
  assert.deepEqual(script.fdx!.after[1], node("Kept"));
  assert.equal(depthOf(script.paragraphs[0]!.fdx!.after![0]!), 64);
  assert.equal(depthOf(script.paragraphs[0]!.fdx!.dualWrapper!), 64);
  // 64 levels, the most kept, come through unchanged.
  const fits = deep(63);
  doc.meta.set("fdx", extras([fits]));
  assert.equal(depthOf(doc.toScript().fdx!.after[0]!), 64);
  assert.equal(fdxExtras(doc)!.after[0], fits);
  doc.meta.set("fdxDeletedText", node("DeletedText", [], [deep(1000)]));
  usable(doc);
});

test("deep values under keys no reader uses cannot reach the saved script", () => {
  const doc = fresh(), id = doc.paragraphs()[0]!.id;
  doc.meta.set("fdx", { ...extras([{ ...node("Kept"), junk: deep(1000) }]), junk: deep(1000) });
  doc.body.format(0, 1, { dual: { block: "b", side: 1, junk: deep(1000) } });
  doc.meta.set("pageLocks", { pages: [{ number: "1", paragraphId: id, offset: 0, anchor: { tname: "body", junk: deep(1000) } }] });
  usable(doc);
  const script = doc.toScript();
  assert.deepEqual(Object.keys(script.fdx!), ["rootAttrs", "contentAttrs", "before", "after"]);
  assert.deepEqual(script.fdx!.after[0], node("Kept"));
  assert.deepEqual(script.paragraphs[0]!.dual, { block: "b", side: 1 });
});

test("ScriptNote anchors keep only the fields they use, and deep original nodes are cut", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx('<FinalDraft DocumentType="Script" Version="5"><Content><Paragraph Type="Action" id="a"><Text>A door opens.</Text></Paragraph></Content><ScriptNotes><ScriptNote Range="2,6"><Paragraph><Text>Check.</Text></Paragraph></ScriptNote></ScriptNotes></FinalDraft>'));
  const anchors = doc.meta.get(SCRIPT_NOTE_ANCHORS) as Record<string, Record<string, unknown> & { start: object; end: object }>;
  doc.meta.set(SCRIPT_NOTE_ANCHORS, Object.fromEntries(Object.entries(anchors).map(([key, anchor]) => [key, { ...anchor,
    start: { ...anchor.start, junk: deep(1000) }, end: { ...anchor.end, junk: deep(1000) }, originalNode: deep(1000), scope: "gone", junk: deep(1000) }])));
  usable(doc);
  assert.equal(scriptNotes(doc)[0]!.state, "anchored");
});

test("soft counts only when true, in every reader that finds paragraph starts", () => {
  const doc = fresh(), second = doc.paragraphs()[1]!;
  const at = doc.range(second.id).start - 1;
  for (const soft of [{}, [], 1, "yes"]) {
    doc.body.format(at, 1, { soft });
    assert.equal(doc.paragraphs().length, 2);
    usable(doc);
  }
  applyTextEdits(doc, [{ paragraphId: second.id, from: 0, to: 1, text: "The", kind: "mention" }]);
  assert.equal(doc.paragraphs()[1]!.runs.map((run) => run.text).join(""), "The door opens.");
});

test("a Content or FinalDraft element in the FDX extras cannot stand in for the script", () => {
  const doc = fresh(), remote = new Y.Doc();
  Y.applyUpdate(remote, doc.encodeState());
  const fake = node("Paragraph", [["Type", "Action"]], [node("Text", [], ["FAKE SCRIPT"])]);
  remote.getMap("meta").set("fdx", { rootAttrs: [], contentAttrs: [], before: [node("Content", [], [fake]), node("FinalDraft", [], [node("Content", [], [fake])])], after: [node("Content", [], [fake])] });
  Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(remote));
  usable(doc);
  const back = parseFdx(writeFdx(doc.toScript()));
  assert.deepEqual(back.paragraphs.map((p) => p.runs.map((run) => run.text).join("")), ["INT. ROOM - DAY", "A door opens."]);
  assert.doesNotMatch(writeFdx(doc.toScript()), /FAKE/);
});

test("only the first TitlePage element is written", () => {
  const doc = fresh();
  const page = (text: string) => node("TitlePage", [], [node("Content", [], [node("Paragraph", [], [node("Text", [], [text])])])]);
  doc.meta.set("fdx", { rootAttrs: [], contentAttrs: [], before: [page("REAL")], after: [page("DECOY")] });
  usable(doc);
  const xml = writeFdx(doc.toScript());
  assert.equal(xml.match(/<TitlePage/g)?.length, 1);
  assert.match(xml, /REAL/);
  assert.doesNotMatch(xml, /DECOY/);
});

test("a Backlot baseline with holes in its lists is rejected", () => {
  const scene = { sceneId: "s", headingId: "h", heading: "INT. ROOM - DAY", omitted: false, eighths: 8, characters: [], tags: [] };
  const holes = <T,>(length: number, ...items: T[]) => Object.assign(new Array<T>(length), items);
  assert.equal(backlotBaseline({ version: 1, scenes: new Array(1), sentAt: "x", projectId: "p" }), null);
  assert.equal(isProductionSnapshot({ version: 1, scenes: [{ ...scene, characters: holes(2, "NELL") }] }), false);
  assert.equal(isProductionSnapshot({ version: 1, scenes: [{ ...scene, tags: holes(1) }] }), false);
  assert.equal(isProductionSnapshot({ version: 1, scenes: [scene] }), true);
});

test("a title page key or value with line breaks cannot add paragraphs in Fountain", () => {
  const doc = fresh();
  doc.meta.set("titlePage", [{ key: "Credit\n\nINT. INJECTED - NIGHT\n\nHidden action", values: ["x"] }, { key: "Bad: key", values: ["y"] },
    { key: "Title", values: ["DOOR\n\nINT. INJECTED - NIGHT\n\nHidden action"] }, { key: "Author", values: ["Nell"] }]);
  usable(doc);
  const script = doc.toScript();
  assert.deepEqual(script.titlePage.map((field) => field.key), ["Title", "Author"]);
  const back = parseFountain(writeFountain(script));
  assert.deepEqual(back.paragraphs.map((p) => p.type), ["sceneHeading", "action"]);
  assert.deepEqual(back.titlePage, [{ key: "Title", values: ["DOOR", "INT. INJECTED - NIGHT", "Hidden action"] }, { key: "Author", values: ["Nell"] }]);
});
