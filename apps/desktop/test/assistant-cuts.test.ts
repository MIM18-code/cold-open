import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenplayDoc, parseFountain, type Paragraph, type Script } from "@screenplay/engine";
import type { App } from "../src/renderer/core/app.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { applySuggestion } from "../src/renderer/features/assistant/apply.ts";
import { locateCut, splitAnswer, type Suggestion } from "../src/renderer/features/assistant/suggestions.ts";
import { executeTool, scriptTools } from "../src/renderer/features/assistant/tools.ts";
import { deleteInDocument } from "../src/renderer/features/editor/replace.ts";

const paragraph = (id: string, type: Paragraph["type"], text: string): Paragraph => ({ id, type, runs: [{ text }] });
const sample = (): Script => ({ titlePage: [], paragraphs: [
  paragraph("h", "sceneHeading", "INT. ROOM - DAY"), paragraph("a", "action", "Rain falls."),
  paragraph("cue", "character", "MAYA"), paragraph("p", "parenthetical", "(into phone)"),
  paragraph("d", "dialogue", "You getting this?"), paragraph("end", "action", "She leaves."),
] });
const propose = (script: Script, find = "You getting this?") => executeTool({
  id: "cut", name: "propose_edit", arguments: { scene: "1", find, replace: "", why: "Trim." },
}, { script: () => script });
const appFor = (session: DocumentSession): App => ({ session, editor: null }) as App;
const makeSession = () => new DocumentSession(ScreenplayDoc.fromScript(sample()));
const speechCut: Suggestion = { scene: "1", find: "You getting this?", replace: "", cut: "speech" };

test("an action paragraph cut is proposed without changing the script", async () => {
  const script = sample(), before = structuredClone(script);
  const output = await propose(script, "Rain falls.");
  assert.deepEqual(output.result, { ok: true, scene: "Scene 1 (INT. ROOM - DAY)", proposed: true, cut: "paragraph", removes: 1 });
  assert.deepEqual(output.proposal, { scene: "1", find: "Rain falls.", replace: "", why: "Trim.", cut: "paragraph" });
  assert.deepEqual(locateCut(script, output.proposal!), { cut: "paragraph", paragraphIds: ["a"] });
  assert.deepEqual(script, before);
});

test("other printed paragraphs can be cut without removing their neighbors", async () => {
  for (const type of ["shot", "transition", "general", "parenthetical"] as const) {
    const script = sample();
    script.paragraphs[1]!.type = type;
    const output = await propose(script, "Rain falls.");
    assert.deepEqual(locateCut(script, output.proposal!), { cut: "paragraph", paragraphIds: ["a"] });
  }
});

test("cutting a one-line speech removes its cue, parentheticals and dialogue", async () => {
  const script = sample();
  script.paragraphs.splice(5, 0, paragraph("p2", "parenthetical", "(beat)"));
  const output = await propose(script);
  assert.equal(output.proposal!.cut, "speech");
  assert.equal((output.result as { removes: number }).removes, 4);
  assert.deepEqual(locateCut(script, output.proposal!), { cut: "speech", paragraphIds: ["cue", "p", "d", "p2"] });
});

test("cutting one paragraph of a longer speech keeps the cue and other dialogue", async () => {
  const script = sample();
  script.paragraphs.splice(5, 0, paragraph("d2", "dialogue", "Stay with me."));
  const output = await propose(script);
  assert.equal(output.proposal!.cut, "paragraph");
  assert.deepEqual(locateCut(script, output.proposal!), { cut: "paragraph", paragraphIds: ["p", "d"] });
  const session = new DocumentSession(ScreenplayDoc.fromScript(script));
  assert.deepEqual(applySuggestion(appFor(session), output.proposal!), { ok: true });
  assert.deepEqual(session.script().paragraphs.map((p) => p.id), ["h", "a", "cue", "d2", "end"]);
  session.destroy();
});

test("a parenthetical belonging to another dialogue paragraph stays", () => {
  const script = sample();
  script.paragraphs.splice(5, 0, paragraph("p2", "parenthetical", "(quietly)"), paragraph("d2", "dialogue", "Stay with me."));
  assert.deepEqual(locateCut(script, { ...speechCut, cut: "paragraph" }), { cut: "paragraph", paragraphIds: ["p", "d"] });
});

test("character cues are refused with instructions to quote dialogue, even when repeated", async () => {
  for (const repeated of [false, true]) {
    const script = sample();
    if (repeated) script.paragraphs.push(paragraph("cue2", "character", "MAYA"), paragraph("d2", "dialogue", "Wait."));
    const output = await propose(script, "MAYA");
    assert.equal(output.proposal, undefined);
    assert.match(JSON.stringify(output.result), /Quote the dialogue line instead of the character cue/);
  }
});

