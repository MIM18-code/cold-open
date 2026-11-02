import { parseFdx, parseFountain, plainText, type Script } from "@screenplay/engine";
import { decodeNative, isNative } from "../../renderer/core/fileformat.ts";
export interface ScriptHit {
    paragraphId: string;
    paragraphIndex: number;
    text: string;
    offset: number;
    type: string;
    heading: string;
}
export function scriptFromBytes(data: Uint8Array): Script {
    if (data.byteLength > 8000000)
        throw new Error("Search supports script files up to 8 MB.");
    if (isNative(data)) {
        const { doc } = decodeNative(data);
        try {
            return doc.toScript();
        }
        finally {
            doc.ydoc.destroy();
        }
    }
    const text = new TextDecoder().decode(data);
    return /<FinalDraft[\s>]/.test(text.slice(0, 3000)) ? parseFdx(text) : parseFountain(text);
}
/** Literal search: no regular expressions, indexing service, recursive folder walk or cloud requests. */
export function searchScript(script: Script, query: string, caseSensitive = false, limit = 100): ScriptHit[] {
    if (typeof query !== "string" || !query.trim() || query.length > 300)
        throw new Error("Search for 1–300 characters.");
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "u" : "iu"), hits: ScriptHit[] = [];
    let heading = "Before the first scene";
    for (const [index, p] of script.paragraphs.entries()) {
        const text = plainText(p.runs);
        if (p.type === "sceneHeading")
            heading = text;
        const at = pattern.exec(text)?.index ?? -1;
        if (at >= 0) {
            hits.push({ paragraphId: p.id, paragraphIndex: index, text: text.slice(Math.max(0, at - 60), at + query.length + 120), offset: at, type: p.type, heading });
            if (hits.length >= limit)
                break;
        }
    }
    return hits;
}
