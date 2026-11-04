import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText, ScreenplayDoc, type Paragraph } from "@screenplay/engine";
import type { EditorBridge, Selection } from "../src/renderer/core/editor-bridge.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { captureDelivery, deliverElements, scriptEnd } from "../src/renderer/features/dictation/delivery.ts";

const paragraph = (id: string, text: string): Paragraph => ({ id, type: "action", runs: [{ text }] });
const session = (rows = [paragraph("first", "Earlier."), paragraph("last", "Later.")]) =>
  new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs: rows }));
const elements = [{ type: "action" as const, text: "A dog waits outside.", uncertainty: "" }];
const editor = (selection: Selection): EditorBridge => ({ getSelection: () => selection }) as EditorBridge;
const text = (s: DocumentSession) => s.script().paragraphs.map(p => plainText(p.runs));

test("a collapsed caret in earlier text appends; later edits are kept and one undo removes only the take", () => {
  const s = session();
  const target = captureDelivery(s, editor({ anchor: { paragraphId: "first", offset: 2 }, head: { paragraphId: "first", offset: 2 } }));
  s.edit(() => s.doc.insertText("last", 6, " Still here."));
  const before = structuredClone(s.script());
  const caret = deliverElements(s, target, elements);
  assert.deepEqual(text(s), ["Earlier.", "Later. Still here.", "A dog waits outside."]);
  assert.deepEqual(caret, scriptEnd(s));
  s.undo.undo();
  assert.deepEqual(s.script(), before);
  s.undo.undo();
  assert.deepEqual(text(s), ["Earlier.", "Later."]);
});

test("repeated takes append in order and an empty last paragraph is filled", () => {
  const s = session([paragraph("first", "Earlier."), paragraph("last", "")]);
  const target = captureDelivery(s, null);
  deliverElements(s, target, elements);
  deliverElements(s, target, [{ ...elements[0]!, text: "The dog sits." }]);
  assert.deepEqual(text(s), ["Earlier.", "A dog waits outside.", "The dog sits."]);
  assert.equal(s.doc.paragraph("last").id, "last");
  s.undo.undo();
  assert.deepEqual(text(s), ["Earlier.", "A dog waits outside."]);
});

test("only the original highlighted passage is replaced, preserving surrounding text and marks", () => {
  const s = session([{ id: "first", type: "action", runs: [{ text: "Keep ", bold: true }, { text: "replace me" }, { text: " too.", italic: true }] }, paragraph("last", "Later.")]);
  const target = captureDelivery(s, editor({ anchor: { paragraphId: "first", offset: 5 }, head: { paragraphId: "first", offset: 15 } }));
  const before = structuredClone(s.script());
  deliverElements(s, target, elements);
  assert.deepEqual(text(s), ["Keep ", "A dog waits outside.", " too.", "Later."]);
  assert.equal(s.script().paragraphs[0]!.runs[0]!.bold, true);
  assert.equal(s.script().paragraphs[2]!.runs[0]!.italic, true);
  s.undo.undo();
  assert.deepEqual(s.script(), before);
});

test("editing a highlighted source, changing documents or becoming read-only refuses replacement", () => {
  const s = session();
  const target = captureDelivery(s, editor({ anchor: { paragraphId: "first", offset: 0 }, head: { paragraphId: "first", offset: 8 } }));
  s.edit(() => s.doc.insertText("first", 0, "Changed. "));
  const before = structuredClone(s.script());
  assert.throws(() => deliverElements(s, target, elements), /source passage changed/);
  assert.deepEqual(s.script(), before);
  assert.throws(() => deliverElements(session(), target, elements), /document changed/);
  s.setReadOnly(true);
  assert.throws(() => captureDelivery(s, null), /read-only/);
  assert.throws(() => deliverElements(s, target, elements), /document changed/);
});