test("scene headings are never cut", async () => {
  const output = await propose(sample(), "INT. ROOM - DAY");
  assert.equal(output.proposal, undefined);
  assert.match(JSON.stringify(output.result), /Scene headings can't be cut/);
});

test("either half of dual dialogue is refused", async () => {
  const script = parseFountain("INT. ROOM - DAY\n\nMAYA\nYou getting this?\n\nNELL ^\nKeep going.\n");
  assert.ok(script.paragraphs.filter((p) => p.dual).length >= 4);
  for (const find of ["You getting this?", "Keep going."]) {
    const output = await propose(script, find);
    assert.equal(output.proposal, undefined);
    assert.match(JSON.stringify(output.result), /Edit dual dialogue by hand/);
  }
});

test("private note runs anywhere in the removed paragraphs refuse the cut without leaking notes", async () => {
  for (const id of ["a", "cue", "p", "d"]) {
    for (const position of ["before", "inside", "after"]) {
      const script = sample();
      const target = script.paragraphs.find((p) => p.id === id)!;
      const text = target.runs[0]!.text;
      const at = position === "before" ? 0 : position === "after" ? text.length : 3;
      target.runs = [{ text: text.slice(0, at) }, { text: "SECRET", note: true }, { text: text.slice(at) }];
      const output = await propose(script, id === "a" ? text : "You getting this?");
      assert.equal(output.proposal, undefined);
      assert.match(JSON.stringify(output.result), /That passage has a private note in it. Cut it by hand/);
      assert.doesNotMatch(JSON.stringify(output.result), /SECRET/);
    }
  }
});

test("a standalone note inside a speech refuses its cut", async () => {
  for (const at of [3, 4, 5]) {
    const script = sample();
    script.paragraphs.splice(at, 0, paragraph("note", "note", "SECRET"));
    const output = await propose(script);
    assert.equal(output.proposal, undefined);
    assert.match(JSON.stringify(output.result), /private note in it/);
    assert.doesNotMatch(JSON.stringify(output.result), /SECRET/);
  }
});

test("whole paragraph cuts normalize curly marks and surrounding whitespace", async () => {
  const script = sample();
  script.paragraphs[4]!.runs = [{ text: "  You’re getting this?  " }];
  const output = await propose(script, "You're getting this?");
  assert.equal(output.proposal!.cut, "speech");
  assert.deepEqual(locateCut(script, output.proposal!), { cut: "speech", paragraphIds: ["cue", "p", "d"] });
});

test("Apply rechecks edited dialogue, including a find that remains only part of the paragraph", async () => {
  for (const text of ["That's changed.", "You getting this? Keep going."]) {
    const session = makeSession();
    const proposal = (await propose(session.script())).proposal!;
    session.edit(() => session.doc.replaceText("d", 0, 17, text));
    const before = session.script();
    assert.ok("error" in applySuggestion(appFor(session), proposal));
    assert.deepEqual(session.script(), before);
    session.destroy();
  }
});

test("Apply refuses a speech cut after a second dialogue paragraph was added", async () => {
  const session = makeSession();
  const proposal = (await propose(session.script())).proposal!;
  session.edit(() => session.doc.insertParagraph(5, { type: "dialogue", runs: [{ text: "Keep going." }] }));
  assert.match(JSON.stringify(applySuggestion(appFor(session), proposal)), /speech has changed/);
  assert.ok(session.doc.has("cue"));
  session.destroy();
});

test("Apply refuses to expand a paragraph cut into a speech cut after other dialogue was removed", async () => {
  const script = sample();
  script.paragraphs.splice(5, 0, paragraph("d2", "dialogue", "Keep going."));
  const session = new DocumentSession(ScreenplayDoc.fromScript(script));
  const proposal = (await propose(session.script())).proposal!;
  assert.equal(proposal.cut, "paragraph");
  session.edit(() => session.doc.deleteParagraph("d2"));
  assert.match(JSON.stringify(applySuggestion(appFor(session), proposal)), /speech has changed/);
  assert.ok(session.doc.has("cue"));
  session.destroy();
});

test("Apply keeps the proposed scene binding when the quoted line moves to another scene", async () => {
  const session = makeSession();
  const proposal = (await propose(session.script())).proposal!;
  session.edit(() => session.doc.insertParagraph(2, { type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] }));
  assert.match(JSON.stringify(applySuggestion(appFor(session), proposal)), /no longer in scene 1/);
  assert.ok(session.doc.has("cue"));
  session.destroy();
});

