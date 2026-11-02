/** Final Draft ScriptNotes are preserved XML, with native relative-position anchors for editable ranges.
 * Range is a zero-based [start,end) pair in FDX's printed character count. Unknown representations
 * remain visible and unchanged; a formerly valid range that loses its source must be reattached.
 */
import * as Y from "yjs";
import type { ScreenplayDoc, TextPosition } from "./doc.ts";
import { fdxOffset, fdxPositionAt, fdxPositions } from "./fdx.ts";
import { plainText, type Script, type XmlNode } from "./model.ts";
import { attr, textOf } from "./xml.ts";
export const SCRIPT_NOTE_ANCHORS = "fdx.scriptNoteAnchors.v1";
// The Inklot... FDX attribute names (also InklotDetachedKey, InklotTagId) keep the old app name: Backlot reads them from saved files.
export const ORPHAN_NOTE_ATTR = "InklotUnresolvedNote";
interface EndPoint {
    paragraphId: string;
    offset: number;
    relative: number[];
}
interface RangeAnchor {
    start: EndPoint;
    end: EndPoint;
    quote: string;
    rawRange?: string;
    signature: string;
    originalNode?: XmlNode;
    scope?: string;
}
type Anchors = Record<string, RangeAnchor>;
export interface ScriptNoteInfo {
    key: string;
    node: XmlNode;
    text: string;
    author: string;
    /** Final Draft's note Name, shown as the note's heading when present. */
    title: string;
    color: string;
    scope: string;
    state: "anchored" | "unmapped" | "orphan";
    from?: TextPosition;
    to?: TextPosition;
}
interface Found {
    key: string;
    scope: string;
    node: XmlNode;
    parent: (XmlNode | string)[];
    index: number;
    signature: string;
}
function signature(node: XmlNode): string {
    return JSON.stringify({ ...node, attrs: node.attrs.filter(([k]) => k !== "Range" && k !== ORPHAN_NOTE_ATTR) });
}
function hash(text: string): string {
    let value = 14695981039346656037n;
    for (let i = 0; i < text.length; i++)
        value = BigInt.asUintN(64, (value ^ BigInt(text.charCodeAt(i))) * 1099511628211n);
    return value.toString(16);
}
function findNotes(script: Script): Found[] {
    const result: Found[] = [], counts = new Map<string, number>();
    const walk = (children: (XmlNode | string)[], scope: string): void => {
        children.forEach((node, index) => {
            if (typeof node === "string")
                return;
            if (node.name === "ScriptNote") {
                const sig = signature(node), base = `${scope}:${hash(sig)}`, occurrence = counts.get(base) ?? 0;
                counts.set(base, occurrence + 1);
                result.push({ key: attr(node, "InklotDetachedKey") ?? `${base}:${occurrence}`, scope, node, parent: children, index, signature: sig });
            }
            else if (node.name !== "TitlePage")
                walk(node.children, scope);
        });
    };
    walk(script.fdx?.before ?? [], "document");
    walk(script.fdx?.after ?? [], "document");
    for (const p of script.paragraphs) {
        walk(p.fdx?.before ?? [], p.id);
        walk(p.fdx?.after ?? [], p.id);
    }
    return result;
}
function rawScript(doc: ScreenplayDoc): Script {
    return { titlePage: [], paragraphs: structuredClone([...doc.paragraphs()]), fdx: structuredClone(doc.meta.get("fdx") as Script["fdx"]) };
}
function rangeOf(script: Script, found: Found): {
    from: TextPosition;
    to: TextPosition;
} | null {
    if (found.scope !== "document") {
        // Legacy paragraph ScriptNotes without a global Range belong to that paragraph.
        if (attr(found.node, "Range") !== undefined)
            return null;
        return { from: { paragraphId: found.scope, offset: 0 }, to: { paragraphId: found.scope, offset: 0 } };
    }
    const match = /^(\d+),(\d+)$/.exec((attr(found.node, "Range") ?? "").trim());
    if (!match)
        return null;
    const start = Number(match[1]), end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end)
        return null;
    const from = fdxPositionAt(script.paragraphs, start), to = fdxPositionAt(script.paragraphs, end);
    return from && to ? { from, to } : null;
}
function point(doc: ScreenplayDoc, at: TextPosition, assoc: number): EndPoint {
    return { ...at, relative: Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex(at), assoc))) };
}
function quote(doc: ScreenplayDoc, from: TextPosition, to: TextPosition): string {
    return doc.body.toString().slice(doc.bodyIndex(from), doc.bodyIndex(to));
}
/** Called in the same transaction as loading FDX or explicitly editing note XML. Never changes script text. */
export function captureScriptNotes(doc: ScreenplayDoc, preserveExisting = false): void {
    const script = rawScript(doc), notes = findNotes(script);
    const anchors: Anchors = preserveExisting ? { ...(doc.meta.get(SCRIPT_NOTE_ANCHORS) as Anchors | undefined) } : {};
    for (const found of notes) {
        // Newly duplicated legacy notes need anchors; existing global ranges may be stale XML
        // after typing or insertion and must keep their relative positions.
        if (preserveExisting && anchors[found.key])
            continue;
        const range = rangeOf(script, found);
        if (!range || attr(found.node, ORPHAN_NOTE_ATTR))
            continue;
        const { from, to } = range;
        anchors[found.key] = { start: point(doc, from, 1), end: point(doc, to, from.paragraphId === to.paragraphId && from.offset === to.offset ? 1 : -1), originalNode: structuredClone(found.node), scope: found.scope, quote: quote(doc, from, to), signature: found.signature,
            ...(attr(found.node, "Range") !== undefined ? { rawRange: attr(found.node, "Range") } : {}) };
    }
    if (notes.length || Object.keys(anchors).length)
        doc.meta.set(SCRIPT_NOTE_ANCHORS, anchors);
    else
        doc.meta.delete(SCRIPT_NOTE_ANCHORS);
}
function resolved(doc: ScreenplayDoc, anchor: RangeAnchor): {
    from: TextPosition;
    to: TextPosition;
} | null {
    if (!doc.has(anchor.start.paragraphId) || !doc.has(anchor.end.paragraphId))
        return null;
    try {
        const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(anchor.start.relative)), doc.ydoc);
        const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(anchor.end.relative)), doc.ydoc);
        if (a?.type === doc.body && b?.type === doc.body) {
            const from = doc.positionAt(a.index), to = doc.positionAt(b.index);
            if (from?.paragraphId === anchor.start.paragraphId && to?.paragraphId === anchor.end.paragraphId && b.index >= a.index && (b.index > a.index || !anchor.quote))
                return { from, to };
        }
    }
    catch { /* Malformed or obsolete anchors become explicit orphans. */ }
    // A scene move deletes/reinserts Yjs items. Recover only a unique exact quote within the original IDs.
    if (anchor.start.paragraphId === anchor.end.paragraphId && anchor.quote) {
        const text = plainText(doc.paragraph(anchor.start.paragraphId).runs), at = text.indexOf(anchor.quote);
        if (at >= 0 && text.indexOf(anchor.quote, at + 1) < 0)
            return { from: { paragraphId: anchor.start.paragraphId, offset: at }, to: { paragraphId: anchor.start.paragraphId, offset: at + anchor.quote.length } };
    }
    if (anchor.start.paragraphId !== anchor.end.paragraphId && doc.indexOf(anchor.start.paragraphId) < doc.indexOf(anchor.end.paragraphId)) {
        const from = { paragraphId: anchor.start.paragraphId, offset: anchor.start.offset }, to = { paragraphId: anchor.end.paragraphId, offset: anchor.end.offset };
        if (from.offset <= plainText(doc.paragraph(from.paragraphId).runs).length && to.offset <= plainText(doc.paragraph(to.paragraphId).runs).length && quote(doc, from, to) === anchor.quote)
            return { from, to };
    }
    return null;
}
function printedRange(script: Script, from: TextPosition, to: TextPosition): string | null {
    const positions = fdxPositions(script.paragraphs), a = positions.get(from.paragraphId), b = positions.get(to.paragraphId);
    const p = script.paragraphs.find((p) => p.id === from.paragraphId), q = script.paragraphs.find((p) => p.id === to.paragraphId);
    if (a === undefined || b === undefined || !p || !q)
        return null;
    const start = a + fdxOffset(p, from.offset), end = b + fdxOffset(q, to.offset);
    return start <= end ? `${start},${end}` : null;
}
export function scriptNotes(doc: ScreenplayDoc): ScriptNoteInfo[] {
    const script = rawScript(doc), anchors = doc.meta.get(SCRIPT_NOTE_ANCHORS) as Anchors | undefined;
    const foundNotes = findNotes(script);
    const result: ScriptNoteInfo[] = foundNotes.map((found) => {
        const anchor = anchors?.[found.key], target = anchor?.signature === found.signature ? resolved(doc, anchor) : null;
        const currentRange = target && printedRange(script, target.from, target.to);
        // If an unobserved writer changed an indistinguishable note's Range, do not reuse another note's anchor.
        const compatible = anchor && (attr(found.node, "Range") === anchor.rawRange || attr(found.node, "Range") === currentRange);
        const state = attr(found.node, ORPHAN_NOTE_ATTR) ? "orphan" : !anchor || !compatible ? "unmapped" : target && (found.scope !== "document" || currentRange) ? "anchored" : "orphan";
        const paragraphs = found.node.children.filter((n): n is XmlNode => typeof n !== "string" && n.name === "Paragraph");
        return { key: found.key, scope: found.scope, node: structuredClone(found.node), text: paragraphs.length ? paragraphs.map(textOf).join("\n") : textOf(found.node),
            author: authorOf(found.node), title: attr(found.node, "Name") ?? "", color: attr(found.node, "Color") ?? "", state,
            ...(state === "anchored" && target ? target : {}) };
    });
    // Paragraph-scoped notes must survive deletion of the paragraph that carried their XML.
    // Keep their captured contents as explicit detached notes until the writer reattaches/removes them.
    const keys = new Set(foundNotes.map((n) => n.key));
    for (const [key, anchor] of Object.entries(anchors ?? {})) {
        if (keys.has(key) || !anchor.originalNode || !anchor.scope || anchor.scope === "document" || doc.has(anchor.scope))
            continue;
        const node = structuredClone(anchor.originalNode), paragraphs = node.children.filter((n): n is XmlNode => typeof n !== "string" && n.name === "Paragraph");
        result.push({ key, scope: anchor.scope, node, text: paragraphs.length ? paragraphs.map(textOf).join("\n") : textOf(node), author: authorOf(node), title: attr(node, "Name") ?? "", color: attr(node, "Color") ?? "", state: "orphan" });
    }
    return result;
}
/** Pure export projection: the Y.Doc and original XML never change just because a preview is opened. */
export function projectScriptNotes(doc: ScreenplayDoc, script: Script): Script {
    if (!doc.meta.has(SCRIPT_NOTE_ANCHORS))
        return script;
    const notes = scriptNotes(doc);
    if (!notes.length)
        return script;
    const byKey = new Map(notes.map((n) => [n.key, n]));
    for (const found of findNotes(script)) {
        const info = byKey.get(found.key);
        if (!info || info.state === "unmapped")
            continue;
        if (info.state === "orphan") {
            found.node.attrs = found.node.attrs.filter(([k]) => k !== ORPHAN_NOTE_ATTR);
            found.node.attrs.push([ORPHAN_NOTE_ATTR, "Yes"]);
        }
        else if (found.scope === "document" && info.from && info.to) {
            const range = printedRange(script, info.from, info.to);
            if (range)
                found.node.attrs = found.node.attrs.map(([k, v]) => [k, k === "Range" ? range : v]);
        }
    }
    const present = new Set(findNotes(script).map((n) => n.key));
    for (const info of notes)
        if (!present.has(info.key) && info.state === "orphan") {
            const node = structuredClone(info.node);
            node.attrs = node.attrs.filter(([k]) => k !== ORPHAN_NOTE_ATTR && k !== "InklotDetachedKey");
            node.attrs.push([ORPHAN_NOTE_ATTR, "Yes"], ["InklotDetachedKey", info.key]);
            (script.fdx ??= { rootAttrs: [], contentAttrs: [], before: [], after: [] }).after.push({ name: "ScriptNotes", attrs: [], children: [node] });
        }
    return script;
}
export interface NoteEdit {
    text: string;
    author: string;
    color: string;
}
const authorOf = (node: XmlNode) => attr(node, "WriterName") || attr(node, "Author") || "";
function editNode(node: XmlNode, edit: NoteEdit, previousText: string): void {
    if (edit.text.length > 20000 || edit.author.length > 160 || !/^(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{12}|)$/.test(edit.color))
        throw new Error("Invalid note text, author or color.");
    const set = (key: string, value: string) => {
        const at = node.attrs.findIndex(([k]) => k === key);
        if (at >= 0)
            node.attrs[at] = [key, value];
        else if (value)
            node.attrs.push([key, value]);
    };
    // Final Draft keeps the author in WriterName and only twelve-digit colors; it drops Author and blackens #rrggbb.
    node.attrs = node.attrs.filter(([k]) => k !== "Author");
    set("WriterName", edit.author);
    set("Color", edit.color.length === 7 ? "#" + [1, 3, 5].map((i) => edit.color.slice(i, i + 2).repeat(2)).join("") : edit.color);
    if (edit.text !== previousText) {
        // Editing the plain body explicitly replaces its paragraph text. Unknown non-paragraph data stays intact.
        const others = node.children.filter((n) => typeof n !== "string" && n.name !== "Paragraph" && n.name !== "Text");
        node.children = [...edit.text.split("\n").map((text): XmlNode => ({ name: "Paragraph", attrs: [], children: [{ name: "Text", attrs: [], children: [text] }] })), ...others];
    }
}
/** Caller supplies its session/version guard and wraps this in a local undo transaction. */
export function changeScriptNote(doc: ScreenplayDoc, key: string | null, edit: NoteEdit | null, attach?: {
    from: TextPosition;
    to: TextPosition;
}): void {
    const source = doc.toScript(), infos = scriptNotes(doc), selected = key ? infos.find((n) => n.key === key) : undefined;
    if (key && !selected)
        throw new Error("This ScriptNote changed. Reopen it.");
    if (key && selected?.state === "orphan" && !attach && edit)
        throw new Error("Reattach this note before saving its changes, or remove it.");
    const found = key ? findNotes(source).find((n) => n.key === key) : undefined;
    if (key && !found)
        throw new Error("This ScriptNote is no longer available.");
    if (!edit) {
        if (!found)
            return;
        found.parent.splice(found.index, 1);
    }
    else {
        let node: XmlNode;
        if (found)
            node = found.node;
        else {
            if (!attach)
                throw new Error("Select a source location for the new note.");
            node = { name: "ScriptNote", attrs: [["Id", crypto.randomUUID()]], children: [] };
            const fdx = source.fdx ??= { rootAttrs: [["DocumentType", "Script"], ["Template", "No"], ["Version", "3"]], contentAttrs: [], before: [], after: [] };
            let group = [...fdx.before, ...fdx.after].find((n) => n.name === "ScriptNotes");
            if (!group) {
                group = { name: "ScriptNotes", attrs: [], children: [] };
                fdx.after.push(group);
            }
            group.children.push(node);
        }
        editNode(node, edit, selected?.text ?? "");
        if (attach) {
            if (!doc.has(attach.from.paragraphId) || !doc.has(attach.to.paragraphId))
                throw new Error("The selected source was removed.");
            for (const point of [attach.from, attach.to])
                if (point.offset < 0 || point.offset > plainText(doc.paragraph(point.paragraphId).runs).length)
                    throw new Error("Invalid note range.");
            const range = printedRange(source, attach.from, attach.to);
            if (!range)
                throw new Error("A ScriptNote must target printable screenplay text in forward order.");
            if (found && found.scope !== "document") {
                // Legacy notes stay paragraph-bound. A cross-paragraph attachment uses a new global representation.
                found.parent.splice(found.index, 1);
                const group: XmlNode = { name: "ScriptNotes", attrs: [], children: [node] };
                (source.fdx ??= { rootAttrs: [], contentAttrs: [], before: [], after: [] }).after.push(group);
            }
            node.attrs = node.attrs.filter(([k]) => k !== "Range" && k !== ORPHAN_NOTE_ATTR && k !== "InklotDetachedKey");
            node.attrs.push(["Range", range]);
        }
    }
    // Preserve orphan records while another note is edited: their marker prevents recapturing a stale Range.
    if (source.fdx)
        doc.meta.set("fdx", source.fdx);
    for (const p of source.paragraphs)
        if (JSON.stringify(p.fdx) !== JSON.stringify(doc.paragraph(p.id).fdx))
            doc.setField(p.id, "fdx", p.fdx);
    captureScriptNotes(doc);
}
