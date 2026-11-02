import * as Y from "yjs";
import { plainText } from "@screenplay/engine";
import type { DocumentSession } from "./session.ts";
import type { EditorBridge, Position } from "./editor-bridge.ts";
interface Place extends Position {
    relative: number[];
}
interface Trail {
    items: Place[];
    index: number;
    muted: boolean;
}
const trails = new WeakMap<DocumentSession, Trail>();
const trail = (s: DocumentSession) => { let t = trails.get(s); if (!t) {
    t = { items: [], index: -1, muted: false };
    trails.set(s, t);
} return t; };
const capture = (s: DocumentSession, p: Position): Place => ({ ...p, relative: Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(s.doc.body, s.doc.bodyIndex(p), 1))) });
function resolve(s: DocumentSession, p: Place): Position | null { if (!s.doc.has(p.paragraphId))
    return null; try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(p.relative)), s.doc.ydoc);
    const at = a?.type === s.doc.body ? s.doc.positionAt(a.index) : null;
    if (at?.paragraphId === p.paragraphId)
        return at;
}
catch { } return { paragraphId: p.paragraphId, offset: Math.min(p.offset, plainText(s.doc.paragraph(p.paragraphId).runs).length) }; }
const same = (a: Position | undefined | null, b: Position | undefined | null) => !!a && !!b && a.paragraphId === b.paragraphId && a.offset === b.offset;
export function recordJump(s: DocumentSession, from: Position | null, to: Position): void { const t = trail(s); if (t.muted || !from || same(from, to) || !s.doc.has(from.paragraphId) || !s.doc.has(to.paragraphId))
    return; t.items = t.items.slice(0, t.index + 1); if (!same(resolve(s, t.items[t.index] ?? capture(s, from)), from) || t.index < 0)
    t.items.push(capture(s, from)); t.items.push(capture(s, to)); t.items = t.items.slice(-80); t.index = t.items.length - 1; }
export function moveLocation(s: DocumentSession, editor: EditorBridge | null, direction: -1 | 1): boolean { if (!editor)
    return false; const t = trail(s); let index = t.index + direction; while (index >= 0 && index < t.items.length) {
    const p = resolve(s, t.items[index]!);
    if (p) {
        t.index = index;
        t.muted = true;
        try {
            editor.revealParagraph(p.paragraphId, { select: false, offset: p.offset });
            editor.setSelection(p);
            editor.focus();
        }
        finally {
            t.muted = false;
        }
        return true;
    }
    index += direction;
} return false; }
/** Observe explicit feature navigation, not caret movement while typing or table-read auto-follow. */
export function observeNavigation(session: () => DocumentSession, editor: EditorBridge): () => void {
    const originalReveal = editor.revealParagraph.bind(editor), originalSet = editor.setSelection.bind(editor);
    let nesting = false;
    const reveal: EditorBridge["revealParagraph"] = (id, options) => { const s = session(); if (!nesting && options?.select)
        recordJump(s, editor.getSelection()?.head ?? null, { paragraphId: id, offset: options.offset ?? 0 }); const previous = nesting; nesting = true; try {
        originalReveal(id, options);
    }
    finally {
        nesting = previous;
    } };
    const set: EditorBridge["setSelection"] = (anchor, head) => { if (!nesting)
        recordJump(session(), editor.getSelection()?.head ?? null, head ?? anchor); originalSet(anchor, head); };
    editor.revealParagraph = reveal;
    editor.setSelection = set;
    return () => { if (editor.revealParagraph === reveal)
        editor.revealParagraph = originalReveal; if (editor.setSelection === set)
        editor.setSelection = originalSet; };
}
