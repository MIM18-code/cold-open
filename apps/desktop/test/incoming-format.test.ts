import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText, ScreenplayDoc } from "@screenplay/engine";
import { DICTATION, EMPTY_CONTEXT, type TakeResult } from "../src/shared/channels/dictation.ts";
import type { DesktopBridge } from "../src/shared/api.ts";
import type { EditorBridge, NewParagraph, Position, Selection } from "../src/renderer/core/editor-bridge.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { IncomingFormatter } from "../src/renderer/features/format-draft/incoming.ts";

const rows = (s: DocumentSession) => s.script().paragraphs.map(p => [p.type, plainText(p.runs)]);
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Incoming formatter did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function harness() {
  const s = new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "old", type: "action", runs: [{ text: "Keep this." }] }] }));
  let selection: Selection = { anchor: { paragraphId: "old", offset: 10 }, head: { paragraphId: "old", offset: 10 } };
  let enabled = true;
  const requests: { text: string; finish(extra?: Partial<TakeResult>): void }[] = [];
  const channels: string[] = [], notices: string[] = [];
  const editor = {
    getSelection: () => selection,
    insertParagraphs(list: NewParagraph[], at: Position) {
      let ids: string[] = [];
      s.edit(() => { ids = s.doc.insertParagraphsAt(at, list.map(p => ({ id: "", type: p.type, runs: [{ text: p.text ?? "" }] }))); });
      const end = { paragraphId: ids.at(-1)!, offset: 0 };
      selection = { anchor: end, head: end };
      return ids;
    },
  } as unknown as EditorBridge;
  const controller = new IncomingFormatter({
    session: () => s, editor: () => editor, context: () => EMPTY_CONTEXT, enabled: () => enabled, notify: m => notices.push(m),
    invoke: (async (channel: string, request: any) => {
      channels.push(channel);
      if (channel === DICTATION.cancelFormat) return;
      assert.equal(request.extractCommands, false);
      return new Promise<TakeResult>(resolve => requests.push({ text: request.text, finish: (extra = {}) => resolve({
        takeId: request.takeId, source: "text", transcript: request.text,
        elements: [{ type: "character", text: "MAYA", uncertainty: "" }, { type: "dialogue", text: "No.", uncertainty: "" }],
        diagnostics: [], warnings: [], autoApplyErrors: [], commands: [], timings: { transcribeMs: 0, formatMs: 1, totalMs: 1 }, ...extra,
      }) }));
    }) as DesktopBridge["invoke"],
  });
  return { s, controller, requests, channels, notices, selection: () => selection, select: (value: Selection) => { selection = value; },
    disable: () => { enabled = false; controller.cancel(); } };
}

test("only the incoming passage formats; earlier text and later typing remain outside the target", async () => {
  const h = harness();
  assert.equal(h.controller.accept("Maya says, No."), true);
  const caret = h.selection().head;
  h.s.edit(() => h.s.doc.insertText(caret.paragraphId, 0, "Keep typing."));
  await until(() => h.requests.length === 1);
  h.requests[0]!.finish();
  await until(() => h.controller.snapshot() === 0);
  assert.deepEqual(rows(h.s), [["action", "Keep this."], ["character", "MAYA"], ["dialogue", "No."], ["action", "Keep typing."]]);
  h.s.undo.undo();
  assert.deepEqual(rows(h.s), [["action", "Keep this."], ["action", "Maya says, No."], ["action", "Keep typing."]]);
});

test("successive takes queue and format in order without moving the continuation caret", async () => {
  const h = harness();
  h.controller.accept("Maya says, No.");
  await until(() => h.requests.length === 1);
  h.controller.accept("Maya says, Again.");
  const caret = h.selection();
  h.requests[0]!.finish();
  await until(() => h.requests.length === 2);
  assert.equal(h.requests[1]!.text, "Maya says, Again.");
  h.requests[1]!.finish({ elements: [{ type: "character", text: "MAYA", uncertainty: "" }, { type: "dialogue", text: "Again.", uncertainty: "" }] });
  await until(() => h.controller.snapshot() === 0);
  assert.deepEqual(rows(h.s), [["action", "Keep this."], ["character", "MAYA"], ["dialogue", "No."], ["character", "MAYA"], ["dialogue", "Again."], ["action", ""]]);
  assert.deepEqual(h.selection(), caret);
});

test("pasting in the middle preserves the words and styling before and after it", async () => {
  const h = harness();
  h.s.edit(() => h.s.doc.format("old", 0, 10, { bold: true }));
  h.select({ anchor: { paragraphId: "old", offset: 5 }, head: { paragraphId: "old", offset: 5 } });
  h.controller.accept("Maya says, No.");
  await until(() => h.requests.length === 1);
  h.requests[0]!.finish();
  await until(() => h.controller.snapshot() === 0);
  assert.deepEqual(rows(h.s), [["action", "Keep "], ["character", "MAYA"], ["dialogue", "No."], ["action", ""], ["action", "this."]]);
  assert.equal(h.s.script().paragraphs[0]!.runs[0]!.bold, true);
  assert.equal(h.s.script().paragraphs.at(-1)!.runs[0]!.bold, true);
});

test("edited or undone incoming text is never replaced by a late answer", async () => {
  for (const undo of [false, true]) {
    const h = harness();
    h.controller.accept("Maya says, No.");
    await until(() => h.requests.length === 1);
    if (undo) h.s.undo.undo();
    else {
      const id = h.s.script().paragraphs[1]!.id;
      h.s.edit(() => h.s.doc.insertText(id, 0, "Changed. "));
    }
    const before = structuredClone(h.s.script());
    h.requests[0]!.finish();
    await until(() => h.controller.snapshot() === 0);
    assert.deepEqual(h.s.script(), before);
  }
});

test("switching off cancels active and queued formatting and keeps all dictated text", async () => {
  const h = harness();
  h.controller.accept("Maya says, No.");
  await until(() => h.requests.length === 1);
  h.controller.accept("Another take.");
  const before = structuredClone(h.s.script());
  h.disable();
  h.requests[0]!.finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.controller.snapshot(), 0);
  assert.equal(h.requests.length, 1);
  assert.ok(h.channels.includes(DICTATION.cancelFormat));
  assert.deepEqual(h.s.script(), before);
  assert.equal(h.controller.accept("Still off."), false);
});

test("uncertain output or model failure keeps the original incoming text", async () => {
  for (const extra of [{ autoApplyErrors: ["Wording changed"] }, { error: "Local model unavailable" }]) {
    const h = harness();
    h.controller.accept("Maya says, No.");
    await until(() => h.requests.length === 1);
    const before = structuredClone(h.s.script());
    h.requests[0]!.finish(extra);
    await until(() => h.controller.snapshot() === 0);
    assert.deepEqual(h.s.script(), before);
    assert.match(h.notices[0]!, "error" in extra ? /Local model unavailable/ : /kept as dictated/);
  }
});

test("explicit highlights use normal paste rather than expanding an automatic replacement", () => {
  const h = harness();
  h.select({ anchor: { paragraphId: "old", offset: 0 }, head: { paragraphId: "old", offset: 4 } });
  assert.equal(h.controller.accept("New text."), false);
  assert.deepEqual(rows(h.s), [["action", "Keep this."]]);
});
