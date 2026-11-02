/** FDX breakdown tags use definitions plus span attributes; screenplay text remains untouched. */
import type { ScreenplayDoc, TextPosition } from "./doc.ts";
import { NON_PRINTING, plainText, type Script, type XmlNode } from "./model.ts";
import { attr, textOf } from "./xml.ts";
export const TAG_CATEGORIES = [
    ["Cast Members", "01fc9642-84ff-4366-b37c-a3068dee57e8", 2], ["Background Actors", "028a4e2b-b507-4d09-88ab-90e3edae9071", 3],
    ["Stunts", "0377dbe6-77a3-41af-bda8-86eb2468fdbf", 4], ["Vehicles", "04721a56-f54b-49c8-80ad-d53887d6b851", 5],
    ["Props", "05c556eb-6bc1-4a3a-b09f-f8b5ba1b6afa", 6], ["Special Effects", "069e18b8-2109-4f3d-94e7-d802027a60a8", 8],
    ["Wardrobe", "0726fa85-1e65-4ab8-87de-bf21d09b01f0", 9], ["Makeup/Hair", "08ae1eef-32ce-415f-9a9b-0982d2453ec4", 10],
    ["Animals", "09cb0d1c-ce01-4f22-bb64-b5f2e6c491c6", 11], ["Music", "0b0b44c9-aa4b-4c40-88b1-d94472ad7a26", 13],
    ["Sound", "0ce7d308-096d-4603-8fe8-349f72cd89ff", 15], ["Set Dressing", "0debb71b-5743-4c53-80cc-e17e841ce645", 17],
    ["Visual Effects", "12ab0932-e3b9-4b4a-bcd0-3da1b4e61d5e", 23], ["Miscellaneous", "ce04f547-f7ee-40c9-ab66-d95a0c98034e", 25],
] as const;
export const PROJECT_TAG_PREFIX = "fdx.tagDefinition.";
export interface TagDefinition {
    number: string;
    id: string;
    label: string;
    category: string;
    categoryId: string;
}
export function xmlNamed(nodes: readonly XmlNode[], name: string): XmlNode[] {
    return nodes.flatMap(n => n.name === name ? [n] : xmlNamed(n.children.filter((c): c is XmlNode => typeof c !== "string"), name));
}
export function tagDefinitions(script: Script): TagDefinition[] {
    const roots = [...(script.fdx?.before ?? []), ...(script.fdx?.after ?? [])];
    const categories = new Map(xmlNamed(roots, "TagCategory").map(n => [attr(n, "Id"), attr(n, "Name")]));
    const defs = xmlNamed(roots, "TagDefinition"), byId = new Map(defs.map(n => [attr(n, "Id"), n]));
    const references = xmlNamed(roots, "Tag").map(n => ({ number: attr(n, "Number"), def: byId.get(textOf(n).trim()) }));
    const rows = references.filter((r): r is {
        number: string;
        def: XmlNode;
    } => !!r.number && !!r.def);
    // Some older writers omit the Tags lookup and use definition numbers directly. A file that has a lookup numbers
    // placements and definitions separately (Final Draft, Gorilla), so there an unmapped number stays unresolved.
    if (!xmlNamed(roots, "Tags").length) for (const def of defs) {
        const number = attr(def, "Number");
        if (number && !rows.some(r => r.number === number))
            rows.push({ number, def });
    }
    return rows.map(({ number, def }) => ({ number, id: attr(def, "Id") ?? "", label: attr(def, "Label") ?? "", category: categories.get(attr(def, "CatId")) ?? "Unresolved category", categoryId: attr(def, "CatId") ?? "" }));
}
function spans(doc: ScreenplayDoc, from: TextPosition, to: TextPosition): {
    id: string;
    start: number;
    end: number;
}[] {
    const a = doc.bodyIndex(from), b = doc.bodyIndex(to);
    if (a === b)
        throw new Error("Select some printable text first.");
    if (a > b)
        [from, to] = [to, from];
    const ps = doc.paragraphs(), start = doc.indexOf(from.paragraphId), end = doc.indexOf(to.paragraphId);
    if (start < 0 || end < start)
        throw new Error("The selection changed.");
    return ps.slice(start, end + 1).flatMap((p, i) => {
        const left = i === 0 ? from.offset : 0, right = start + i === end ? to.offset : plainText(p.runs).length;
        if (left < 0 || right > plainText(p.runs).length)
            throw new Error("Invalid tag selection.");
        return right > left && !NON_PRINTING.has(p.type) ? [{ id: p.id, start: left, end: right }] : [];
    });
}
export function applyTag(doc: ScreenplayDoc, from: TextPosition, to: TextPosition, category: string, label: string, replace = false): string {
    const span = spans(doc, from, to);
    if (!span.length)
        throw new Error("Select printable text, not a project note.");
    label = label.trim();
    if (!label || label.length > 200)
        throw new Error("Give this element a name up to 200 characters.");
    const source = doc.toScript(), defs = tagDefinitions(source), existing = defs.find(d => d.label === label && d.category === category);
    const known = TAG_CATEGORIES.find(c => c[0] === category), imported = defs.find(d => d.category === category && d.categoryId);
    if (!known && !imported)
        throw new Error("Choose a supported or imported breakdown category.");
    for (const s of span) {
        let offset = 0;
        for (const r of doc.paragraph(s.id).runs) {
            const end = offset + r.text.length;
            if (end > s.start && offset < s.end) {
                if (r.note)
                    throw new Error("The selection contains an inline note. Select only the screenplay text.");
                if (r.fdx?.TagNumber && r.fdx.TagNumber !== existing?.number && !replace)
                    throw new Error("The selection already contains another tag. Review replacement before applying.");
            }
            offset = end;
        }
    }
    const used = new Set([...defs.map(d => d.number), ...source.paragraphs.flatMap(p => p.runs.flatMap(r => r.fdx?.TagNumber ? [r.fdx.TagNumber] : []))]);
    let number = existing?.number ?? "1";
    if (!existing) {
        let n = 1;
        while (used.has(String(n)))
            n++;
        number = String(n);
    }
    const id = existing?.id || crypto.randomUUID();
    if (!existing)
        doc.meta.set(PROJECT_TAG_PREFIX + id, { id, label, category, categoryId: imported?.categoryId ?? known![1], categoryNumber: known?.[2] ?? 25 });
    const projectOwned = doc.meta.has(PROJECT_TAG_PREFIX + id);
    for (const s of span)
        doc.formatRuns(s.id, s.start, s.end - s.start, { "fdx:TagNumber": number, "fdx:InklotTagId": projectOwned ? id : null });
    return number;
}
/** Each newly authored definition is a separate CRDT record. Concurrent authors may initially choose
 * the same display number; export assigns distinct numbers by stable ID and rewrites only their spans. */
