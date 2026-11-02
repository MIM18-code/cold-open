import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import {
  NO_REVISIONS, ScreenplayDoc, addDeletionMark, adjustDeletionMarks, clearRevisionMarks, deletionMarks, importedDeletionMarks, isOmitted,
  keepOmittedScenes, locksFromFdx, lockPages, markInserted, newRevisionSet, omitScene, pageLocks, pageRevisions, paginate,
  numberAddedScenes, parseFdx, plainText, reanchorPageLocks, restoreOmittedScenes, revisedRanges, setSceneNumbersLocked, revisionColor, revisionLabel,
  revisionState, revisionsFromFdx, revisionsNode, setRevisionState, unlockPages, unomitScene, updateRevisionState, writeFdx, type FdxDocumentExtras, type Paragraph, type RevisionState,
} from "../src/index.ts";
import { parseXml } from "../src/xml.ts";
import { canonical, firstDifference } from "./canonical.ts";

const sentences = (count: number, word = "Sentence") => Array.from({ length: count }, (_, i) => `${word} ${String(i).padStart(2, "0")} is here.`).join(" ");

function scenes(count: number): Paragraph[] {
  const out: Paragraph[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({ id: `h${i}`, type: "sceneHeading", sceneId: `s${i}`, sceneNumber: String(i), runs: [{ text: `INT. ROOM ${i} - DAY` }] });
    out.push({ id: `a${i}`, type: "action", runs: [{ text: sentences(8) }] });
    out.push({ id: `c${i}`, type: "character", runs: [{ text: "NELL" }] });
    out.push({ id: `d${i}`, type: "dialogue", runs: [{ text: sentences(4) }] });
  }
  return out;
}

const docOf = (paragraphs: Paragraph[]) => ScreenplayDoc.fromScript({ titlePage: [], paragraphs });

// A synthetic Final Draft file with revision sets, revised text, a deletion and locked pages.
const FDX = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Number="1" Type="Scene Heading" id="h1"><Text RevisionID="0">INT. KITCHEN - DAY</Text></Paragraph>
    <Paragraph Type="Action" id="a1"><Text RevisionID="0">Nell </Text><Text RevisionID="2">slowly </Text><Text RevisionID="0">pours coffee.</Text></Paragraph>
    <Paragraph Number="2" Type="Scene Heading" id="h2"><Text RevisionID="0">EXT. YARD - DAY</Text></Paragraph>
    <Paragraph Type="Action" id="a2"><Text RevisionID="1">The dog barks.</Text></Paragraph>
  </Content>
  <LockedPages>
    <LockedPage Deleted="0" LevelIndex="0" LockLevel="0" PageNumber="1" Position="0"/>
    <LockedPage Deleted="0" LevelIndex="1" LockLevel="0" PageNumber="2" Position="54"/>
  </LockedPages>
  <Revisions ActiveSet="2" Location="7.75" RevisionMode="Yes" RevisionsShown="Active" ShowAllMarks="No" ShowAllSets="No" ShowPageColor="No">
    <Revision Color="#00000000FFFF" FullRevision="No" ID="1" Mark="*" Name="Blue Rev. (10/01/26)" PageColor="#C6C6EDEDFEFE" Style=""/>
    <Revision Color="#FFFF0000FFFF" FullRevision="No" ID="2" Mark="+" Name="Pink Rev. (mm/dd/yy)" PageColor="#FDFDCCCCD4D4" Style=""/>
  </Revisions>
  <DeletedText>
    <DeletedTextLocation Offset="62" RevisionID="1"/>
  </DeletedText>
