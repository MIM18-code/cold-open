import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenplayDoc, plainText, setSceneNumbersLocked, type Paragraph } from "@screenplay/engine";
import { DICTATION, EMPTY_CONTEXT, type TakeResult, type ProposedElement } from "../src/shared/channels/dictation.ts";
import type { DesktopBridge } from "../src/shared/api.ts";
import type { EditorBridge } from "../src/renderer/core/editor-bridge.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { applyDraftFormatting, captureDraftTarget, hasSelection, targetIsCurrent, MAX_DRAFT_CHARS } from "../src/renderer/features/format-draft/target.ts";
import { DraftFormatController } from "../src/renderer/features/format-draft/controller.ts";

function paragraph(id: string, text: string, type: Paragraph["type"] = "action"): Paragraph { return { id, type, runs: [{ text }] }; }
function session(paragraphs = [paragraph("rough", "Maya says, No.")]) { return new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs })); }
const formatted: ProposedElement[] = [{ type: "character", text: "MAYA", uncertainty: "" }, { type: "dialogue", text: "No.", uncertainty: "" }];
const source = (s: DocumentSession) => s.script().paragraphs.map((p) => [p.type, plainText(p.runs)]);

test("cross-paragraph selections with equal offsets are not collapsed", () => {
  assert.equal(hasSelection({ anchor: { paragraphId: "a", offset: 2 }, head: { paragraphId: "b", offset: 2 } }), true);
  assert.equal(hasSelection({ anchor: { paragraphId: "a", offset: 2 }, head: { paragraphId: "a", offset: 2 } }), false);
  assert.equal(hasSelection(null), false);
});
test("caret formats only the current paragraph, not the whole screenplay", () => {
  const s = session([paragraph("before", "Earlier."), paragraph("rough", "Maya says, No."), paragraph("after", "Later.")]);
  const target = captureDraftTarget(s, null, "rough");
  assert.equal(target.text, "Maya says, No.");
  applyDraftFormatting(s, target, formatted);
  assert.deepEqual(source(s), [["action", "Earlier."], ["character", "MAYA"], ["dialogue", "No."], ["action", "Later."]]);
  assert.equal(s.doc.paragraph("before").id, "before");
  assert.equal(s.doc.paragraph("after").id, "after");
});
test("one undo restores exact text/IDs; redo restores formatted elements", () => {
  const s = session(); const before = structuredClone(s.script());
  s.edit(() => s.doc.insertText("rough", 14, "!"));
  const typed = structuredClone(s.script());
  const target = captureDraftTarget(s, null, "rough");
  const caret = applyDraftFormatting(s, target, formatted);
  assert.equal(s.doc.paragraph(caret.paragraphId).type, "dialogue");
  s.undo.undo(); assert.deepEqual(s.script(), typed);
  s.undo.undo(); assert.deepEqual(s.script(), before);
  s.undo.redo(); s.undo.redo(); assert.deepEqual(source(s), [["character", "MAYA"], ["dialogue", "No."]]);
});
test("a partial selection keeps the surrounding words and marks", () => {
  const s = session([{ id: "rough", type: "action", runs: [{ text: "Before ", bold: true }, { text: "Maya says, No." }, { text: " After", italic: true }] }]);
  const target = captureDraftTarget(s, { anchor: { paragraphId: "rough", offset: 7 }, head: { paragraphId: "rough", offset: 21 } }, null);
  assert.equal(target.text, "Maya says, No.");
  applyDraftFormatting(s, target, formatted);
  const all = s.script().paragraphs;
  assert.equal(plainText(all[0]!.runs), "Before "); assert.equal(all[0]!.runs[0]!.bold, true);
  assert.equal(plainText(all.at(-1)!.runs), " After"); assert.equal(all.at(-1)!.runs[0]!.italic, true);
});
test("reversed selection ending at next paragraph's start excludes that paragraph", () => {
  const s = session([paragraph("a", "Maya says, No."), paragraph("b", "INT. ROOM - DAY", "sceneHeading")]);
  const target = captureDraftTarget(s, { anchor: { paragraphId: "b", offset: 0 }, head: { paragraphId: "a", offset: 0 } }, null);
  assert.deepEqual(target.paragraphIds, ["a"]);
  applyDraftFormatting(s, target, formatted);
  assert.equal(s.doc.paragraph("b").type, "sceneHeading");
});
test("a changed source is rejected; changes in other paragraphs are safe", () => {
  const s = session([paragraph("rough", "Maya says, No."), paragraph("other", "A door.")]);
  const target = captureDraftTarget(s, null, "rough");
  s.edit(() => s.doc.insertText("other", 0, "Outside: "));
  assert.equal(targetIsCurrent(s, target), true);
  s.edit(() => s.doc.insertText("rough", 0, "Wait. "));
  assert.equal(targetIsCurrent(s, target), false);
  const before = structuredClone(s.script());
  assert.throws(() => applyDraftFormatting(s, target, formatted), /source passage changed/);
  assert.deepEqual(s.script(), before);
});
test("document swap, read-only and production locking prevent late apply", () => {
  const s = session(); const target = captureDraftTarget(s, null, "rough");
  assert.equal(targetIsCurrent(session(), target), false);
  s.setReadOnly(true); assert.equal(targetIsCurrent(s, target), false);
  s.setReadOnly(false); setSceneNumbersLocked(s.doc, true);
  assert.equal(targetIsCurrent(s, target), false);
});
test("inline notes, dual dialogue and numbered scenes are not silently destroyed", () => {
  for (const p of [
    { ...paragraph("rough", "No."), runs: [{ text: "No." }, { text: "keep me", note: true as const }] },
    { ...paragraph("rough", "No."), dual: { block: "duo", side: 1 as const } },
    { ...paragraph("rough", "INT. ROOM - NIGHT", "sceneHeading"), sceneNumber: "12A" },
  ]) { const s = session([p]); assert.throws(() => captureDraftTarget(s, null, "rough")); }
});
test("oversize, blank and invalid model output leave the original unchanged", () => {
  assert.throws(() => captureDraftTarget(session([paragraph("rough", "x".repeat(MAX_DRAFT_CHARS + 1))]), null, "rough"), /shorter passage/);
  assert.throws(() => captureDraftTarget(session([paragraph("rough", "  ")]), null, "rough"), /no draft text/);
  const s = session(), target = captureDraftTarget(s, null, "rough"), before = structuredClone(s.script());
  assert.throws(() => applyDraftFormatting(s, target, []), /invalid/);
  assert.throws(() => applyDraftFormatting(s, target, [{ type: "bad" as any, text: "a", uncertainty: "" }]), /invalid/);
  assert.deepEqual(s.script(), before);
});
test("an existing scene's identity is preserved or replacement is refused", () => {
  const s = session([{ ...paragraph("heading", "Interior room night.", "sceneHeading"), sceneId: "scene-stable" }]);
  const target = captureDraftTarget(s, null, "heading");
  assert.throws(() => applyDraftFormatting(s, target, formatted), /scene heading/);
  applyDraftFormatting(s, target, [{ type: "sceneHeading", text: "INT. ROOM - NIGHT", uncertainty: "" }]);
  assert.equal(s.doc.paragraph("heading").sceneId, "scene-stable");
});

