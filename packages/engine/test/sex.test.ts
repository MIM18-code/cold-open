import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  SEX_CATEGORIES, ScreenplayDoc, applyTag, parseFdx, parseSex, plainText, projectTags, sexFromScript, sexScenes, writeSex,
} from "../src/index.ts";

const SAMPLES = process.env.SEX_SAMPLES;

test("every sample round-trips byte for byte", { skip: SAMPLES ? false : "Set SEX_SAMPLES to the directory of .sex samples." }, () => {
  if (!SAMPLES || !existsSync(SAMPLES)) throw new Error(`SEX_SAMPLES does not exist: ${SAMPLES}`);
  const files = readdirSync(SAMPLES).filter((name) => name.toLowerCase().endsWith(".sex"));
  assert.ok(files.length, "The samples directory has no .sex files.");
  for (const name of files) {
    const bytes: Uint8Array = new Uint8Array(readFileSync(join(SAMPLES, name)));
    const file = parseSex(bytes);
    const header = file.records[0];
    assert.equal(header?.type, "header");
    assert.deepEqual(header.type === "header" ? header.categories : [], [...SEX_CATEGORIES], `${name} category table`);
    const scenes = sexScenes(file);
    assert.ok(scenes.length > 0, `${name} has no scenes`);
    for (const [index, scene] of scenes.entries()) {
      assert.equal(scene.scene.sequence, index + 1, `${name} scene ${index + 1} sequence`);
      assert.ok(scene.scene.page.length > 0, `${name} scene ${index + 1} has no page`);
      assert.ok(scene.scene.number.length > 0, `${name} scene ${index + 1} has no number`);
      assert.ok(scene.length, `${name} scene ${index + 1} has no length record`);
    }
    assert.deepEqual(writeSex(file), bytes, `${name} did not round-trip`);
  }
});

const FDX = `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Template="No" Version="3">
<Content>
<Paragraph Type="Scene Heading" id="s1"><Text>INT. CAFÉ — NIGHT</Text></Paragraph>
<Paragraph Type="Action" id="a1"><Text>A </Text><Text TagNumber="1">tarnished lamp</Text><Text> sits on the sill.</Text></Paragraph>
<Paragraph Type="Character" id="c1"><Text>RENÉE (V.O.)</Text></Paragraph>
<Paragraph Type="Dialogue" id="d1"><Text>Where is the </Text><Text TagNumber="2">blue van</Text><Text>?</Text></Paragraph>
<Paragraph Type="Character" id="c2"><Text>MARA (O.S.)</Text></Paragraph>
<Paragraph Type="Dialogue" id="d2"><Text>Outside.</Text></Paragraph>
<Paragraph Type="Action" id="a2"><Text>She lifts the </Text><Text TagNumber="3">C-stand</Text><Text>.</Text></Paragraph>
<Paragraph Type="Scene Heading" id="s2" Number="12A"><Text>EXT. PARK - DAY</Text></Paragraph>
<Paragraph Type="Action" id="a3"><Text>Rain on a </Text><Text TagNumber="4">cracked bench</Text><Text>.</Text></Paragraph>
<Paragraph Type="Action" id="a4"><Text TagNumber="5">Rain</Text></Paragraph>
<Paragraph Type="Character" id="c3"><Text>MARA (CONT'D)</Text></Paragraph>
<Paragraph Type="Dialogue" id="d3"><Text>“Still here.”</Text></Paragraph>
</Content>
<TagData>
<TagCategories>
<TagCategory Id="props" Name="Props"/>
<TagCategory Id="vehicles" Name="Vehicles"/>
<TagCategory Id="grip" Name="Grip Gear"/>
<TagCategory Id="sound" Name="Sound"/>
</TagCategories>
<TagDefinitions>
<TagDefinition Id="lamp" CatId="props" Label="Tarnished lamp" Number="1"/>
<TagDefinition Id="van" CatId="vehicles" Label="Blue van" Number="2"/>
<TagDefinition Id="stand" CatId="grip" Label="C-Stand" Number="3"/>
<TagDefinition Id="bench" CatId="props" Label="Cracked bench" Number="4"/>
<TagDefinition Id="rain" CatId="sound" Label="Rain" Number="5"/>
</TagDefinitions>
<Tags>
<Tag Number="1"><DefId>lamp</DefId></Tag>
<Tag Number="2"><DefId>van</DefId></Tag>
<Tag Number="3"><DefId>stand</DefId></Tag>
<Tag Number="4"><DefId>bench</DefId></Tag>
<Tag Number="5"><DefId>rain</DefId></Tag>
</Tags>
</TagData>
</FinalDraft>`;

