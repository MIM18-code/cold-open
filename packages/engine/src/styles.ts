// Editable production geometry uses the same FDX data that already drives editor and PDF layout.
import type { ElementLayout, PageLayout } from "./layout.ts";
import { ELEMENT_TYPES, type ElementType, type FdxDocumentExtras, type Script, type XmlNode } from "./model.ts";
import { fdxPaginationOptions, resolveLayout } from "./pagination.ts";
import { attr } from "./xml.ts";
export const FDX_STYLE_NAMES: Record<ElementType, string> = { sceneHeading: "Scene Heading", action: "Action", character: "Character", parenthetical: "Parenthetical", dialogue: "Dialogue", transition: "Transition", shot: "Shot", general: "General", lyrics: "Lyrics", castList: "Cast List", newAct: "New Act", endOfAct: "End of Act", section: "Section", synopsis: "Synopsis", note: "Note" };
export interface DocumentStyle {
    page: PageLayout;
    elements: Record<ElementType, ElementLayout>;
    returns: Partial<Record<ElementType, ElementType>>;
}
const children = (n: XmlNode, name: string) => n.children.find((c): c is XmlNode => typeof c !== "string" && c.name === name);
export function returnKeyFlow(script: Script): Partial<Record<ElementType, ElementType>> {
    const result: Partial<Record<ElementType, ElementType>> = {};
    for (const n of [...(script.fdx?.before ?? []), ...(script.fdx?.after ?? [])]) {
        if (n.name !== "ElementSettings")
            continue;
        const type = ELEMENT_TYPES.find((t) => FDX_STYLE_NAMES[t] === attr(n, "Type")), behavior = children(n, "Behavior");
        const next = behavior && ELEMENT_TYPES.find((t) => FDX_STYLE_NAMES[t] === attr(behavior, "ReturnKey"));
        if (type && next)
            result[type] = next;
    }
    return result;
}
export function readStyle(script: Script): DocumentStyle { return structuredClone({ ...resolveLayout(fdxPaginationOptions(script)), returns: returnKeyFlow(script) }); }
export function validateStyle(style: DocumentStyle): void {
    const p = style.page;
    for (const name of ["top", "bottom", "header", "footer"] as const)
        if (!Number.isFinite(p[name]) || p[name] < 0 || p[name] > 3)
            throw new Error(`${name} must be between 0 and 3 inches.`);
    if (p.top + p.bottom > p.height - 2)
        throw new Error("Keep at least two inches of printable page height.");
    for (const type of ELEMENT_TYPES) {
        const e = style.elements[type];
        if (!e || !Number.isFinite(e.left) || !Number.isFinite(e.right) || e.left < 0 || e.right > p.width || e.right - e.left < 0.5)
            throw new Error(`${FDX_STYLE_NAMES[type]} needs a valid text width of at least half an inch.`);
        if (!Number.isFinite(e.spaceBefore) || e.spaceBefore < 0 || e.spaceBefore > 12 || !Number.isFinite(e.spacing ?? 1) || (e.spacing ?? 1) < 0.5 || (e.spacing ?? 1) > 3)
            throw new Error(`${FDX_STYLE_NAMES[type]} has invalid spacing.`);
        if (!["left", "center", "right"].includes(e.align) || !Number.isFinite(e.firstIndent ?? 0) || Math.abs(e.firstIndent ?? 0) > 1)
            throw new Error(`${FDX_STYLE_NAMES[type]} has invalid alignment or first-line indent.`);
    }
    for (const [key, value] of Object.entries(style.returns))
        if (!ELEMENT_TYPES.includes(key as ElementType) || !ELEMENT_TYPES.includes(value as ElementType))
            throw new Error("Unknown element flow.");
}
const setAttrs = (node: XmlNode, values: Record<string, string>) => { for (const [k, v] of Object.entries(values)) {
    const at = node.attrs.findIndex(([name]) => name === k);
    if (at < 0)
        node.attrs.push([k, v]);
    else
        node.attrs[at] = [k, v];
} };
function child(node: XmlNode, name: string): XmlNode { let n = children(node, name); if (!n) {
    n = { name, attrs: [], children: [] };
    node.children.push(n);
} return n; }
/** Keeps unknown document/element attributes and child nodes; changing styles never replaces script text. */
export function writeStyle(script: Script, style: DocumentStyle): FdxDocumentExtras {
    validateStyle(style);
    const fdx: FdxDocumentExtras = structuredClone(script.fdx ?? { rootAttrs: [["DocumentType", "Script"], ["Template", "No"], ["Version", "3"]], contentAttrs: [], before: [], after: [] });
    for (const type of ELEMENT_TYPES) {
        if (["section", "synopsis", "note"].includes(type))
            continue;
        let n = [...fdx.before, ...fdx.after].find((n) => n.name === "ElementSettings" && attr(n, "Type") === FDX_STYLE_NAMES[type]);
        if (!n) {
            n = { name: "ElementSettings", attrs: [["Type", FDX_STYLE_NAMES[type]]], children: [] };
            fdx.after.push(n);
        }
        const e = style.elements[type], spec = child(n, "ParagraphSpec"), font = child(n, "FontSpec");
        setAttrs(spec, { LeftIndent: String(e.left), RightIndent: String(e.right), FirstIndent: String(e.firstIndent ?? 0), SpaceBefore: String(e.spaceBefore * 12), Spacing: String(e.spacing ?? 1), Alignment: e.align[0]!.toUpperCase() + e.align.slice(1) });
        const known = new Set(["AllCaps", "Bold", "Italic", "Underline"]);
        const flags = (attr(font, "Style") ?? "").split("+").filter((s) => s && !known.has(s));
        if (e.caps)
            flags.push("AllCaps");
        if (e.bold)
            flags.push("Bold");
        if (e.italic)
            flags.push("Italic");
        if (e.underline)
            flags.push("Underline");
        setAttrs(font, { Style: flags.join("+") });
        if (style.returns[type])
            setAttrs(child(n, "Behavior"), { ReturnKey: FDX_STYLE_NAMES[style.returns[type]!] });
    }
    let page = [...fdx.before, ...fdx.after].find((n) => n.name === "PageLayout");
    if (!page) {
        page = { name: "PageLayout", attrs: [], children: [] };
        fdx.after.push(page);
    }
    setAttrs(page, { TopMargin: String(style.page.top * 72), BottomMargin: String(style.page.bottom * 72), HeaderMargin: String(style.page.header * 72), FooterMargin: String(style.page.footer * 72) });
    return fdx;
}