function harness(extra: Partial<TakeResult> = {}, manual = false) {
  let current = session(); const notices: string[] = [], channels: string[] = []; let review = 0;
  let finish!: (value: TakeResult) => void; let requested = 0;
  const controller = new DraftFormatController({
    session: () => current,
    editor: () => ({ getSelection: () => null, currentParagraphId: () => "rough", setSelection() {}, focus() {} }) as unknown as EditorBridge,
    context: () => EMPTY_CONTEXT,
    invoke: (async (channel: string, request: any) => {
      channels.push(channel);
      if (channel === DICTATION.cancelFormat) return undefined;
      requested = request.takeId;
      assert.equal(request.extractCommands, false);
      return new Promise<TakeResult>((resolve) => { finish = resolve; });
    }) as DesktopBridge["invoke"],
    alwaysReview: () => manual, review: () => { review++; }, notify: (m) => notices.push(m),
  });
  return { controller, notices, channels, session: () => current, swap: () => { current = session(); }, reviews: () => review,
    finish: () => finish({ takeId: requested, source: "text", transcript: "Maya says, No.", elements: formatted, diagnostics: [], warnings: [], commands: [], timings: { transcribeMs: 0, formatMs: 1, totalMs: 1 }, autoApplyErrors: [], ...extra }) };
}
test("a safe response formats directly in place without the sidebar or preview", async () => {
  const h = harness(); const done = h.controller.format(); h.finish(); await done;
  assert.equal(h.reviews(), 0); assert.equal(h.controller.snapshot().phase, "idle");
  assert.deepEqual(source(h.session()), [["character", "MAYA"], ["dialogue", "No."]]);
});
test("wording changes or absent fidelity checks require explicit central review", async () => {
  for (const extra of [{ autoApplyErrors: ["Words were dropped"] }, { autoApplyErrors: undefined }]) {
    const h = harness(extra); const done = h.controller.format(); h.finish(); await done;
    assert.equal(h.reviews(), 1); assert.equal(source(h.session())[0]![1], "Maya says, No.");
    assert.equal(h.controller.apply(), true); assert.equal(source(h.session()).length, 2);
  }
});
test("always-preview preference and cancellation keep the source intact", async () => {
  const h = harness({}, true); const done = h.controller.format(); h.finish(); await done;
  assert.equal(h.reviews(), 1); h.controller.cancel(); assert.equal(source(h.session()).length, 1);
});
test("cancellation aborts the owned request and discards a late response", async () => {
  const h = harness(); const done = h.controller.format(); h.controller.cancel(); h.finish(); await done;
  assert.ok(h.channels.includes(DICTATION.cancelFormat)); assert.equal(source(h.session()).length, 1); assert.equal(h.reviews(), 0);
});
test("document changes while the model runs are not overwritten", async () => {
  for (const swapped of [true, false]) {
    const h = harness(); const done = h.controller.format();
    if (swapped) h.swap(); else h.session().edit(() => h.session().doc.insertText("rough", 0, "New. "));
    h.finish(); await done; assert.equal(source(h.session()).length, 1); assert.match(h.notices[0]!, /changed/);
  }
});
test("model failure leaves the text and makes retry possible", async () => {
  const h = harness({ error: "Start your local model." }); const done = h.controller.format(); h.finish(); await done;
  assert.equal(h.controller.snapshot().phase, "idle"); assert.equal(source(h.session()).length, 1); assert.match(h.notices[0]!, /local model/);
});

test("rough text typed into a new document's default heading can become dialogue", () => {
  const s = session([{ ...paragraph("rough", "Maya says, No.", "sceneHeading"), sceneId: "rough" }]);
  const target = captureDraftTarget(s, null, "rough");
  applyDraftFormatting(s, target, formatted);
  assert.deepEqual(source(s), [["character", "MAYA"], ["dialogue", "No."]]);
});
