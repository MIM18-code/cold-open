import assert from "node:assert/strict";
import test from "node:test";
import { ScreenplayDoc, parseFdx, writeFdx, scriptNotes, changeScriptNote, readStyle, writeStyle, templateStyle, plainText, moveScene, type Script } from "../src/index.ts";
const fdx = `<FinalDraft DocumentType="Script" Template="No" Version="3"><Content><Paragraph Type="Scene Heading" id="s"><Text>INT. ROOM - DAY</Text></Paragraph><Paragraph Type="Action" id="a"><Text>A red door opens.</Text></Paragraph><Paragraph Type="Scene Heading" id="t"><Text>EXT. ROAD - NIGHT</Text></Paragraph><Paragraph Type="Action" id="b"><Text>She waits.</Text></Paragraph></Content><ScriptNotes Weird="kept"><ScriptNote Range="17,25" Color="#ffff00000000" Custom="yes"><Paragraph Alignment="Left"><Text Style="Bold">Check the door.</Text></Paragraph><Unknown Keep="yes"/></ScriptNote></ScriptNotes><UnknownDocument Keep="yes"/></FinalDraft>`;
const make = () => ScreenplayDoc.fromScript(parseFdx(fdx));
test("FDX note range is unchanged on round trip; content, formatting and unknown XML survive", () => {
    const script = parseFdx(fdx), doc = ScreenplayDoc.fromScript(script);
    assert.equal(writeFdx(doc.toScript()), writeFdx(script));
    const [note] = scriptNotes(doc);
    assert.equal(note?.state, "anchored");
    assert.equal(note?.text, "Check the door.");
    assert.equal(note?.from?.paragraphId, "a");
    doc.ydoc.destroy();
});
test("global ScriptNotes follow preceding and in-paragraph edits without mutating their source XML", () => {
    const doc = make(), before = JSON.stringify(doc.meta.get("fdx"));
    doc.insertText("s", 0, "LONG ");
    doc.insertText("a", 0, "Now ");
    assert.match(writeFdx(doc.toScript()), /Range="26,34"/);
    assert.equal(JSON.stringify(doc.meta.get("fdx")), before);
    const reopened = ScreenplayDoc.fromScript(parseFdx(writeFdx(doc.toScript())));
    assert.deepEqual(scriptNotes(reopened)[0]?.from, { paragraphId: "a", offset: 5 });
    doc.ydoc.destroy();
    reopened.ydoc.destroy();
});
test("a moved source keeps a unique note quote; deleting it becomes an orphan and blocks unsafe export", () => {
    const doc = make();
    moveScene(doc, "s", null);
    assert.equal(scriptNotes(doc)[0]?.state, "anchored");
    assert.match(writeFdx(doc.toScript()), /Check the door/);
    doc.deleteParagraph("a");
    assert.equal(scriptNotes(doc)[0]?.state, "orphan");
    assert.throws(() => writeFdx(doc.toScript(), { strictOrphanNotes: true }), /lost its source/);
    const note = scriptNotes(doc)[0]!;
    changeScriptNote(doc, note.key, { text: note.text, author: "Josh", color: "#ffff00" }, { from: { paragraphId: "b", offset: 0 }, to: { paragraphId: "b", offset: 3 } });
    assert.equal(scriptNotes(doc)[0]?.state, "anchored");
    // Final Draft 13 reads the author from WriterName and blackens six-digit colors, so both are written its way.
    const xml = writeFdx(doc.toScript());
    assert.match(xml, /WriterName="Josh"/);
    assert.match(xml, /Color="#ffffffff0000"/);
    assert.doesNotMatch(xml, /Author=/);
    doc.ydoc.destroy();
});
test("Final Draft notes read their author from WriterName and their heading from Name", () => {
    const xml = fdx.replace('Color="#ffff00000000" Custom="yes"', 'Color="#ffff00000000" Custom="yes" Name="COST · rain again" WriterName="Claude notes" Author="Old"');
    const doc = ScreenplayDoc.fromScript(parseFdx(xml));
    const note = scriptNotes(doc)[0]!;
    assert.equal(note.author, "Claude notes");
    assert.equal(note.title, "COST · rain again");
    changeScriptNote(doc, note.key, { text: note.text, author: "Josh", color: note.color });
    const out = writeFdx(doc.toScript());
    assert.match(out, /WriterName="Josh"/);
    assert.match(out, /Name="COST · rain again"/);
    assert.doesNotMatch(out, /Author=/);
    doc.ydoc.destroy();
});
test("ScriptNote author changes retain body formatting; plain-body edits retain unknown note metadata", () => {
    const doc = make();
    let note = scriptNotes(doc)[0]!;
    changeScriptNote(doc, note.key, { text: note.text, author: "Mara", color: "#ffdd00" });
    let xml = writeFdx(doc.toScript());
    assert.match(xml, /Style="Bold"/);
    assert.match(xml, /Custom="yes"/);
    note = scriptNotes(doc)[0]!;
    changeScriptNote(doc, note.key, { text: "First\nSecond", author: "Mara", color: "#ffdd00" });
    xml = writeFdx(doc.toScript());
    assert.match(xml, /Unknown Keep="yes"/);
    assert.equal(scriptNotes(doc)[0]?.text, "First\nSecond");
    changeScriptNote(doc, scriptNotes(doc)[0]!.key, null);
    assert.equal(scriptNotes(doc).length, 0);
    assert(!writeFdx(doc.toScript()).includes("<ScriptNote "));
    doc.ydoc.destroy();
});
test("new notes can span paragraphs and reopen with their source and multiline body", () => {
    const doc = make();
    changeScriptNote(doc, null, { text: "Read both.\nKeep the image.", author: "Victor", color: "#ffeeaa" }, { from: { paragraphId: "a", offset: 2 }, to: { paragraphId: "b", offset: 3 } });
    const reopened = ScreenplayDoc.fromScript(parseFdx(writeFdx(doc.toScript()))), note = scriptNotes(reopened).find((n) => n.author === "Victor")!;
    assert.equal(note.from?.paragraphId, "a");
    assert.equal(note.to?.paragraphId, "b");
    assert.equal(note.text, "Read both.\nKeep the image.");
    doc.ydoc.destroy();
    reopened.ydoc.destroy();
});
test("unrecognized imported note ranges remain visible and byte-stable in normalized export", () => {
    const script = parseFdx(fdx.replace('Range="17,25"', 'Range="something-unknown"')), doc = ScreenplayDoc.fromScript(script);
    assert.equal(scriptNotes(doc)[0]?.state, "unmapped");
    assert.equal(writeFdx(doc.toScript()), writeFdx(script));
    doc.ydoc.destroy();
});
test("native snapshots preserve note anchors across reopen and subsequent editing", () => {
    const original = make();
    original.insertText("a", 0, "Now ");
    const doc = ScreenplayDoc.fromUpdate(original.encodeState());
    doc.insertText("a", 0, "Later ");
    assert.match(writeFdx(doc.toScript()), /Range="27,35"/);
    original.ydoc.destroy();
    doc.ydoc.destroy();
});
test("editing another note never reattaches an orphan to the adjacent paragraph", () => {
    const doc = make();
    changeScriptNote(doc, null, { text: "Other", author: "", color: "" }, { from: { paragraphId: "b", offset: 0 }, to: { paragraphId: "b", offset: 3 } });
    doc.deleteParagraph("a");
    const other = scriptNotes(doc).find((n) => n.text === "Other")!;
    changeScriptNote(doc, other.key, { text: "Revised other", author: "", color: "" });
    assert.equal(scriptNotes(doc).find((n) => n.text === "Check the door.")?.state, "orphan");
    assert.throws(() => writeFdx(doc.toScript(), { strictOrphanNotes: true }), /lost its source/);
    doc.ydoc.destroy();
});
test("document styles round trip through FDX while keeping script text and unknown data", () => {
    const source = parseFdx(fdx), style = readStyle(source);
    style.elements.dialogue.left = 2.1;
    style.elements.dialogue.spacing = 1.5;
    style.page.top = 1.25;
    style.returns.dialogue = "character";
    const next = { ...source, fdx: writeStyle(source, style) }, round = readStyle(parseFdx(writeFdx(next)));
    assert.equal(round.elements.dialogue.left, 2.1);
    assert.equal(round.elements.dialogue.spacing, 1.5);
    assert.equal(round.page.top, 1.25);
    assert.equal(round.returns.dialogue, "character");
    assert.match(writeFdx(next), /UnknownDocument Keep="yes"/);
    assert.deepEqual(next.paragraphs, source.paragraphs);
});
test("layout rejects reversed margins and preserves unknown element settings", () => {
    const source = parseFdx(fdx), style = readStyle(source);
    style.elements.action.right = 1;
    assert.throws(() => writeStyle(source, style), /text width/);
    for (const name of ["feature", "oneHourDrama", "halfHourComedy", "multiCamera", "stage"] as const) {
        const candidate = templateStyle(name);
        assert.doesNotThrow(() => writeStyle(source, candidate));
    }
});
test("deleting a paragraph preserves its legacy ScriptNote as a removable or reattachable orphan", () => {
    const xml = '<FinalDraft><Content><Paragraph Type="Action" id="a"><Text>First.</Text><ScriptNote><Paragraph><Text>Legacy note</Text></Paragraph></ScriptNote></Paragraph><Paragraph Type="Action" id="b"><Text>Second.</Text></Paragraph></Content></FinalDraft>';
    const doc = ScreenplayDoc.fromScript(parseFdx(xml));
    assert.equal(scriptNotes(doc)[0]?.state, "anchored");
    doc.deleteParagraph("a");
    let note = scriptNotes(doc)[0]!;
    assert.equal(note.state, "orphan");
    assert.equal(note.text, "Legacy note");
    assert.throws(() => writeFdx(doc.toScript(), { strictOrphanNotes: true }), /lost its source/);
    changeScriptNote(doc, note.key, { text: note.text, author: "", color: "" }, { from: { paragraphId: "b", offset: 0 }, to: { paragraphId: "b", offset: 3 } });
    assert.equal(scriptNotes(doc)[0]?.state, "anchored");
    assert.match(writeFdx(doc.toScript()), /Legacy note/);
    assert(!writeFdx(doc.toScript()).includes("InklotDetached"));
    doc.ydoc.destroy();
});
test("a zero-length note follows insertion at its source point without inverted endpoints", () => {
    const doc = make();
    changeScriptNote(doc, null, { text: "Point", author: "", color: "" }, { from: { paragraphId: "b", offset: 2 }, to: { paragraphId: "b", offset: 2 } });
    doc.insertText("b", 2, "new ");
    assert.equal(scriptNotes(doc).find(n => n.text === "Point")?.state, "anchored");
    doc.ydoc.destroy();
});

test("working FDX saves retain orphan notes without dangling ranges or document mutation", () => {
    const doc = make();
    doc.deleteParagraph("a");
    const source = doc.toScript(), before = JSON.stringify(source), warnings: string[] = [];
    const xml = writeFdx(source, { warnings });
    assert.match(xml, /Check the door/);
    assert.doesNotMatch(xml, /Range=|InklotUnresolvedNote|InklotDetachedKey/);
    assert.match(warnings.join(" "), /unanchored/);
    assert.equal(JSON.stringify(source), before);
    const reopened = ScreenplayDoc.fromScript(parseFdx(xml));
    assert.equal(scriptNotes(reopened)[0]?.text, "Check the door.");
    assert.equal(scriptNotes(reopened)[0]?.state, "unmapped");
    doc.ydoc.destroy();
    reopened.ydoc.destroy();
});
