import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenplayDoc, plainText, scenesOf, scriptNotes, changeScriptNote, writeFdx, reportHtml } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { applySceneOperation } from "../src/renderer/features/scene-operations/model.ts";
import { anchorAt, createRecord, putRecord, records, resolveAnchor } from "../src/renderer/features/rewrite/records.ts";
import { recordJump, moveLocation } from "../src/renderer/core/location-history.ts";
import type { EditorBridge } from "../src/renderer/core/editor-bridge.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { PhoneServer } from "../src/main/phone/server.ts";
import { phonePage } from "../src/main/phone/web.ts";
const make = () => new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
        { id: "s1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. KITCHEN - DAY" }] },
        { id: "a1", type: "action", runs: [{ text: "A red door opens.", bold: true }] },
        { id: "s2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "EXT. ROAD - NIGHT" }] },
        { id: "a2", type: "action", runs: [{ text: "The car stops here." }] },
    ] }));
const dispose = (s: DocumentSession) => { s.destroy(); s.doc.ydoc.destroy(); };
test("duplicate is one Undo, gives fresh identities and copies native notes without retargeting global FDX notes", () => {
    const s = make();
    s.edit(() => {
        putRecord(s.doc, createRecord("note", "Door", "Check the prop", { anchor: anchorAt(s.doc, { paragraphId: "a1", offset: 2 }, { paragraphId: "a1", offset: 10 }) }));
        changeScriptNote(s.doc, null, { text: "Keep the car", author: "M", color: "" }, { from: { paragraphId: "a2", offset: 4 }, to: { paragraphId: "a2", offset: 7 } });
        // The raw global range is now stale: duplication must retain its relative anchor.
        s.doc.insertText("a1", 0, "Slowly, ");
    });
    const before = s.script();
    s.undo.clear();
    const id = applySceneOperation(s, s.version, { kind: "duplicate", sceneId: "s1", copyNotes: true });
    assert.notEqual(id, "s1");
    assert.equal(scenesOf(s.doc.paragraphs()).length, 3);
    assert.equal(new Set(s.doc.paragraphs().map(p => p.id)).size, s.doc.paragraphs().length);
    assert.equal(scriptNotes(s.doc)[0]?.from?.paragraphId, "a2");
    assert.equal(scriptNotes(s.doc)[0]?.from?.offset, 4);
    const copied = records(s.doc, "note").find(n => n.anchor?.paragraphId !== "a1");
    assert(copied);
    assert.notEqual(copied.id, records(s.doc, "note").find(n => n.anchor?.paragraphId === "a1")?.id);
    assert(resolveAnchor(s.doc, copied.anchor));
    assert.match(writeFdx(s.script()), /Keep the car/);
    s.undo.undo();
    assert.deepEqual(s.script(), before);
    assert.equal(records(s.doc, "note").length, 1);
    dispose(s);
});
test("split and merge keep original words, paragraph marks and one-step Undo", () => {
    for (const kind of ["split", "merge"] as const) {
        const s = make(), before = s.script();
        s.undo.clear();
        applySceneOperation(s, s.version, kind === "split" ? { kind, sceneId: "s1", at: { paragraphId: "a1", offset: 6 }, heading: "INT. HALL - DAY" } : { kind, sceneId: "s2" });
        const text = s.doc.paragraphs().map(p => plainText(p.runs)).join("|");
        assert(text.includes("The car stops here."));
        assert(text.includes("EXT. ROAD - NIGHT"));
        if (kind === "split") {
            assert.equal(scenesOf(s.doc.paragraphs()).length, 3);
            assert.equal(plainText(s.doc.paragraph("a1").runs), "A red ");
            assert(s.doc.paragraph("a1").runs[0]?.bold);
        }
        else {
            assert.equal(scenesOf(s.doc.paragraphs()).length, 1);
            assert.equal(s.doc.paragraph("s2").type, "action");
        }
        s.undo.undo();
        assert.deepEqual(s.script(), before);
        dispose(s);
    }
});
test("numbered production scenes and stale scene previews cannot be restructured", () => { const s = make(), version = s.version; s.edit(() => s.doc.insertText("a1", 0, "Now ")); assert.throws(() => applySceneOperation(s, version, { kind: "merge", sceneId: "s2" }), /draft changed/); s.edit(() => s.doc.setField("s1", "sceneNumber", "1")); const before = s.script(); assert.throws(() => applySceneOperation(s, s.version, { kind: "duplicate", sceneId: "s1", copyNotes: false }), /numbered|unnumbered/); assert.deepEqual(s.script(), before); dispose(s); });
test("location history follows edits, supports forward and skips deleted targets", () => {
    const s = make();
    let current: any;
    const editor = { revealParagraph() { }, setSelection(p: any) { current = p; }, focus() { } } as unknown as EditorBridge;
    recordJump(s, { paragraphId: "a1", offset: 2 }, { paragraphId: "a2", offset: 4 });
    s.edit(() => s.doc.insertText("a1", 0, "Now "));
    assert.equal(moveLocation(s, editor, -1), true);
    assert.deepEqual(current, { paragraphId: "a1", offset: 6 });
    assert.equal(moveLocation(s, editor, 1), true);
    assert.deepEqual(current, { paragraphId: "a2", offset: 4 });
    s.edit(() => s.doc.deleteParagraph("a1"));
    assert.equal(moveLocation(s, editor, -1), false);
    dispose(s);
});
test("phone inbox persists receipts, serializes concurrent writes, deduplicates and releases an empty project's slot", async () => { const root = await mkdtemp(join(tmpdir(), "inklot-inbox-")); try {
    const folder = join(root, "inbox"), a = new PhoneInboxStore(folder), key = "document-00000001";
    const item = (id: string) => ({ id, kind: "note" as const, text: "Check this.", cueId: "c", paragraphId: "p", revision: "r", created: new Date().toISOString(), sourceText: "Original" });
    await Promise.all([a.append(key, item("message-00000001")), a.append(key, item("message-00000002")), a.append(key, item("message-00000001"))]);
    const b = new PhoneInboxStore(folder);
    assert.equal((await b.list(key)).length, 2);
    await a.remove(key, "message-00000001");
    await a.remove(key, "message-00000002");
    assert.deepEqual(await readdir(folder), []);
    await assert.rejects(() => a.list("../../secret"), /identity/);
    await writeFile(join(folder, key + ".json"), "broken");
    await assert.rejects(() => a.append(key, item("message-00000003")));
}
finally {
    await rm(root, { recursive: true, force: true });
} });
test("phone inbox permits system-resolved parent folders but rejects a redirected inbox directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "inklot-inbox-symlinks-"));
    try {
        const actual = join(root, "actual");
        await mkdir(actual);
        const alias = join(root, "alias");
        await symlink(actual, alias, "dir");
        const key = "document-00000001";
        const item = { id: "message-00000001", kind: "note" as const, text: "Safe note", cueId: "cue", paragraphId: "p", revision: "r", created: new Date().toISOString() };
        const store = new PhoneInboxStore(join(alias, "inbox"));
        await store.append(key, item);
        assert.equal((await store.list(key))[0]?.text, "Safe note");
        const redirected = join(root, "redirected-inbox");
        await symlink(join(actual, "inbox"), redirected, "dir");
        await assert.rejects(() => new PhoneInboxStore(redirected).list(key), /cannot be redirected/);
    }
    finally { await rm(root, { recursive: true, force: true }); }
});
test("phone receipt waits for persistence and a failed disk write does not falsely acknowledge or retain an item", async () => { const snapshot = { title: "Test", revision: "r1", cues: [{ id: "c", paragraphId: "p", speaker: "M", heading: "H", text: "Door" }] }; let persist = true; const server = new PhoneServer(snapshot, () => { }, async () => { if (!persist)
    throw new Error("Disk full"); }); const { url } = await server.start("127.0.0.1"), u = new URL(url), headers = { authorization: `Bearer ${u.hash.slice(1)}`, "content-type": "application/json" }; try {
    const body = { id: "message-00000001", kind: "dictation", text: "A draft.", cueId: "c", revision: "r1" };
    persist = false;
    const failed = await fetch(u.origin + "/api/inbox", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(failed.status, 503);
    assert.equal(server.items().length, 0);
    persist = true;
    assert.equal((await fetch(u.origin + "/api/inbox", { method: "POST", headers, body: JSON.stringify(body) })).status, 200);
    assert.equal(server.items()[0]?.sourceText, "Door");
}
finally {
    await server.stop();
} });
test("phone page JavaScript parses and keeps a recoverable draft without persisting its bearer token", () => { const html = phonePage("testnonce"), script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]; assert(script); assert.doesNotThrow(() => new Function(script)); assert.match(script, /localStorage/); assert.doesNotMatch(script, /setItem\([^\n]*(?:token|secret)/); });
test("report paper, flow layout and metadata escape script text without changing values", () => { const html = reportHtml("<Draft>", ["Character", "Speech"], [["MARA", "<script>bad()</script>\n" + "Word ".repeat(500)]], { paper: "a4", landscape: true, layout: "speeches", revision: "<Rev 2>", date: "2026-10-31", widths: [80, 400] }); assert.match(html, /size:A4 landscape/); assert.match(html, /class="speech"/); assert(html.includes("&lt;script&gt;")); assert(!html.includes("<script>bad()")); assert(html.includes("&lt;Rev 2&gt;")); assert.equal((html.match(/Word /g) ?? []).length, 500); });