export function projectTags(doc: ScreenplayDoc, source: Script): Script {
    const records = [...doc.meta.entries()].filter(([key]) => key.startsWith(PROJECT_TAG_PREFIX)).map(([, value]) => value as {
        id: string;
        label: string;
        category: string;
        categoryId: string;
        categoryNumber: number;
    }).filter(v => v && typeof v.id === "string" && typeof v.label === "string" && typeof v.categoryId === "string" && typeof v.category === "string").sort((a, b) => a.id.localeCompare(b.id));
    if (!records.length) {
        resolveTagReferences(source, new Map(tagDefinitions(source).map(d => [d.id, d.number])));
        return source;
    }
    const definitions = tagDefinitions(source);
    // New numbers avoid every number already in the file: mapped tags, raw definition numbers, lookup entries and
    // placements, so nothing new can be mistaken for an older tag.
    const sourceRoots = [...(source.fdx?.before ?? []), ...(source.fdx?.after ?? [])];
    const used = new Set([
        ...definitions.map(d => d.number),
        ...xmlNamed(sourceRoots, "TagDefinition").map(n => attr(n, "Number")).filter((n): n is string => !!n),
        ...xmlNamed(sourceRoots, "Tag").map(n => attr(n, "Number")).filter((n): n is string => !!n),
        ...source.paragraphs.flatMap(p => p.runs.filter(r => !r.fdx?.InklotTagId).flatMap(r => r.fdx?.TagNumber ? [r.fdx.TagNumber] : [])),
    ]);
    const fdx = source.fdx ??= { rootAttrs: [["DocumentType", "Script"], ["Version", "3"]], contentAttrs: [], before: [], after: [] };
    let root = xmlNamed([...fdx.before, ...fdx.after], "TagData")[0];
    if (!root) {
        root = { name: "TagData", attrs: [], children: [] };
        fdx.after.push(root);
    }
    const group = (name: string) => { let g = root!.children.find((n): n is XmlNode => typeof n !== "string" && n.name === name); if (!g) {
        g = { name, attrs: [], children: [] };
        root!.children.push(g);
    } return g; };
    // Older writers omit the Tags lookup and number placements by definition (tagDefinitions falls back to that).
    // Readers that trust the lookup once it exists would then lose those tags, so when this export creates the
    // lookup, every existing definition gets its entry too.
    // Seed only a lookup this export creates; a file that already has one keeps exactly its own mappings.
    let lookupSeeded = xmlNamed([root], "Tags").length > 0;
    const lookup = () => {
        const tags = group("Tags");
        if (!lookupSeeded) {
            lookupSeeded = true;
            const listed = new Set(xmlNamed([tags], "Tag").map(n => attr(n, "Number")));
            const nodes = xmlNamed([...fdx.before, ...fdx.after], "TagDefinition");
            for (const d of definitions) {
                if (listed.has(d.number)) continue;
                let id = d.id;
                if (!id) {
                    // A lookup entry needs a definition ID; give an ID-less legacy definition a stable one.
                    const node = nodes.find(n => !attr(n, "Id") && attr(n, "Number") === d.number);
                    if (!node) continue;
                    id = `inklot-legacy-tag-${d.number}`;
                    while (nodes.some(n => attr(n, "Id") === id)) id += "-1";
                    node.attrs.push(["Id", id]);
                }
                listed.add(d.number);
                tags.children.push({ name: "Tag", attrs: [["Number", d.number]], children: [{ name: "DefId", attrs: [], children: [id] }] });
            }
        }
        return tags;
    };
    const numbers = new Map(definitions.map(d => [d.id, d.number]));
    for (const record of records) {
        const found = definitions.find(d => d.id === record.id);
        if (found) {
            numbers.set(record.id, found.number);
            continue;
        }
        let n = 1;
        while (used.has(String(n)))
            n++;
        const number = String(n);
        used.add(number);
        numbers.set(record.id, number);
        const categories = group("TagCategories");
        if (!xmlNamed([categories], "TagCategory").some(n => attr(n, "Id") === record.categoryId))
            categories.children.push({ name: "TagCategory", attrs: [["Id", record.categoryId], ["Name", record.category], ["Number", String(record.categoryNumber)], ["Color", "#94AA11150000"]], children: [] });
        group("TagDefinitions").children.push({ name: "TagDefinition", attrs: [["Id", record.id], ["CatId", record.categoryId], ["Label", record.label], ["Number", number]], children: [] });
        lookup().children.push({ name: "Tag", attrs: [["Number", number]], children: [{ name: "DefId", attrs: [], children: [record.id] }] });
    }
    resolveTagReferences(source, numbers);
    return source;
}
function resolveTagReferences(source: Script, numbers: ReadonlyMap<string, string>): void {
    for (const p of source.paragraphs)
        for (const run of p.runs) {
            const id = run.fdx?.InklotTagId;
            if (id && run.fdx) {
                const number = numbers.get(id);
                if (number) run.fdx.TagNumber = number;
                else delete run.fdx.TagNumber;
                delete run.fdx.InklotTagId;
            }
        }
}
export function removeTag(doc: ScreenplayDoc, from: TextPosition, to: TextPosition): void { for (const s of spans(doc, from, to))
    doc.formatRuns(s.id, s.start, s.end - s.start, { "fdx:TagNumber": null, "fdx:InklotTagId": null }); }
