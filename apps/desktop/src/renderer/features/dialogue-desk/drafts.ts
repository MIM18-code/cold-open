import type { DocumentSession } from "../../core/session.ts";
import * as Y from "yjs";
import {
  createRecord, DRAFT_TEXT_PREFIX, editDraftText, putRecord, records, RECORD_PREFIX,
} from "../rewrite/records.ts";

interface DialogueDraft { base: string; text: string; }

export function dialogueDraftRecords(session: DocumentSession, id: string) {
  return records(session.doc, "alternative").filter(record => record.dialogueDraft?.paragraphId === id);
}

function draftRecord(session: DocumentSession, id: string, recordId?: string) {
  const drafts = records(session.doc, "alternative", true)
    .filter(record => record.dialogueDraft?.paragraphId === id);
  return recordId ? drafts.find(record => record.id === recordId)
    : drafts.find(record => record.text !== record.dialogueDraft!.base) ?? drafts[0];
}

export function dialogueDraft(session: DocumentSession, id: string, recordId?: string): DialogueDraft | undefined {
  const record = draftRecord(session, id, recordId);
  return record?.dialogueDraft && record.text !== record.dialogueDraft.base
    ? { base: record.dialogueDraft.base, text: record.text } : undefined;
}

export function discardDialogueDraft(session: DocumentSession, id: string, recordId?: string): void {
  session.edit(() => {
    const current = draftRecord(session, id, recordId);
    if (!current) return;
    session.doc.meta.delete(RECORD_PREFIX + current.id);
    if (current.dialogueDraft?.textKey) {
      session.doc.meta.delete(DRAFT_TEXT_PREFIX + current.dialogueDraft.textKey);
    }
  });
}

export function saveDialogueDraft(
  session: DocumentSession, id: string, base: string, text: string, recordId?: string,
): void {
  let stamp: (() => void) | undefined;
  session.edit(() => {
    const current = draftRecord(session, id, recordId);
    const textKey = current?.dialogueDraft?.textKey;
    const shared = textKey ? session.doc.meta.get(DRAFT_TEXT_PREFIX + textKey) : undefined;
    if (shared instanceof Y.Text) {
      // Returning to the source wording is still a text edit. Keep its container so a disconnected
      // writer's unseen insertions can arrive, including after the local draft becomes unchanged.
      editDraftText(shared, text);
      stamp = () => restampDraft(session, current!.id, current!.text === current!.dialogueDraft!.base ? base : undefined);
      return;
    }
    if (text === base) {
      discardDialogueDraft(session, id, recordId);
      return;
    }
    // Project alternatives already participate in native recovery and exchange-format loss warnings.
    // Give legacy records a fresh ID: concurrent migrations then preserve both versions instead of
    // racing to install different Y.Text instances under the same key.
    const record = createRecord("alternative", current?.title ?? "Dialogue draft", text, current);
    putRecord(session.doc, {
      ...record, dialogueDraft: { paragraphId: id, base, textKey: record.id },
    });
    if (current) session.doc.meta.delete(RECORD_PREFIX + current.id);
  });
  stamp?.();
}

/** Origin for draft bookkeeping that Undo leaves alone: Undo takes back the writer's typing, not the stamp. */
const DRAFT_STAMP_ORIGIN = Symbol("dialogue-draft-stamp");

// Typing changes the Y.Text, not the record, so give the record a new revision too: an edit form opened before the
// change (in Notes, here or on a co-writer's Mac) then refuses to save over the newer text. A draft typed back to
// its old source was inactive; if the script's line has changed since, it now starts from the current line.
function restampDraft(session: DocumentSession, recordId: string, rebaseTo: string | undefined): void {
  const stored = session.doc.meta.get(RECORD_PREFIX + recordId) as { dialogueDraft?: { base: string } } | undefined;
  if (!stored || typeof stored !== "object" || session.readOnly) return;
  const rebase = rebaseTo !== undefined && stored.dialogueDraft && rebaseTo !== stored.dialogueDraft.base;
  session.doc.ydoc.transact(() => {
    session.doc.meta.set(RECORD_PREFIX + recordId, {
      ...stored, revision: crypto.randomUUID(), updated: new Date().toISOString(),
      ...(rebase ? { dialogueDraft: { ...stored.dialogueDraft, base: rebaseTo } } : {}),
    });
  }, DRAFT_STAMP_ORIGIN);
}
