// Proofreading's actions on the document: accepted fixes keep formatting and are their own undo step, and a
// read-only script is never written to.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc, newRevisionSet, revisedRanges, updateRevisionState, type Finding, type Paragraph } from "@screenplay/engine";

import type { App } from "../src/renderer/core/app.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { replaceInParagraph } from "../src/renderer/features/proofread/apply.ts";
import { trackSession } from "../src/renderer/features/revisions/tracking.ts";

// The store reaches the main process through window.desktop; here a spell checker that knows every word.
(globalThis as { window?: unknown }).window = {
  desktop: { spelling: { isMisspelled: () => false, suggestions: () => [], addToDictionary: () => undefined }, invoke: async () => undefined, on: () => () => undefined },
};
const { IGNORED_KEY, LEARNED_KEY, ProofreadStore } = await import("../src/renderer/features/proofread/store.ts");

function session(paragraphs: Paragraph[]): DocumentSession {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs });
  const result = new DocumentSession(doc);
  result.undo.clear();
  return result;
}

/** The parts of the app proofreading uses, with no editor open. */
function fakeApp(s: DocumentSession): App {
  return {
    session: s, editor: null, settings: {}, setting: (_key: string, fallback: unknown) => fallback,
    toast: () => undefined, togglePanel: () => undefined, onSession: () => () => undefined, subscribe: () => () => undefined,
  } as unknown as App;
}

test("accepting a fix keeps the replaced text's formatting, also at the start of a paragraph", () => {
  const s = session([{ id: "a", type: "action", runs: [{ text: "Teh", bold: true }, { text: " dog sees " }, { text: "teh", italic: true }, { text: " cat." }] }]);
  const app = fakeApp(s);
  replaceInParagraph(app, "a", 0, 3, "The");
  replaceInParagraph(app, "a", 13, 16, "the");
  assert.deepEqual(s.doc.paragraph("a").runs, [{ text: "The", bold: true }, { text: " dog sees " }, { text: "the", italic: true }, { text: " cat." }]);
});

test("an accepted fix is its own undo step, even right after typing", () => {
  const s = session([{ id: "a", type: "action", runs: [{ text: "Nell sees teh dog." }] }]);
  s.edit(() => s.doc.insertText("a", 18, " Then"));
  replaceInParagraph(fakeApp(s), "a", 10, 13, "the");
  s.undo.undo();
  assert.equal(s.doc.paragraph("a").runs[0]!.text, "Nell sees teh dog. Then");
});

test("in Revision Mode an accepted fix takes the current set, and one undo takes back the fix and its mark", () => {
  const s = session([{ id: "a", type: "action", runs: [{ text: "Nell sees teh dog.", bold: true }] }]);
  const stop = trackSession(s);
  s.edit(() => updateRevisionState(s.doc, (state) => {
    const set = newRevisionSet(state, { date: "10/30/26" });
    return { sets: [set], currentSetId: set.id, tracking: true };
  }));
  s.edit(() => s.doc.insertText("a", 18, " Then"));
  const steps = s.undo.undoStack.length;
  replaceInParagraph(fakeApp(s), "a", 10, 13, "the");
  assert.deepEqual(s.doc.paragraph("a").runs.map((run) => [run.text, !!run.bold]), [["Nell sees ", true], ["the", true], [" dog.", true], [" Then", true]]);
  assert.ok(revisedRanges(s.doc.paragraph("a")).some((range) => range.from === 10 && range.to === 13));
  assert.equal(s.undo.undoStack.length, steps + 1);
  s.undo.undo();
  assert.equal(s.doc.paragraph("a").runs.map((run) => run.text).join(""), "Nell sees teh dog. Then");
  assert.ok(!revisedRanges(s.doc.paragraph("a")).some((range) => range.from === 10 && range.to === 13));
  stop();
});

test("Ignore and Learn on a read-only script stay in this window and never write to the document", () => {
  const s = session([{ id: "a", type: "action", runs: [{ text: "Nell sees the the zorbl." }] }]);
  const store = new ProofreadStore(fakeApp(s));
  store.runNow();
  const repeat = store.findings.find((finding) => finding.kind === "repeat") as Finding;
  assert.ok(repeat, "a repeated word is found");
  s.setReadOnly(true);
  let writes = 0;
  s.doc.ydoc.on("update", () => writes++);
  store.ignore(repeat);
  assert.equal(writes, 0);
  assert.equal(s.doc.meta.get(IGNORED_KEY), undefined);
  assert.ok(!store.findings.some((finding) => finding.id === repeat.id), "hidden here");
  store.learn({ ...repeat, kind: "spelling" });
  assert.equal(s.doc.meta.get(LEARNED_KEY), undefined);
  store.restoreIgnored();
  assert.equal(writes, 0);
  assert.ok(store.findings.some((finding) => finding.id === repeat.id), "back after restore");
});

test("typing where nothing is found leaves the marks and the panel alone; an edit to a flagged line redraws them", () => {
  const s = session([
    { id: "a", type: "action", runs: [{ text: "Nell sees the the dog." }] },
    { id: "b", type: "action", runs: [{ text: "Rain." }] },
  ]);
  const drawn: number[] = [];
  const app = { ...fakeApp(s), editor: { setDecorations: (_source: string, marks: unknown[]) => void drawn.push(marks.length) } } as unknown as App;
  const store = new ProofreadStore(app);
  store.runNow();
  assert.deepEqual(drawn, [1]);
  const version = store.version;
  s.edit(() => s.doc.insertText("b", 5, " It pours."));
  store.runNow();
  assert.deepEqual(drawn, [1]);
  assert.equal(store.version, version);
  // The flagged line changes after the finding: the finding is the same, its snippet is not.
  s.edit(() => s.doc.insertText("a", 22, " Again."));
  store.runNow();
  assert.deepEqual(drawn, [1, 1]);
  assert.equal(store.version, version + 1);
  // Selecting a finding redraws it as selected.
  store.focus(store.findings[0]!.id);
  assert.deepEqual(drawn, [1, 1, 1]);
});

test("after the document is swapped, the marks are drawn on the new one once the editor has drawn it", () => {
  const first = session([{ id: "a", type: "action", runs: [{ text: "Rain." }] }]);
  const sessionListeners: ((next: DocumentSession) => void)[] = [];
  const appListeners: (() => void)[] = [];
  let marks: unknown[] = [];
  const app = {
    ...fakeApp(first),
    editor: { setDecorations: (_source: string, list: unknown[]) => void (marks = list) },
    onSession: (listener: (next: DocumentSession) => void) => (sessionListeners.push(listener), () => undefined),
    subscribe: (listener: () => void) => (appListeners.push(listener), () => undefined),
  } as unknown as App & { session: DocumentSession };
  const store = new ProofreadStore(app);
  const stop = store.start();
  // The editor follows swaps too, and drawing a new document clears its marks. It registers after the store.
  sessionListeners.push(() => void (marks = []));
  // As App.setSession does it: the session, then the listeners, then the app's own change.
  app.session = session([{ id: "b", type: "action", runs: [{ text: "Nell sees the the dog." }] }]);
  for (const listener of sessionListeners) listener(app.session);
  for (const listener of appListeners) listener();
  assert.equal(marks.length, 1);
  stop();
});