</FinalDraft>
`;

const same = (a: string, b: string) => firstDifference(canonical(parseXml(a)), canonical(parseXml(b)));

test("the revision color order: White, Blue to Cherry, then Second Blue and onward", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => revisionColor(i).name),
    ["White", "Blue", "Pink", "Yellow", "Green", "Goldenrod", "Buff", "Salmon", "Cherry"]);
  assert.equal(revisionColor(9).name, "Second Blue");
  assert.equal(revisionColor(10).name, "Second Pink");
  assert.equal(revisionColor(16).name, "Second Cherry");
  assert.equal(revisionColor(17).name, "Third Blue");
  assert.equal(revisionColor(9).value, revisionColor(1).value);
});

test("new sets follow the order and number up from Final Draft's IDs", () => {
  let state: RevisionState = NO_REVISIONS;
  const blue = newRevisionSet(state, { date: "10/30/26" });
  assert.deepEqual({ ...blue }, { id: "1", name: "Blue Rev.", color: "#C6EDFE", mark: "*", date: "10/30/26", style: "" });
  assert.equal(revisionLabel(blue), "Blue Rev. 10/30/26");
  state = { ...state, sets: [blue] };
  const pink = newRevisionSet(state);
  assert.equal(pink.id, "2");
  assert.equal(pink.name, "Pink Rev.");
  assert.match(pink.date, /^\d\d\/\d\d\/\d\d$/);
});

test("reads Final Draft's Revisions element and writes back what it read", () => {
  const script = parseFdx(FDX);
  const state = revisionsFromFdx(script.fdx)!;
  assert.equal(state.tracking, true);
  assert.equal(state.currentSetId, "2");
  assert.deepEqual(state.sets.map((set) => [set.id, set.name, set.date, set.color, set.mark, set.textColor]), [
    ["1", "Blue Rev.", "10/01/26", "#C6EDFE", "*", "#0000FF"],
    ["2", "Pink Rev. (mm/dd/yy)", "", "#FDCCD4", "+", "#FF00FF"],
  ]);
  const original = [...script.fdx!.before, ...script.fdx!.after].find((node) => node.name === "Revisions")!;
  assert.equal(firstDifference(canonical(revisionsNode(state)), canonical(original)), undefined);
  // An untouched file round-trips exactly, locks and deletions included.
  assert.equal(same(writeFdx(script), FDX), undefined);
});

test("the document's revision state falls back to the FDX, and a change rewrites the FDX element", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx(FDX));
  assert.equal(revisionState(doc).currentSetId, "2");
  updateRevisionState(doc, (state) => ({ tracking: false, sets: [...state.sets, newRevisionSet(state, { date: "10/30/26" })] }));
  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<Revisions ActiveSet="2" Location="7.75" RevisionMode="No" RevisionsShown="Active"/);
  assert.match(xml, /<Revision Color="#000000000000" FullRevision="No" ID="3" Mark="\*" Name="Yellow Rev. \(10\/30\/26\)" PageColor="#FDFDFFFFABAB" Style=""\/>/);
  assert.equal(revisionsFromFdx(parseFdx(xml).fdx)!.sets.length, 3);
});

test("a script without FDX data gets a Revisions element of its own", () => {
  const doc = docOf(scenes(1));
  const state = { ...NO_REVISIONS, sets: [newRevisionSet(NO_REVISIONS, { date: "10/30/26" })], currentSetId: "1", tracking: true };
  setRevisionState(doc, state);
  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<Revisions ActiveSet="1" Location="7.75" RevisionMode="Yes" RevisionsShown="All" ShowPageColor="No">/);
  assert.match(xml, /Name="Blue Rev. \(10\/30\/26\)"/);
  assert.deepEqual(revisionState(ScreenplayDoc.fromScript(parseFdx(xml))).sets.map((set) => set.name), ["Blue Rev."]);
});

test("marking inserted text, deletion marks and clearing them, through FDX", () => {
  const doc = docOf(scenes(2));
  doc.insertText("a1", 0, "Later. ");
  markInserted(doc, doc.range("a1").start, "Later. ", "1");
  addDeletionMark(doc, "d2", 5, "2");
  addDeletionMark(doc, "d2", 9, "2");
  assert.deepEqual(revisedRanges(doc.paragraph("a1")), [{ from: 0, to: 7, setId: "1" }]);
  assert.deepEqual(deletionMarks(doc.paragraph("d2")), [{ offset: 5, setId: "2" }, { offset: 9, setId: "2" }], "a mark for each place");

  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<Text RevisionID="1">Later\. <\/Text>/);
  // The mark moves out of the paragraph into DeletedText, counted the way Final Draft counts.
  const script = doc.toScript();
  const before = script.paragraphs.slice(0, script.paragraphs.findIndex((p) => p.id === "d2"));
  const offset = before.reduce((sum, p) => sum + plainText(p.runs).length + 1, 0) + 9;
  assert.match(xml, new RegExp(`<DeletedText>\\s*<DeletedTextLocation Offset="${offset - 4}" RevisionID="2"/>\\s*<DeletedTextLocation Offset="${offset}" RevisionID="2"/>\\s*</DeletedText>`));
  assert.doesNotMatch(xml.slice(0, xml.indexOf("</Content>")), /DeletedTextLocation/);
  // Reading it back puts the marks in their paragraph again.
  const back = parseFdx(xml);
  assert.deepEqual(deletionMarks(back.paragraphs.find((p) => p.id === "d2")!), [{ offset: 5, setId: "2" }, { offset: 9, setId: "2" }]);
  assert.equal(importedDeletionMarks(back).size, 0);

  assert.equal(clearRevisionMarks(doc, "2"), 2);
  assert.deepEqual(deletionMarks(doc.paragraph("d2")), []);
  assert.deepEqual(revisedRanges(doc.paragraph("a1")).length, 1);
  clearRevisionMarks(doc, null);
  assert.deepEqual(revisedRanges(doc.paragraph("a1")), []);
  assert.equal(doc.paragraph("a1").runs.length, 1);
});

test("pages with revised lines: which lines get a mark and the latest set on the page", () => {
  const doc = docOf(scenes(16));
  const state: RevisionState = { ...NO_REVISIONS, sets: [newRevisionSet(NO_REVISIONS), { ...newRevisionSet(NO_REVISIONS), id: "2", name: "Pink Rev." }] };
  markInserted(doc, doc.range("d1").start, plainText(doc.paragraph("d1").runs).slice(0, 10), "2");
  markInserted(doc, doc.range("a1").start, "Sentence", "1");
  addDeletionMark(doc, "a16", 0, "1");
  const script = doc.toScript();
  const pagination = paginate(script);
  const pages = pageRevisions(script, pagination, state);
  assert.equal(pages[0]!.set?.name, "Pink Rev.", "Pink is later than Blue");
  const marked = pages[0]!.marked.map((index) => pagination.pages[0]!.lines[index]!);
  assert.deepEqual(marked.map((line) => [line.paragraphId, line.from]), [["a1", 0], ["d1", 0]]);
  const last = pages.findIndex((page, index) => pagination.pages[index]!.lines.some((line) => line.paragraphId === "a16"));
  assert.equal(pages[last]!.set?.name, "Blue Rev.");
  assert.ok(pages.some((page) => !page.marked.length && !page.set), "an unrevised page");
});

test("locked pages follow their text through edits and round-trip through FDX", () => {
  const doc = docOf(scenes(10));
  assert.equal(pageLocks(doc), null);
  const pagination = paginate(doc.toScript());
  const locks = lockPages(doc, pagination);
  assert.equal(locks.length, pagination.pages.length);
  assert.deepEqual(locks.map((lock) => lock.number), pagination.pages.map((page) => page.number));
  assert.deepEqual(pageLocks(doc), locks);

  // Text added near the top moves every later Position, which FDX export recomputes.
  doc.insertText("a1", 0, "Added. ");
  const xml = writeFdx(doc.toScript());
  const positions = [...xml.matchAll(/<LockedPage [^>]*Position="(\d+)"/g)].map((match) => Number(match[1]));
  assert.equal(positions[0], 0);
  const lock = locks[1]!;
  const paragraphs = doc.toScript().paragraphs;
  const start = paragraphs.slice(0, paragraphs.findIndex((p) => p.id === lock.paragraphId)).reduce((sum, p) => sum + plainText(p.runs).length + 1, 0);
  assert.equal(positions[1], start + lock.offset);
  assert.doesNotMatch(xml, /x-paragraph|x-offset/);

  // Reading it back ties the pages to the same paragraphs.
  const back = locksFromFdx(parseFdx(xml))!;
  assert.deepEqual(back.map((l) => [l.number, l.paragraphId, l.offset]), locks.map((l) => [l.number, l.paragraphId, l.offset]));

  unlockPages(doc);
  assert.equal(pageLocks(doc), null);
  assert.match(writeFdx(doc.toScript()), /<LockedPages\/>/);
});

test("relocking keeps A-page numbers and gives newly locked pages the next lock level", () => {
  const doc = docOf(scenes(10));
  lockPages(doc, paginate(doc.toScript()));
  doc.insertText("a3", 0, `${sentences(40, "Extra")} `);
  const grown = paginate(doc.toScript(), { locks: pageLocks(doc)! });
  assert.ok(grown.pages.some((page) => /A$/.test(page.number)), "an A-page");
  const relocked = lockPages(doc, grown);
  const a = relocked.find((lock) => /A$/.test(lock.number))!;
  assert.equal(a.level, 1);
  assert.equal(relocked[0]!.level, 0);
});

test("omitting a scene keeps an OMITTED heading with its number and the scene's text for Final Draft", () => {
  const doc = docOf(scenes(3));
  omitScene(doc, "s2");
  const headings = doc.paragraphs().filter((p) => p.type === "sceneHeading");
  assert.deepEqual(headings.map((p) => [p.sceneNumber, plainText(p.runs), p.sceneId]), [
    ["1", "INT. ROOM 1 - DAY", "s1"], ["2", "OMITTED", "s2"], ["3", "INT. ROOM 3 - DAY", "s3"],
  ]);
  assert.ok(isOmitted(headings[1]!));
  assert.equal(doc.paragraphs().length, 9);
  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<Text>OMITTED<\/Text>\s*<OmittedScene>\s*<Paragraph Type="Scene Heading" Number="2" id="h2">/);
  // Reading it back keeps the omitted scene inside the heading, as Final Draft does.
  assert.equal(same(writeFdx(parseFdx(xml)), xml), undefined);
});

test("Restore Omitted Scene keeps what the writer put on the OMITTED line (final review #10)", () => {
  const doc = docOf(scenes(3));
  omitScene(doc, "s2");
  const placeholder = () => doc.paragraphs().find((p) => isOmitted(p))!;
  doc.insertText(placeholder().id, 7, " (moved to 14)");
  assert.equal(unomitScene(doc, placeholder().id), true);
  assert.deepEqual(doc.paragraphs().slice(4, 9).map((p) => [p.type, plainText(p.runs)]), [
    ["sceneHeading", "INT. ROOM 2 - DAY"], ["action", sentences(8)], ["character", "NELL"], ["dialogue", sentences(4)], ["action", "(moved to 14)"],
  ]);

  // The next heading joined onto the OMITTED line with Backspace stays a heading, after the restored scene.
  const joined = docOf(scenes(3));
  omitScene(joined, "s2");
  const heading = joined.paragraphs().find((p) => isOmitted(p))!;
  joined.mergeWithPrevious("h3");
  assert.equal(plainText(joined.paragraph(heading.id).runs), "OMITTEDINT. ROOM 3 - DAY");
  assert.equal(unomitScene(joined, heading.id), true);
  assert.deepEqual(joined.paragraphs().slice(4, 10).map((p) => [p.type, plainText(p.runs)]), [
    ["sceneHeading", "INT. ROOM 2 - DAY"], ["action", sentences(8)], ["character", "NELL"], ["dialogue", sentences(4)],
    ["sceneHeading", "INT. ROOM 3 - DAY"], ["action", sentences(8)],
  ]);
  const text = joined.paragraphs().map((p) => plainText(p.runs)).join("\n");
  assert.equal(text.split("INT. ROOM 3 - DAY").length, 2, "the joined heading's text is there once");

  // A line that reads just OMITTED leaves nothing behind.
  const plain = docOf(scenes(3));
  omitScene(plain, "s2");
  assert.equal(unomitScene(plain, plain.paragraphs().find((p) => isOmitted(p))!.id), true);
  assert.equal(plain.paragraphs().length, 12);
});

test("a locked page on a section, synopsis or note is written where its page starts, not at the top (final review #4)", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i} is here and goes on a while.`).join(" ");
  for (const middle of [
    { id: "sec", type: "section", depth: 1, runs: [{ text: "ACT TWO" }] },
    { id: "sec", type: "note", runs: [{ text: "A NOTE" }] },
  ] as Paragraph[]) {
    const doc = docOf([
      { id: "h1", type: "sceneHeading", runs: [{ text: "INT. A - DAY" }] },
      { id: "a1", type: "action", runs: [{ text: long(20) }] },
      middle,
      { id: "h2", type: "sceneHeading", runs: [{ text: "INT. B - DAY" }], startsNewPage: true },
      { id: "a2", type: "action", runs: [{ text: long(60) }] },
      { id: "h3", type: "sceneHeading", runs: [{ text: "INT. C - DAY" }] },
      { id: "a3", type: "action", runs: [{ text: long(10) }] },
    ]);
    lockPages(doc, paginate(doc.toScript()));
    omitScene(doc, "h2");
    assert.equal(pageLocks(doc)![1]!.paragraphId, "sec", "the lock now sits on the paragraph FDX does not hold");
    const pages = (d: ScreenplayDoc) => paginate(d.toScript(), { locks: pageLocks(d)! }).pages.map((page) => page.number);
    const xml = writeFdx(doc.toScript());
    assert.doesNotMatch(xml, /PageNumber="2" Position="0"/);
    assert.deepEqual(pages(ScreenplayDoc.fromScript(parseFdx(xml))), pages(doc));
  }

  // A lock whose paragraphs are all gone is left out rather than written at the top of the script.
  const gone = docOf(scenes(3));
  gone.meta.set("pageLocks", { pages: [
    { number: "1", paragraphId: "h1", offset: 0, paragraphIds: [], level: 0 },
    { number: "2", paragraphId: "nowhere", offset: 0, paragraphIds: ["missing"], level: 0 },
  ] });
  const warnings: string[] = [];
  const xml = writeFdx(gone.toScript(), { warnings });
  assert.doesNotMatch(xml, /PageNumber="2"/);
  assert.match(warnings.join("\n"), /Left out locked page 2/);
});

