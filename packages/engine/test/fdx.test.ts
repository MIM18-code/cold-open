import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ScreenplayDoc, addDeletionMark, deletionMarks, fdxOffset, fdxTitlePageNode, modelOffset, parseFdx, parseFountain, plainText, scenesOf,
  serializeXml, writeFdx, type XmlNode,
} from "../src/index.ts";
import { canonical, canonicalFdx, firstDifference } from "./canonical.ts";
import { parseXml } from "../src/xml.ts";

const source = readFileSync(new URL("./fixtures/synthetic.fdx", import.meta.url), "utf8");

function assertSameFdx(actual: string, expected: string, ignoreIds = false) {
  const a = canonical(parseXml(actual), { ignoreIds }), b = canonical(parseXml(expected), { ignoreIds });
  assert.equal(firstDifference(a, b), undefined);
}

test("reads paragraphs, types, IDs and scenes", () => {
  const script = parseFdx(source);
  const types = script.paragraphs.map((p) => p.type);
  assert.deepEqual(types, [
    "sceneHeading", "action", "character", "parenthetical", "dialogue", "action", "action",
    "character", "dialogue", "character", "parenthetical", "dialogue",
    "transition", "sceneHeading", "shot", "lyrics", "general", "endOfAct", "action",
  ]);
  const [heading] = script.paragraphs;
  assert.equal(heading!.id, "0f8a3c1e-2b7d-4c55-9e10-6a1d2f3b4c5d");
  assert.equal(heading!.sceneId, heading!.id);
  assert.equal(heading!.sceneNumber, "1");
  assert.equal(heading!.fdx?.before?.[0]?.name, "SceneProperties");

  const scenes = scenesOf(script.paragraphs);
  assert.deepEqual(scenes.map((s) => [s.heading, s.number, s.paragraphIds.length]), [
    ["EXT. SALVAGE YARD - DAWN", "1", 13],
    ["INT. YARD OFFICE - CONTINUOUS", "2A", 6],
  ]);
  assert.equal(script.paragraphs[13]!.startsNewPage, true);
});

test("keeps styled runs and entities", () => {
  const script = parseFdx(source);
  assert.deepEqual(script.paragraphs[1]!.runs[1], { text: "kicks", bold: true, underline: true });
  assert.equal(plainText(script.paragraphs[4]!.runs), "You and me had a deal. You & me — <signed>.");
  const centered = script.paragraphs[6]!;
  assert.equal(centered.alignment, "Center");
  assert.deepEqual(centered.runs[0], {
    text: "the end of the beginning", allCaps: true, styleExtra: "Shadow",
    fdx: { AdornmentStyle: "0", Background: "#FFFFFFFFFFFF", Color: "#000000000000", Font: "Courier Final Draft", RevisionID: "2", Size: "12" },
  });
});

test("dual dialogue becomes two sides of one block", () => {
  const script = parseFdx(source);
  const dual = script.paragraphs.slice(7, 12);
  assert.ok(dual.every((p) => p.dual?.block === "1a2b3c4d-0000-4000-8000-000000000007"));
  assert.deepEqual(dual.map((p) => p.dual!.side), [1, 1, 2, 2, 2]);
});

test("custom types, odd ID spellings and duplicate IDs", () => {
  const script = parseFdx(source);
  const custom = script.paragraphs[16]!;
  assert.equal(custom.id, "scene-one");
  assert.equal(custom.fdx?.type, "Montage Item");
  assert.equal(script.paragraphs[17]!.fdx?.idAttr, "Id");
  const last = script.paragraphs[18]!;
  assert.notEqual(last.id, script.paragraphs[1]!.id, "a repeated ID is replaced");
  assert.equal(new Set(script.paragraphs.map((p) => p.id)).size, script.paragraphs.length);
});

test("FDX round trip is lossless, directly and through the CRDT", () => {
  const script = parseFdx(source);
  assertSameFdx(writeFdx(script), source, true);
  const viaDoc = ScreenplayDoc.fromUpdate(ScreenplayDoc.fromScript(script).encodeState()).toScript();
  assert.deepEqual(viaDoc, script);
  const written = writeFdx(viaDoc);
  assertSameFdx(written, source, true);
  // IDs survive, except the duplicate the importer had to replace.
  const ids = (xml: string) => [...xml.matchAll(/ I[dD]="([^"]+)"/g)].map((m) => m[1]);
  const before = ids(source), after = ids(written);
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
  assert.equal(canonicalFdx(writeFdx(parseFdx(written))), canonicalFdx(written), "a second round trip changes nothing");
});

