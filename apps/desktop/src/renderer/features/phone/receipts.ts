import { plainText, type ScreenplayDoc } from "@screenplay/engine";
import type { ProposedElement } from "../../../shared/channels/dictation.ts";
import type { Position } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";
import { anchorAt, putRecord, records, RECORD_PREFIX, type ProjectRecord } from "../rewrite/records.ts";

const LEGACY_PREFIX = "phone.accepted.";

type Attachment = { paragraphId: string; sourceText: string; cursor?: Position };

export function phoneAttachment(
  doc: ScreenplayDoc, attachment: Attachment,
): { from: Position; to: Position } | null {
  const { paragraphId, sourceText, cursor } = attachment;
  if (cursor) return doc.has(cursor.paragraphId) ? { from: cursor, to: cursor } : null;
  let id = paragraphId;
  if (!doc.has(id)) {
    if (!sourceText) return null;
    const matches = doc.paragraphs().filter(p => plainText(p.runs) === sourceText);
    if (matches.length !== 1) return null;
    id = matches[0]!.id;
  }
  // The writer may have typed around the captured passage since; find it anywhere in the paragraph.
  const at = plainText(doc.paragraph(id).runs).indexOf(sourceText);
  if (at < 0) return null;
  return { from: { paragraphId: id, offset: at }, to: { paragraphId: id, offset: at + sourceText.length } };
}

export function phoneSceneAttachment(doc: ScreenplayDoc, paragraphId: string): { from: Position; to: Position } | null {
  if (!doc.has(paragraphId) || doc.paragraph(paragraphId).type !== "sceneHeading") return null;
  const position = { paragraphId, offset: 0 };
  return { from: position, to: position };
}

export async function acceptPhoneRecord(
  session: DocumentSession, itemId: string, record: ProjectRecord, isCurrent: () => boolean,
  attachment?: Attachment & { elements?: ProposedElement[]; scene?: "after" | "end" },
): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(itemId));
  const id = "phone-" + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
  if (!isCurrent() || session.readOnly) throw new Error("Choose an editable script first.");
  const legacyAccepted = session.doc.meta.has(LEGACY_PREFIX + itemId);
  let inserted = false;
  session.undo.stopCapturing();
  session.edit(() => {
    // Old receipts become part of their existing records, bounded by the project-item limit.
    const existing = new Map(records(session.doc).map(r => [r.id, r]));
    for (const [key, value] of session.doc.meta.entries()) {
      if (!key.startsWith(LEGACY_PREFIX)) continue;
      const saved = existing.get(value as string);
      if (saved) session.doc.meta.set(RECORD_PREFIX + saved.id, { ...saved, phoneReceipt: key.slice(LEGACY_PREFIX.length) });
      session.doc.meta.delete(key);
    }
    if (legacyAccepted || session.doc.meta.has(RECORD_PREFIX + id) || records(session.doc).some(r => r.phoneReceipt === itemId)) {
      return;
    }
    const anchor = attachment?.scene === "end" ? null : attachment?.scene === "after"
      ? phoneSceneAttachment(session.doc, attachment.cursor?.paragraphId ?? attachment.paragraphId)
      : attachment ? phoneAttachment(session.doc, attachment) : null;
    if (attachment?.scene === "after" && !anchor)
      throw new Error("The destination scene was removed. Choose a scene on the Mac.");
    if (attachment && attachment.scene !== "end" && !anchor)
      throw new Error("The attached passage changed or was removed. Use Insert at cursor to place this item.");
    const elements = attachment?.elements;
    putRecord(session.doc, {
      ...record, id, phoneReceipt: itemId,
      ...(!elements && anchor ? { anchor: anchorAt(session.doc, anchor.from, anchor.to) } : {}),
    });
    if (elements && (anchor || attachment?.scene === "end")) {
      const paragraphs = session.doc.paragraphs();
      let position = attachment?.scene === "end" ? paragraphs.length
        : paragraphs.findIndex(p => p.id === anchor!.from.paragraphId) + 1;
      if (attachment?.scene === "after") {
        while (position < paragraphs.length && !["sceneHeading", "section"].includes(paragraphs[position]!.type)) position++;
      }
      elements.forEach((element, i) => {
        // Offline acceptances share IDs so the engine's non-destructive repair reports copies on sync.
        const paragraphId = `${id}-${i}`;
        if (!session.doc.has(paragraphId)) session.doc.insertParagraph(position, {
          id: paragraphId, type: element.type, runs: [{ text: element.text }],
        });
        position++;
      });
    }
    inserted = true;
  });
  session.undo.stopCapturing();
  return inserted;
}
