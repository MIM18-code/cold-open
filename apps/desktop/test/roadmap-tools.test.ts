import assert from "node:assert/strict";
import test from "node:test";
import { ScreenplayDoc, plainText } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { normalizeClipboard, pageFurniture, preparePaste, applyPaste } from "../src/renderer/features/smart-paste/model.ts";
import { WorkspaceMemory, windowMemories, visibleBounds } from "../src/main/workspace/memory.ts";
import { searchScript, scriptFromBytes } from "../src/main/workspace/search.ts";
import { encodeNative } from "../src/renderer/core/fileformat.ts";
import { createRecord, putRecord, records } from "../src/renderer/features/rewrite/records.ts";
import { CANVAS_PREFIX, placement, placeBeat } from "../src/renderer/features/beat-canvas/model.ts";
const make = () => new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "s", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] }, { id: "a", type: "action", runs: [{ text: "A red door opens.", bold: true }] }] }));
test("PDF furniture is only removed when that exact line is checked", () => {
    const text = "DRAFT\r\n17.\r\nI won't go.\r\n(MORE)\r\nDRAFT";
    assert.equal(pageFurniture(text).length, 4);
    assert.equal(preparePaste(text, new Set(), false), normalizeClipboard(text));
    assert.equal(preparePaste(text, new Set([1, 3]), false), "DRAFT\nI won't go.\nDRAFT");
    assert.throws(() => normalizeClipboard("a".repeat(500001)), /500,000/);
});
test("literal paste and screenplay paste are each one Undo, retaining surrounding text and marks", () => {
    for (const mode of ["plain", "screenplay"] as const) {
        const s = make(), before = s.script();
        applyPaste(s, s.version, { anchor: { paragraphId: "a", offset: 2 }, head: { paragraphId: "a", offset: 10 } }, mode === "plain" ? "BLUE\nGATE" : "MARA\nOpen it.", mode);
        assert.notDeepEqual(s.script().paragraphs, before.paragraphs);
        s.undo.undo();
        assert.deepEqual(s.script(), before);
        s.destroy();
        s.doc.ydoc.destroy();
    }
});
test("a stale or read-only paste never deletes current text", () => {
    const s = make(), version = s.version, selection = { anchor: { paragraphId: "a", offset: 2 }, head: { paragraphId: "a", offset: 10 } };
    s.edit(() => s.doc.insertText("a", 0, "Now "));
    assert.throws(() => applyPaste(s, version, selection, "changed", "plain"), /draft changed/);
    s.setReadOnly(true);
    assert.throws(() => applyPaste(s, s.version, selection, "changed", "plain"), /read-only/);
    assert.equal(plainText(s.doc.paragraph("a").runs), "Now A red door opens.");
    s.destroy();
    s.doc.ydoc.destroy();
});
test("workspace Quit preserves every saved window; ordinary Close removes only its window", () => {
    let saved: any[] = [];
    const m = new WorkspaceMemory((rows) => { saved = rows; });
    const row = (path: string) => ({ path, bounds: { x: 0, y: 0, width: 900, height: 700 } });
    m.update(1, row("/one.fdx"));
    m.update(2, row("/two.fdx"));
    m.quit();
    m.close(1);
    m.close(2);
    assert.equal(saved.length, 2);
    m.cancelQuit();
    assert.equal(saved.length, 0);
    m.update(1, row("/one.fdx"));
    m.update(2, row("/two.fdx"));
    m.close(1);
    assert.deepEqual(saved.map((r) => r.path), ["/two.fdx"]);
});
test("workspace validates geometry and places restored windows on the visible display", () => {
    assert.deepEqual(windowMemories([{ path: "a", bounds: { x: NaN, y: 1, width: 1, height: 1 } }]), []);
    assert.deepEqual(visibleBounds({ x: 30000, y: -9000, width: 900, height: 700 }, { x: 0, y: 0, width: 1400, height: 900 }), { x: 500, y: 0, width: 900, height: 700 });
});
test("cross-project search uses literal matching and exact native paragraph indices", () => {
    const s = make();
    s.edit(() => s.doc.insertText("a", 0, "İ "));
    const hits = searchScript(s.script(), "DOOR", false);
    assert.equal(hits[0]?.offset, 8);
    assert.equal(searchScript(s.script(), ".*").length, 0);
    assert.deepEqual(searchScript(scriptFromBytes(encodeNative(s.doc)), "door"), searchScript(s.script(), "door"));
    assert.throws(() => scriptFromBytes(new Uint8Array(8000001)), /8 MB/);
    s.destroy();
    s.doc.ydoc.destroy();
});
test("canvas changes position, not screenplay order; stale drags are rejected and Undo restores position", () => {
    const s = make(), beat = createRecord("beat", "Opening image", "An empty road.");
    s.edit(() => putRecord(s.doc, beat));
    s.undo.clear();
    const before = s.script();
    s.edit(() => placeBeat(s.doc, beat.id, { ...placement(undefined), x: 400, y: 300, lane: "Act 1", sceneId: "s" }, ""));
    const position = placement(s.doc.meta.get(CANVAS_PREFIX + beat.id));
    assert.equal(position.x, 400);
    assert.deepEqual(s.script(), before);
    assert.throws(() => placeBeat(s.doc, beat.id, { ...position, x: 600 }, ""), /Someone moved/);
    s.undo.undo();
    assert.equal(s.doc.meta.get(CANVAS_PREFIX + beat.id), undefined);
    assert.equal(records(s.doc, "beat").length, 1);
    s.destroy();
    s.doc.ydoc.destroy();
});