test("edits made in the CRDT show up in FDX without disturbing kept data", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx(source));
  const [heading] = doc.scenes();
  doc.deleteText(heading!.headingId, 0, 3);
  doc.insertText(heading!.headingId, 0, "INT");
  const action = doc.toScript().paragraphs[1]!.id;
  doc.format(action, 0, 4, { italic: true });
  const out = parseFdx(writeFdx(doc.toScript()));
  assert.equal(plainText(out.paragraphs[0]!.runs), "INT. SALVAGE YARD - DAWN");
  assert.equal(out.paragraphs[0]!.id, heading!.headingId);
  assert.equal(out.paragraphs[0]!.fdx?.before?.[0]?.name, "SceneProperties");
  assert.deepEqual(out.paragraphs[1]!.runs[0], { text: "Rows", italic: true });
});

test("a script with no FDX history writes a well-formed FDX", () => {
  const script = parseFountain("Title: Keys\nAuthor: Test Writer\n\nINT. OFFICE - DAY\n\nNell waits.\n\nNELL\nWell?\n\n# Notes\n");
  const warnings: string[] = [];
  const xml = writeFdx(script, { warnings });
  assert.equal(warnings.length, 1);
  const back = parseFdx(xml);
  assert.deepEqual(back.paragraphs.map((p) => [p.id, p.type, plainText(p.runs)]),
    script.paragraphs.filter((p) => p.type !== "section").map((p) => [p.id, p.type, plainText(p.runs)]));
  assert.match(xml, /<TitlePage>/);
});

test("a generated title page holds every field, notes included, with Final Draft's indents", () => {
  const xml = writeFdx({
    titlePage: [
      { key: "Title", values: ["Keys"] }, { key: "Credit", values: ["Written by"] }, { key: "Authors", values: ["Test Writer"] },
      { key: "Draft date", values: ["10/30/26"] }, { key: "Contact", values: ["writer@example.com"] }, { key: "Notes", values: ["WGA Registered"] },
    ],
    paragraphs: [{ id: "a", type: "action", runs: [{ text: "Nell waits." }] }],
  });
  const page = parseXml(xml).children.find((node) => typeof node !== "string" && node.name === "TitlePage") as XmlNode;
  const lines = (page.children[0] as XmlNode).children as XmlNode[];
  const texts = lines.map((line) => ((line.children[0] as XmlNode).children[0] as string | undefined) ?? "").filter(Boolean);
  assert.deepEqual(texts, ["KEYS", "Written by", "Test Writer", "WGA Registered", "writer@example.com", "10/30/26"]);
  assert.equal(lines.length, 54, "the date sits on the last line of the page");
  for (const line of lines) {
    assert.deepEqual(line.attrs.map(([name]) => name), ["Alignment", "FirstIndent", "Leading", "LeftIndent", "RightIndent", "SpaceBefore", "Spacing", "StartsNewPage"]);
  }
  const align = (text: string) => lines.find((line) => (line.children[0] as XmlNode).children[0] === text)!.attrs[0]![1];
  assert.deepEqual(["KEYS", "WGA Registered", "10/30/26"].map(align), ["Center", "Left", "Right"]);
  // Final Draft data without a TitlePage of its own also gets the generated one.
  const script = parseFdx(xml);
  script.fdx!.after = script.fdx!.after.filter((node) => node.name !== "TitlePage");
  assert.match(writeFdx({ ...script, titlePage: [{ key: "Title", values: ["Keys"] }] }), /<TitlePage>/);
});

test("a scene's index card summary is its synopsis, both ways", () => {
  const xml = `<?xml version="1.0"?><FinalDraft DocumentType="Script" Template="No" Version="5"><Content>
    <Paragraph Type="Scene Heading" id="h1"><SceneProperties Length="1" Page="1" Title=""><Summary><Paragraph Alignment="Left"><Text Font="Courier Final Draft" Size="12">Nell loses the keys.</Text></Paragraph><Paragraph Alignment="Left"><Text Font="Courier Final Draft" Size="12">Bob laughs.</Text></Paragraph></Summary><SceneArcBeats/></SceneProperties><Text>INT. OFFICE - DAY</Text></Paragraph>
    <Paragraph Type="Action" id="a1"><Text>Nell waits.</Text></Paragraph>
    <Paragraph Type="Scene Heading" id="h2"><Text>EXT. YARD - NIGHT</Text></Paragraph>
  </Content></FinalDraft>`;
  const script = parseFdx(xml);
  assert.deepEqual(script.paragraphs.map((p) => [p.type, plainText(p.runs)]), [
    ["sceneHeading", "INT. OFFICE - DAY"], ["synopsis", "Nell loses the keys.\nBob laughs."], ["action", "Nell waits."], ["sceneHeading", "EXT. YARD - NIGHT"],
  ]);
  // Unchanged, it is written back exactly.
  assertSameFdx(writeFdx(script), xml);
  // Edited, the summary changes; a new synopsis on the second scene gets a Summary of its own; no warnings.
  const doc = ScreenplayDoc.fromScript(script);
  const synopsis = doc.paragraphs()[1]!;
  doc.deleteText(synopsis.id, 0, plainText(synopsis.runs).length);
  doc.insertText(synopsis.id, 0, "Nell finds the keys.");
  doc.insertParagraph(4, { type: "synopsis", runs: [{ text: "Night falls." }] });
  const warnings: string[] = [];
  const out = writeFdx(doc.toScript(), { warnings });
  assert.deepEqual(warnings, []);
  assert.match(out, /<Summary>\s*<Paragraph Alignment="Left">\s*<Text Font="Courier Final Draft" Size="12">Nell finds the keys\.<\/Text>/);
  assert.match(out, /<SceneProperties Title="">\s*<Summary>[\s\S]*Night falls\./);
  assert.deepEqual(parseFdx(out).paragraphs.filter((p) => p.type === "synopsis").map((p) => plainText(p.runs)), ["Nell finds the keys.", "Night falls."]);
  // A deleted synopsis removes the summary; a synopsis not under a heading is still skipped with a warning.
  doc.deleteParagraph(synopsis.id);
  doc.insertParagraph(3, { type: "synopsis", runs: [{ text: "Loose." }] });
  const more: string[] = [];
  const last = writeFdx(doc.toScript(), { warnings: more });
  assert.doesNotMatch(last, /Nell finds/);
  assert.equal(more.length, 1);
});

