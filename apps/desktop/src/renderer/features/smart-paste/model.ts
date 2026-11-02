import { parseFountain, plainText, type Paragraph } from "@screenplay/engine";
import type { Selection } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";
export type PasteMode = "plain" | "screenplay";
export interface Furniture {
    line: number;
    text: string;
    reason: string;
}
export function normalizeClipboard(text: string): string {
    if (typeof text !== "string" || text.length > 500000)
        throw new Error("Paste up to 500,000 characters at a time.");
    return text.replace(/\r\n?/g, "\n");
}
/** Suggestions only. Nothing is removed until the writer checks that exact line. */
export function pageFurniture(text: string): Furniture[] {
    const lines = normalizeClipboard(text).split("\n"), counts = new Map<string, number>();
    for (const line of lines) {
        const value = line.trim();
        if (value)
            counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return lines.flatMap((line, index) => {
        const value = line.trim();
        const reason = /^\d{1,4}[A-Z]?[.]?$/.test(value) ? "Possible page number"
            : /^(?:\(?CONTINUED\)?[:.]?|\(MORE\))$/i.test(value) ? "Possible page continuation"
                : /\f/.test(line) ? "Contains a page-break character"
                    : /^(?:DRAFT|REVISION|CONFIDENTIAL|COPYRIGHT)\b/i.test(value) && (counts.get(value) ?? 0) > 1 ? "Repeated possible header/footer" : "";
        return reason ? [{ line: index, text: line, reason }] : [];
    });
}
export function preparePaste(text: string, removed: ReadonlySet<number>, unwrap: boolean): string {
    let lines = normalizeClipboard(text).split("\n").filter((_, index) => !removed.has(index));
    if (unwrap) {
        // Only join indented continuation lines. Never join a heading, cue, parenthetical or blank paragraph.
        const joined: string[] = [];
        for (const line of lines) {
            const previous = joined.at(-1);
            if (previous?.trim() && /^\s{2,}[a-z]/.test(line) && !/^\s*(?:INT\.|EXT\.|[A-Z][A-Z\s.'()-]+$)/.test(previous))
                joined[joined.length - 1] = previous.trimEnd() + " " + line.trimStart();
            else
                joined.push(line);
        }
        lines = joined;
    }
    return lines.join("\n");
}
export function screenplayPaste(text: string): Paragraph[] {
    return parseFountain(normalizeClipboard(text)).paragraphs.map((p) => ({ id: "", type: p.type, runs: p.runs, ...(p.dual ? { dual: p.dual } : {}), ...(p.depth ? { depth: p.depth } : {}) }));
}
export function applyPaste(session: DocumentSession, revision: number, selection: Selection, text: string, mode: PasteMode): string[] {
    if (session.version !== revision)
        throw new Error("The draft changed while this preview was open. Close it and paste again at the new location.");
    if (session.readOnly)
        throw new Error("This script is read-only.");
    const doc = session.doc;
    const points = [selection.anchor, selection.head].sort((a, b) => doc.indexOf(a.paragraphId) - doc.indexOf(b.paragraphId) || a.offset - b.offset);
    if (points.some((p) => !doc.has(p.paragraphId) || p.offset < 0 || p.offset > plainText(doc.paragraph(p.paragraphId).runs).length))
        throw new Error("The paste location is no longer available.");
    const [from, to] = points, value = normalizeClipboard(text), paragraphs = mode === "screenplay" ? screenplayPaste(value) : [];
    if (!value || mode === "screenplay" && !paragraphs.length)
        throw new Error("There is no text to paste.");
    let ids: string[] = [];
    session.undo.stopCapturing();
    session.edit(() => {
        if (from!.paragraphId !== to!.paragraphId || from!.offset !== to!.offset)
            doc.deleteRange(from!, to!);
        if (mode === "plain") {
            doc.replaceText(from!.paragraphId, from!.offset, from!.offset, value);
            ids = [from!.paragraphId];
        }
        else
            ids = doc.insertParagraphsAt(from!, paragraphs);
    });
    session.undo.stopCapturing();
    return ids;
}