test("Apply re-derives current paragraph IDs instead of retaining proposed IDs", async () => {
  const session = makeSession();
  const proposal = (await propose(session.script())).proposal!;
  session.edit(() => {
    session.doc.deleteParagraph("p");
    session.doc.insertParagraph(3, { type: "parenthetical", runs: [{ text: "(quietly)" }] });
  });
  assert.deepEqual(applySuggestion(appFor(session), proposal), { ok: true });
  assert.deepEqual(session.script().paragraphs.map((p) => p.id), ["h", "a", "end"]);
  session.destroy();
});

test("Apply refuses private notes or dual dialogue added after the proposal", async () => {
  for (const change of [
    (session: DocumentSession) => session.doc.insertParagraph(4, { type: "note", runs: [{ text: "SECRET" }] }),
    (session: DocumentSession) => session.doc.setField("cue", "dual", { block: "dual", side: 1 }),
  ]) {
    const session = makeSession();
    const proposal = (await propose(session.script())).proposal!;
    session.edit(() => change(session));
    const before = session.script();
    assert.ok("error" in applySuggestion(appFor(session), proposal));
    assert.deepEqual(session.script(), before);
    session.destroy();
  }
});

test("Apply removes a speech in one undo step isolated from typing before and after it", async () => {
  const session = makeSession();
  const proposal = (await propose(session.script())).proposal!;
  session.edit(() => session.doc.insertText("a", 11, " Still."));
  const before = session.script();
  const steps = session.undo.undoStack.length;
  let changes = 0;
  const off = session.onChange(() => changes++);
  assert.deepEqual(applySuggestion(appFor(session), proposal), { ok: true });
  assert.equal(changes, 1);
  off();
  assert.equal(session.undo.undoStack.length, steps + 1);
  assert.deepEqual(session.script().paragraphs.map((p) => p.id), ["h", "a", "end"]);
  const after = session.script();
  session.edit(() => session.doc.insertText("end", 11, " Now."));
  session.undo.undo();
  assert.deepEqual(session.script(), after);
  session.undo.undo();
  assert.deepEqual(session.script(), before);
  session.undo.redo();
  assert.deepEqual(session.script(), after);
  session.destroy();
});

test("Apply cuts an action paragraph through the document", async () => {
  const session = makeSession();
  const proposal = (await propose(session.script(), "Rain falls.")).proposal!;
  assert.deepEqual(applySuggestion(appFor(session), proposal), { ok: true });
  assert.equal(session.doc.has("a"), false);
  session.undo.undo();
  assert.equal(session.doc.has("a"), true);
  session.destroy();
});

test("Apply uses the editor deletion API when mounted", () => {
  const session = makeSession();
  const app = appFor(session);
  let deleted: readonly string[] | undefined;
  app.editor = { deleteParagraphs(ids: readonly string[]) { deleted = ids; deleteInDocument(session, ids); } } as App["editor"];
  assert.deepEqual(applySuggestion(app, speechCut), { ok: true });
  assert.deepEqual(deleted, ["cue", "p", "d"]);
  session.undo.undo();
  assert.deepEqual(session.script(), sample());
  session.destroy();
});

test("Apply refuses cuts in read-only scripts", () => {
  const session = makeSession();
  session.setReadOnly(true);
  assert.deepEqual(applySuggestion(appFor(session), speechCut), { error: "This script is read-only." });
  assert.deepEqual(session.script(), sample());
  session.destroy();
});

test("cut markers survive suggestion blocks and the tool explains empty replacements", () => {
  assert.deepEqual(splitAnswer('```suggestion\n' + JSON.stringify(speechCut) + '\n```'), [{ type: "suggestion", suggestion: speechCut }]);
  assert.match(scriptTools(false).find((t) => t.name === "propose_edit")!.description, /empty replace.*whole speech/);
});

test("a second dialogue paragraph the writer emptied doesn't keep the speech alive", () => {
  const script = sample();
  script.paragraphs.splice(5, 0, paragraph("blank", "dialogue", "  "));
  assert.equal((locateCut(script, { ...speechCut, cut: undefined }) as { cut: string }).cut, "speech");
  assert.match(JSON.stringify(locateCut(script, { ...speechCut, cut: "paragraph" })), /speech has changed/);
});

test("a Final Draft ScriptNote on a removed paragraph refuses the cut", async () => {
  const script = sample();
  script.paragraphs[4]!.fdx = { after: [{ name: "ScriptNote", attrs: [["Range", "0,5"]], children: [] }] };
  assert.match(JSON.stringify((await propose(script)).result), /private note/);
});