test("a script becomes scenes, cast, tagged elements and imported categories", () => {
  // toScript projects the document's tag definitions and renumbers the runs, as the desktop export does.
  const script = ScreenplayDoc.fromScript(parseFdx(FDX)).toScript();
  const bytes = writeSex(sexFromScript(script, {
    pages: new Map([["s1", "1"], ["s2", "2"]]),
    lengths: new Map([["s1", 9]]),
  }));
  const file = parseSex(bytes);
  const header = file.records[0];
  assert.equal(header?.type, "header");
  assert.deepEqual(header.type === "header" ? header.categories : [], [...SEX_CATEGORIES]);
  assert.deepEqual(header.type === "header" ? [...header.prefix] : [], [0, 0]);

  const scenes = sexScenes(file);
  assert.equal(scenes.length, 2);
  const [first, second] = scenes;
  assert.ok(first && second);
  assert.equal(first.scene.page, "1");
  assert.equal(first.scene.number, "1");
  assert.equal(first.scene.heading, "INT. CAFÉ — NIGHT");
  assert.equal(second.scene.page, "2");
  assert.equal(second.scene.number, "12A");
  assert.equal(second.scene.heading, "EXT. PARK - DAY");
  assert.deepEqual(first.length, { type: "length", sequence: 1, pages: 1, eighths: 1 });
  assert.deepEqual(second.length, { type: "length", sequence: 2, pages: 0, eighths: 0 });

  const elements = (scene: typeof first) => scene.elements.map((element) => [element.category, element.name]);
  assert.deepEqual(elements(first), [
    [4, "Tarnished lamp"], [0, "RENÉE"], [3, "Blue van"], [0, "MARA"], [19, "C-Stand"],
  ]);
  // MARA appears once even though the second scene cues her as (CONT'D).
  assert.deepEqual(elements(second), [[4, "Cracked bench"], [11, "Rain"], [0, "MARA"]]);
  assert.ok(!first.elements.some((element) => /V\.O\.|O\.S\.|CONT'D/.test(element.name)));
  assert.ok(!second.elements.some((element) => /CONT'D/.test(element.name)));

  // Mac Roman, not UTF-8 or Latin-1: É is 0x83 and the em dash in the heading is 0xD1.
  assert.ok(bytes.includes(0x83), "expected a Mac Roman É");
  assert.ok(bytes.includes(0xd1), "expected a Mac Roman em dash");
  assert.equal(parseSex(writeSex(file)).records.length, file.records.length);
});

test("a tag authored in the app reaches the file after projectTags", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx(FDX));
  const action = doc.paragraphs().find((paragraph) => paragraph.id === "a1");
  assert.ok(action);
  const at = plainText(action.runs).indexOf("sill");
  applyTag(doc, { paragraphId: "a1", offset: at }, { paragraphId: "a1", offset: at + "sill".length }, "Props", "Candle");
  const script = doc.toScript();
  const projected = projectTags(doc, structuredClone(script));
  const scenes = sexScenes(parseSex(writeSex(sexFromScript(projected))));
  assert.deepEqual(scenes[0]?.elements.map((element) => [element.category, element.name]), [
    [4, "Tarnished lamp"], [4, "Candle"], [0, "RENÉE"], [3, "Blue van"], [0, "MARA"], [19, "C-Stand"],
  ]);
});

test("an unnumbered scene in a numbered draft gets a free A number, and notes stay out of headings and cast", () => {
  const p = (id: string, type: string, runs: { text: string; note?: boolean }[]) => ({ id, type, runs }) as any;
  const script = { titlePage: [], paragraphs: [
    { ...p("h1", "sceneHeading", [{ text: "INT. A - DAY" }]), sceneNumber: "1" },
    p("h2", "sceneHeading", [{ text: "INT. B - DAY" }, { text: " check this", note: true }]),
    p("c", "character", [{ text: "JANE" }, { text: " recast", note: true }]), p("d", "dialogue", [{ text: "Hi." }]),
    { ...p("h3", "sceneHeading", [{ text: "INT. C - DAY" }]), sceneNumber: "2" },
  ] };
  const scenes = parseSex(writeSex(sexFromScript(script))).records.filter((r: any) => r.type === "scene") as any[];
  assert.deepEqual(scenes.map((r) => r.number), ["1", "1A", "2"]);
  assert.equal(scenes[1].heading, "INT. B - DAY");
  const cast = parseSex(writeSex(sexFromScript(script))).records.filter((r: any) => r.type === "element").map((r: any) => r.name);
  assert.deepEqual(cast, ["JANE"]);
});

test("inserted scenes take A numbers from the numbered scene before them", () => {
  const heading = (id: string, number?: string) => ({ id, type: "sceneHeading", runs: [{ text: `INT. ${id} - DAY` }], ...(number ? { sceneNumber: number } : {}) }) as any;
  const numbers = (list: (string | undefined)[]) => (parseSex(writeSex(sexFromScript({ titlePage: [], paragraphs: list.map((n, i) => heading(`S${i}`, n)) } as any)))
    .records.filter((r: any) => r.type === "scene") as any[]).map((r) => r.number);
  assert.deepEqual(numbers(["10", undefined, "11"]), ["10", "10A", "11"]);
  assert.deepEqual(numbers(["1", undefined, undefined, "2"]), ["1", "1A", "1B", "2"]);
  assert.deepEqual(numbers(["1", undefined, "1A", "2"]), ["1", "1B", "1A", "2"], "an A number already taken is skipped");
  assert.deepEqual(numbers([undefined, undefined]), ["1", "2"], "an unnumbered draft keeps ordinals");
});

test("tags on a line turned into a note or synopsis aren't exported", () => {
  const script = { titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. A - DAY" }] },
    { id: "n", type: "note", runs: [{ text: "revolver", fdx: { TagNumber: "1" } }] },
  ], fdx: { rootAttrs: [], contentAttrs: [], before: [], after: [{ name: "TagData", attrs: [], children: [
    { name: "TagCategories", attrs: [], children: [{ name: "TagCategory", attrs: [["Id", "props"], ["Name", "Props"]], children: [] }] },
    { name: "TagDefinitions", attrs: [], children: [{ name: "TagDefinition", attrs: [["Id", "d1"], ["CatId", "props"], ["Label", "Revolver"], ["Number", "1"]], children: [] }] },
  ] }] } } as any;
  assert.deepEqual(parseSex(writeSex(sexFromScript(script))).records.filter((r: any) => r.type === "element"), []);
});
