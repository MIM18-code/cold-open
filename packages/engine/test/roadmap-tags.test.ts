import test from "node:test";
import assert from "node:assert/strict";
import { ScreenplayDoc, parseFountain, parseFdx, writeFdx, plainText, applyTag, removeTag, tagDefinitions, tagReport, paginate } from "../src/index.ts";
const make = () => ScreenplayDoc.fromScript(parseFountain('INT. ROOM - DAY\n\nA red door beside a blue car.'));
test('authored tags round trip with spans, names and categories without changing words', () => { const doc = make(), p = doc.paragraphs()[1]!; const before = plainText(p.runs); applyTag(doc, { paragraphId: p.id, offset: 2 }, { paragraphId: p.id, offset: 10 }, 'Props', 'Red door'); let s = doc.toScript(); assert.equal(plainText(s.paragraphs[1]!.runs), before); const xml = writeFdx(s); assert(!xml.includes('InklotTagId')); s = parseFdx(xml); assert.equal(tagDefinitions(s)[0]?.label, 'Red door'); const report = tagReport(s, paginate(s)); assert.equal(report[0]?.text, 'red door'); assert.equal(report[0]?.category, 'Props'); doc.ydoc.destroy(); });
test('tagging refuses silent replacement; removing tags keeps the source and reusable definitions', () => { const doc = make(), p = doc.paragraphs()[1]!, from = { paragraphId: p.id, offset: 2 }, to = { paragraphId: p.id, offset: 10 }; applyTag(doc, from, to, 'Props', 'Door'); assert.throws(() => applyTag(doc, from, to, 'Vehicles', 'Car'), /already contains/); removeTag(doc, from, to); assert.equal(tagReport(doc.toScript(), paginate(doc.toScript())).length, 0); assert.equal(tagDefinitions(doc.toScript()).length, 1); doc.ydoc.destroy(); });
test('concurrent tag definitions retain both identities and get distinct exported numbers on every replica', () => { const a = make(), b = ScreenplayDoc.fromUpdate(a.encodeState()), p = a.paragraphs()[1]!; applyTag(a, { paragraphId: p.id, offset: 2 }, { paragraphId: p.id, offset: 10 }, 'Props', 'Door'); applyTag(b, { paragraphId: p.id, offset: 20 }, { paragraphId: p.id, offset: 28 }, 'Vehicles', 'Car'); const ua = a.encodeState(), ub = b.encodeState(); a.applyUpdate(ub); b.applyUpdate(ua); assert.equal(writeFdx(a.toScript()), writeFdx(b.toScript())); const defs = tagDefinitions(a.toScript()); assert.equal(defs.length, 2); assert.equal(new Set(defs.map(d => d.number)).size, 2); assert.deepEqual(tagReport(a.toScript(), paginate(a.toScript())).map(r => r.label), ['Door', 'Car']); a.ydoc.destroy(); b.ydoc.destroy(); });

test("unknown private tag IDs are untagged with or without target definitions", () => {
    for (const tagged of [false, true]) {
        const doc = make(), p = doc.paragraphs()[1]!;
        if (tagged) applyTag(doc, { paragraphId: p.id, offset: 0 }, { paragraphId: p.id, offset: 1 }, "Props", "Known");
        doc.formatRuns(p.id, 2, 3, { "fdx:TagNumber": "99", "fdx:InklotTagId": "foreign-tag" });
        const script = doc.toScript();
        const pasted = script.paragraphs[1]!.runs.find(r => r.text === "red")!;
        assert.equal(pasted.fdx?.TagNumber, undefined);
        assert.equal(pasted.fdx?.InklotTagId, undefined);
        assert.doesNotMatch(writeFdx(script), /InklotTagId|TagNumber="99"/);
        assert.equal(tagReport(script, paginate(script)).length, tagged ? 1 : 0);
        doc.ydoc.destroy();
    }
});