test("locked pages resolve from the shared document alone: replicas with different undo histories agree (final review #7)", () => {
  const seed = docOf([
    { id: "h1", type: "sceneHeading", sceneId: "h1", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "p1", type: "action", runs: [{ text: Array.from({ length: 180 }, (_, i) => `Sentence ${i + 1} is here.`).join(" ") }] },
  ]);
  for (const [clientA, clientB] of [[300, 200], [100, 200]] as const) {
    const replica = (client: number) => {
      const ydoc = new Y.Doc();
      ydoc.clientID = client;
      const doc = new ScreenplayDoc(ydoc);
      doc.applyUpdate(seed.encodeState(), "remote");
      const undo = new Y.UndoManager([doc.body, doc.meta], { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
      return { doc, undo, edit: (change: () => void) => ydoc.transact(change, "local") };
    };
    const a = replica(clientA), b = replica(clientB);
    const sync = () => {
      for (let i = 0; i < 2; i++) {
        b.doc.applyUpdate(Y.encodeStateAsUpdate(a.doc.ydoc, Y.encodeStateVector(b.doc.ydoc)), "remote");
        a.doc.applyUpdate(Y.encodeStateAsUpdate(b.doc.ydoc, Y.encodeStateVector(a.doc.ydoc)), "remote");
      }
    };
    a.edit(() => lockPages(a.doc, paginate(a.doc.toScript())));
    sync();
    const offset = pageLocks(a.doc)![1]!.offset;
    a.edit(() => a.doc.deleteText("p1", offset - 20, 40));
    a.undo.undo();
    sync();
    assert.equal(a.doc.body.toString(), b.doc.body.toString());
    const read = (doc: ScreenplayDoc) => ({
      lock: pageLocks(doc)!.map((lock) => [lock.paragraphId, lock.offset]),
      pages: paginate(doc.toScript(), { locks: pageLocks(doc)! }).pages.map((page) => page.number),
      fdx: /<LockedPages>[\s\S]*<\/LockedPages>/.exec(writeFdx(doc.toScript()))![0],
    });
    const seen = read(a.doc);
    assert.deepEqual(read(b.doc), seen, `clients ${clientA} and ${clientB}`);
    assert.deepEqual(read(ScreenplayDoc.fromUpdate(a.doc.encodeState())), seen, "and A reopened from its saved state");

    // The replica that undid moves the anchor onto the restored text for everyone (the app does this after Undo).
    a.doc.ydoc.transact(() => assert.equal(reanchorPageLocks(a.doc), true), "reanchor");
    assert.equal(reanchorPageLocks(b.doc), false, "a replica that did not undo has nothing to follow");
    sync();
    for (const doc of [a.doc, b.doc]) assert.deepEqual(pageLocks(doc)![1]!.offset, offset);
  }
});

test("keepOmittedScenes restores numbered scenes an edit removed, in place", () => {
  const doc = docOf(scenes(4));
  const before = doc.paragraphs();
  for (const id of ["h2", "a2", "c2", "d2", "h3", "a3"]) doc.deleteParagraph(id);
  assert.equal(keepOmittedScenes(doc, before), 2);
  const headings = doc.paragraphs().filter((p) => p.type === "sceneHeading").map((p) => `${p.sceneNumber} ${plainText(p.runs)}`);
  assert.deepEqual(headings, ["1 INT. ROOM 1 - DAY", "2 OMITTED", "3 OMITTED", "4 INT. ROOM 4 - DAY"]);
  // Scene 3's speech was not deleted: it stays where it was, after the OMITTED heading for 3.
  const order = doc.paragraphs().map((p) => p.sceneNumber ?? p.id);
  assert.deepEqual(order.slice(4), ["2", "3", "c3", "d3", "4", "a4", "c4", "d4"]);
  assert.equal(keepOmittedScenes(doc, doc.paragraphs()), 0);
});

test("deletion marks move with their paragraph's text and close up when the text around them goes", () => {
  const doc = docOf(scenes(1));
  addDeletionMark(doc, "a1", 10, "1");
  addDeletionMark(doc, "a1", 40, "1");
  addDeletionMark(doc, "a1", 40, "1");
  assert.deepEqual(deletionMarks(doc.paragraph("a1")), [{ offset: 10, setId: "1" }, { offset: 40, setId: "1" }], "the same place once");
  adjustDeletionMarks(doc, "a1", 0, 6);
  assert.deepEqual(deletionMarks(doc.paragraph("a1")).map((m) => m.offset), [16, 46], "text typed before both");
  adjustDeletionMarks(doc, "a1", 46, 3);
  assert.deepEqual(deletionMarks(doc.paragraph("a1")).map((m) => m.offset), [16, 46], "text typed at a mark leaves it before the text");
  adjustDeletionMarks(doc, "a1", 20, -4);
  assert.deepEqual(deletionMarks(doc.paragraph("a1")).map((m) => m.offset), [16, 42], "text deleted between them");
  adjustDeletionMarks(doc, "a1", 12, -40);
  assert.deepEqual(deletionMarks(doc.paragraph("a1")), [{ offset: 12, setId: "1" }], "a deletion over a mark closes it up; two in one place are one");
});

test("a scene that comes back takes its OMITTED placeholder away; empty headings and numbers given out today leave none", () => {
  const doc = docOf(scenes(3));
  const before = doc.paragraphs();
  doc.setType("h2", "action");
  assert.equal(keepOmittedScenes(doc, before), 1);
  doc.setType("h2", "sceneHeading");
  const headings = () => doc.paragraphs().filter((p) => p.type === "sceneHeading").map((p) => `${p.sceneNumber} ${plainText(p.runs)}`);
  assert.deepEqual(headings(), ["1 INT. ROOM 1 - DAY", "2 OMITTED", "2 INT. ROOM 2 - DAY", "3 INT. ROOM 3 - DAY"]);
  assert.equal(restoreOmittedScenes(doc), 1);
  assert.deepEqual(headings(), ["1 INT. ROOM 1 - DAY", "2 INT. ROOM 2 - DAY", "3 INT. ROOM 3 - DAY"]);
  assert.equal(restoreOmittedScenes(doc), 0);

  setSceneNumbersLocked(doc, true);
  const empty = doc.insertParagraph(2, { type: "sceneHeading" });
  assert.equal(numberAddedScenes(doc), 0, "an empty heading waits for its text");
  doc.insertText(empty, 0, "INT. HALL - DAY");
  assert.equal(numberAddedScenes(doc), 1);
  assert.equal(doc.paragraph(empty).sceneNumber, "1A");
  const withHall = doc.paragraphs();
  doc.deleteParagraph(empty);
  assert.equal(keepOmittedScenes(doc, withHall, new Set(["1A"])), 0, "a number given out in this sitting");
  const blank = doc.insertParagraph(2, { type: "sceneHeading", sceneNumber: "1B" });
  const withBlank = doc.paragraphs();
  doc.deleteParagraph(blank);
  assert.equal(keepOmittedScenes(doc, withBlank), 0, "an empty heading");
});

test("production settings never write the shared FDX value, so an earlier title page edit can still be undone", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx(FDX));
  const undo = new Y.UndoManager([doc.body, doc.meta], { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
  const original = structuredClone(doc.meta.get("fdx"));
  // A title page edit rewrites the FDX value (the title page feature keeps Final Draft's TitlePage there).
  doc.ydoc.transact(() => {
    const fdx = structuredClone(doc.meta.get("fdx") as FdxDocumentExtras);
    fdx.after.push({ name: "TitlePage", attrs: [], children: [] });
    doc.meta.set("fdx", fdx);
  }, "local");
  // Production settings are not undoable edits.
  doc.ydoc.transact(() => {
    updateRevisionState(doc, (state) => ({ tracking: false, sets: [...state.sets, newRevisionSet(state, { date: "10/30/26" })] }));
    lockPages(doc, paginate(doc.toScript()));
    clearRevisionMarks(doc, "1");
  }, "settings");
  undo.undo();
  assert.deepEqual(doc.meta.get("fdx"), original);
  // Export still carries the production state.
  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<Revisions ActiveSet="2" [^>]*RevisionMode="No"/);
  assert.match(xml, /Name="Yellow Rev\. \(10\/30\/26\)"/);
  assert.match(xml, /<LockedPages>\s*<LockedPage Deleted="0" LevelIndex="0" LockLevel="0" PageNumber="1" Position="0"\/>\s*<\/LockedPages>/);
  assert.doesNotMatch(xml, /DeletedTextLocation Offset="62"/);
  assert.equal(revisionState(ScreenplayDoc.fromScript(parseFdx(xml))).sets.length, 3);
});