test("rejects things that are not FDX", () => {
  assert.throws(() => parseFdx("<NotFinalDraft/>"), /root element/);
  assert.throws(() => parseFdx("<FinalDraft/>"), /no Content/);
  assert.throws(() => parseFdx("<FinalDraft><Content>"), /./);
  assert.throws(() => parseFdx('<!DOCTYPE x [<!ENTITY a "aaaa">]><FinalDraft><Content/></FinalDraft>'), /DOCTYPE/);
});

test("repairs files other tools wrote badly, and says so", () => {
  const warnings: string[] = [];
  const script = parseFdx(`<FinalDraft><Content><Paragraphs>
    <Paragraph Type="Action">Bare text, no Text element</Paragraph>
    <Paragraph Type="Action"><Text Style="++++">Empty style flags</Text></Paragraph>
  </Paragraphs><Bogus/></Content></FinalDraft>`, { warnings });
  assert.deepEqual(script.paragraphs.map((p) => plainText(p.runs)), ["Bare text, no Text element", "Empty style flags"]);
  assert.equal(warnings.length, 3);
  assert.match(writeFdx(script), /<Text Style="\+\+\+\+">Empty style flags<\/Text>/);
});

test("control characters XML cannot hold are never written, so a saved FDX file always reopens (final review #2)", () => {
  // Pasted text keeps whatever the clipboard held: a vertical tab from a word processor, a NUL, a lone surrogate.
  for (const character of ["\u000B", "\u000C", "\u0000", "\u0008", "\u001F", "￾", "￿", "\uD800", "\uDC00"]) {
    const doc = ScreenplayDoc.fromScript({ titlePage: [{ key: "Title", values: [`Keys${character}`] }], paragraphs: [
      { id: "a1", type: "action", runs: [{ text: `He opens the door.${character}She waits.` }] },
      { id: "h1", type: "sceneHeading", sceneNumber: `1${character}`, runs: [{ text: "INT. ROOM - DAY" }] },
    ] });
    const warnings: string[] = [];
    const xml = writeFdx(doc.toScript(), { warnings });
    const back = parseFdx(xml);
    const space = character === "\u000B" || character === "\u000C" ? " " : "";
    assert.equal(plainText(back.paragraphs[0]!.runs), `He opens the door.${space}She waits.`, JSON.stringify(character));
    assert.equal(back.paragraphs[1]!.sceneNumber, `1${space}`);
    assert.equal(warnings.length, 1, JSON.stringify(character));
    assert.match(warnings[0]!, /control characters? that FDX cannot hold \(U\+[0-9A-F]{4}\)/);
  }
  // Tabs, line breaks and every other character are written as they are.
  const plain = "Tab\there,\nline two; café \u{1F3AC} — end.";
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "a1", type: "action", runs: [{ text: plain }] }] });
  const warnings: string[] = [];
  assert.equal(plainText(parseFdx(writeFdx(doc.toScript(), { warnings })).paragraphs[0]!.runs), plain);
  assert.deepEqual(warnings, []);
});

