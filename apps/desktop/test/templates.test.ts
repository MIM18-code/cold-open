import assert from "node:assert/strict";
import test from "node:test";

import { applyDocumentTemplate, plainText } from "@screenplay/engine";

import { DocumentSession } from "../src/renderer/core/session.ts";

const source = {
  titlePage: [],
  paragraphs: [
    { id: "a", type: "action" as const, runs: [{ text: "MAYA ENTERS THE ROOM." }] },
    { id: "b", type: "action" as const, runs: [{ text: "The coffee is cold." }] },
    { id: "c", type: "character" as const, runs: [{ text: "MAYA" }] },
    { id: "d", type: "dialogue" as const, runs: [{ text: "Hello." }] },
  ],
};

test("applying a template to an existing script keeps its words and is one undo", () => {
  const session = DocumentSession.untitled();
  session.edit(() => session.doc.load(source));
  session.undo.clear();
  const before = session.doc.toScript();

  session.edit(() => applyDocumentTemplate(session.doc, "multiCamera"));
  const applied = session.doc.toScript();
  assert.equal(applied.template, "multiCamera");
  assert.ok(applied.fdx);
  assert.deepEqual(applied.paragraphs.map((part) => plainText(part.runs)), ["MAYA ENTERS THE ROOM.", "The coffee is cold.", "MAYA", "Hello."]);
  assert.equal(applied.paragraphs[0]!.runs.some((run) => run.underline), true);
  assert.equal(applied.paragraphs[1]!.runs.some((run) => run.underline), false);

  session.undo.undo();
  const undone = session.doc.toScript();
  assert.equal(undone.template, undefined);
  assert.equal(undone.fdx, undefined);
  assert.deepEqual(undone.paragraphs, before.paragraphs);

  session.undo.redo();
  assert.equal(session.doc.toScript().template, "multiCamera");
  session.destroy();
});

test("a new template session starts with the act structure and FDX layout", () => {
  const session = DocumentSession.untitled("multiCamera");
  assert.equal(session.script().template, "multiCamera");
  assert.deepEqual(session.script().paragraphs.filter((part) => part.type === "newAct").map((part) => plainText(part.runs)),
    ["COLD OPEN", "ACT ONE", "ACT TWO", "TAG"]);
  assert.equal(session.dirty, false);
  session.destroy();
});