test("tagging an older FDX that has no Tags lookup keeps its existing tags resolvable", () => {
    // Older exports carry numbered TagDefinitions and no <Tags> lookup. Readers that trust the lookup once it exists
    // (Backlot's bridge, Gorilla) would lose tag 1 if the new lookup listed only the newly added tag.
    const legacy = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5"><Content>
<Paragraph Type="Scene Heading"><Text>INT. HALL - DAY</Text></Paragraph>
<Paragraph Type="Action"><Text TagNumber="1">An umbrella</Text><Text> and a notebook.</Text></Paragraph>
</Content><TagData><TagCategories><TagCategory Id="props" Name="Props" Number="1"/></TagCategories>
<TagDefinitions><TagDefinition Id="umbrella" CatId="props" Number="1" Label="Umbrella"/></TagDefinitions></TagData></FinalDraft>`;
    const doc = ScreenplayDoc.fromScript(parseFdx(legacy)), p = doc.paragraphs()[1]!;
    const at = plainText(p.runs).indexOf("notebook");
    applyTag(doc, { paragraphId: p.id, offset: at }, { paragraphId: p.id, offset: at + "notebook".length }, "Props", "Notebook");
    const xml = writeFdx(doc.toScript());
    const lookup = [...xml.matchAll(/<Tag Number="(\d+)">\s*<DefId>([^<]+)<\/DefId>\s*<\/Tag>/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(lookup.find(([, id]) => id === "umbrella"), ["1", "umbrella"]);
    assert.equal(lookup.length, 2);
    const reread = tagDefinitions(parseFdx(xml));
    const numbers = [...xml.matchAll(/TagNumber="(\d+)"/g)].map(m => m[1]);
    assert.deepEqual(numbers.map(n => reread.find(d => d.number === n)?.label).sort(), ["Notebook", "Umbrella"]);
});

test("a legacy definition without an Id still gets a lookup entry when a tag is added", () => {
    const legacy = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5"><Content>
<Paragraph Type="Action"><Text TagNumber="1">An umbrella</Text><Text> and a notebook.</Text></Paragraph>
</Content><TagData><TagCategories><TagCategory Id="props" Name="Props" Number="1"/></TagCategories>
<TagDefinitions><TagDefinition CatId="props" Number="1" Label="Umbrella"/></TagDefinitions></TagData></FinalDraft>`;
    const doc = ScreenplayDoc.fromScript(parseFdx(legacy)), p = doc.paragraphs()[0]!;
    const at = plainText(p.runs).indexOf("notebook");
    applyTag(doc, { paragraphId: p.id, offset: at }, { paragraphId: p.id, offset: at + "notebook".length }, "Props", "Notebook");
    for (const xml of [writeFdx(doc.toScript()), writeFdx(parseFdx(writeFdx(doc.toScript())))]) {
        assert.equal([...xml.matchAll(/<Tag Number="/g)].length, 2);
        const reread = tagDefinitions(parseFdx(xml));
        const numbers = [...xml.matchAll(/TagNumber="(\d+)"/g)].map(m => m[1]);
        assert.deepEqual(numbers.map(n => reread.find(d => d.number === n)?.label).sort(), ["Notebook", "Umbrella"]);
    }
});

test("a file with its own Tags lookup keeps exactly its mappings when a tag is added", () => {
    // Final Draft numbers placements and definitions separately: placement 2 is unmapped here and must stay that way,
    // not resolve to the definition that happens to have Number="2".
    const fd = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5"><Content>
<Paragraph Type="Action"><Text TagNumber="41">An umbrella</Text><Text>, a </Text><Text TagNumber="2">notebook</Text><Text> and a lamp.</Text></Paragraph>
</Content><TagData><TagCategories><TagCategory Id="props" Name="Props" Number="1"/></TagCategories>
<TagDefinitions><TagDefinition Id="umbrella" CatId="props" Number="1" Label="Umbrella"/><TagDefinition Id="notebook" CatId="props" Number="2" Label="Notebook"/></TagDefinitions>
<Tags><Tag Number="41"><DefId>umbrella</DefId></Tag></Tags></TagData></FinalDraft>`;
    const before = tagDefinitions(parseFdx(fd));
    assert.deepEqual(before.map(d => [d.number, d.label]), [["41", "Umbrella"]]);
    const doc = ScreenplayDoc.fromScript(parseFdx(fd)), p = doc.paragraphs()[0]!;
    const at = plainText(p.runs).indexOf("lamp");
    applyTag(doc, { paragraphId: p.id, offset: at }, { paragraphId: p.id, offset: at + "lamp".length }, "Props", "Lamp");
    const xml = writeFdx(doc.toScript());
    const lookup = [...xml.matchAll(/<Tag Number="(\d+)">\s*<DefId>([^<]+)<\/DefId>/g)].map(m => [m[1], m[2]]);
    assert.equal(lookup.find(([n]) => n === "2"), undefined);
    assert.deepEqual(lookup[0], ["41", "umbrella"]);
    assert.equal(lookup.length, 2);
    const after = tagDefinitions(parseFdx(xml));
    assert.equal(after.find(d => d.number === "2"), undefined);
    assert.deepEqual(after.map(d => d.label).sort(), ["Lamp", "Umbrella"]);
});