test("a file holding control characters XML does not allow opens without them, with a warning", () => {
  const warnings: string[] = [];
  const script = parseFdx(`<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Template="No" Version="5"><Content>
  <Paragraph Type="Action" id="a1"><Text>Raw\u000Btab, raw\u0000nul</Text></Paragraph>
  <Paragraph Type="Action" id="a2" Note="x&#1;y"><Text>Reference&#11;tab, &#x0;nul, kept&#x9;tab &#233;</Text></Paragraph>
</Content></FinalDraft>`, { warnings });
  assert.deepEqual(script.paragraphs.map((p) => plainText(p.runs)), ["Raw tab, rawnul", "Reference tab, nul, kept\ttab é"]);
  assert.deepEqual(script.paragraphs[1]!.fdx?.attrs, [["Note", "xy"]]);
  assert.deepEqual(warnings, ["Removed 5 control characters that XML does not allow."]);
});

test("text left after </FinalDraft> by an earlier, longer write is ignored with a warning (final review #6)", () => {
  const xml = writeFdx(parseFdx(source));
  for (const tail of ["alDraft>\n", "\u0000\u0000\u0000\u0000", "</Content></FinalDraft>", "<Paragraph Type=\"Action\"><Text>stale</Text></Paragraph>\n</Content>\n</Fin"]) {
    const warnings: string[] = [];
    const script = parseFdx(xml + tail, { warnings });
    assert.equal(script.paragraphs.length, parseFdx(source).paragraphs.length, JSON.stringify(tail));
    assert.equal(warnings.length, 1, JSON.stringify(tail));
    assert.match(warnings[0]!, tail.startsWith("\u0000") ? /control characters/ : /after the end of the document \(<\/FinalDraft>\)/);
    assertSameFdx(writeFdx(script), xml);
  }
  // Whitespace after the root element is allowed XML, and no repair.
  const warnings: string[] = [];
  parseFdx(`${xml}\n\n  \n`, { warnings });
  assert.deepEqual(warnings, []);
  // A document that is broken before its end still fails.
  assert.throws(() => parseFdx(xml.replace("</Content>", "")), /XML|tag|close/i);
});

test("deletion marks and locked pages after an inline note are written where Final Draft counts them (final review #5)", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", sceneId: "h", runs: [{ text: "INT. A - DAY" }] },
    { id: "a", type: "action", runs: [{ text: "He walks " }, { text: "check this later", note: true }, { text: "to the door and stops." }] },
    { id: "b", type: "action", runs: [{ text: "Next paragraph here." }] },
  ] });
  const text = plainText(doc.paragraph("a").runs);
  const at = text.indexOf("stops");
  addDeletionMark(doc, "a", at, "1");
  doc.meta.set("pageLocks", { pages: [
    { number: "1", paragraphId: "h", offset: 0, paragraphIds: [], level: 0 },
    { number: "2", paragraphId: "a", offset: at, paragraphIds: ["b"], level: 0 },
  ] });
  const xml = writeFdx(doc.toScript());
  // "INT. A - DAY" and its break, then "He walks to the door and " without the note.
  const expected = 13 + "He walks to the door and ".length;
  assert.match(xml, new RegExp(`<DeletedTextLocation Offset="${expected}" RevisionID="1"/>`));
  assert.match(xml, new RegExp(`PageNumber="2" Position="${expected}"`));
  const back = parseFdx(xml).paragraphs.find((p) => p.id === "a")!;
  const mark = deletionMarks(back)[0]!;
  assert.equal(plainText(back.runs).slice(mark.offset, mark.offset + 5), "stops");
  // A position inside a note goes to where the note starts.
  assert.equal(fdxOffset(doc.paragraph("a"), 12), 9);
  assert.equal(modelOffset(doc.paragraph("a"), 9), 9);
  assert.equal(modelOffset(doc.paragraph("a"), 10), 26);
});

test("Fountain emphasis in title page fields becomes Final Draft styles, not literal asterisks", () => {
  const node = fdxTitlePageNode([{ key: "Title", values: ["**Keys**"] }, { key: "Author", values: ["_Test Writer_"] }])!;
  const xml = serializeXml(node);
  assert.ok(!xml.includes("**"), "no literal markers");
  assert.match(xml, /Style="Bold">KEYS</);
  assert.match(xml, /Style="Underline">Test Writer</);
});

test("a numeric reference inside CDATA is literal text and survives import and save", () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?><FinalDraft DocumentType="Script" Template="No" Version="5"><Content>` +
    `<Paragraph Type="Action"><Text><![CDATA[Literal &#0; stays]]></Text></Paragraph>` +
    `<Paragraph Type="Action"><Text>Bad &#1; goes</Text></Paragraph></Content></FinalDraft>`;
  const warnings: string[] = [];
  const script = parseFdx(source, { warnings });
  assert.equal(plainText(script.paragraphs[0]!.runs), "Literal &#0; stays");
  assert.equal(plainText(script.paragraphs[1]!.runs), "Bad  goes");
  const again = parseFdx(writeFdx(script));
  assert.equal(plainText(again.paragraphs[0]!.runs), "Literal &#0; stays");
});
