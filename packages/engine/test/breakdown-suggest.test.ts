import test from "node:test";
import assert from "node:assert/strict";
import { castSuggestions, locateElement, normalizeSuggestions, type Paragraph, type Script } from "../src/index.ts";

const p = (id: string, type: Paragraph["type"], text: string): Paragraph => ({ id, type, runs: [{ text }] });
const script = (...paragraphs: Paragraph[]): Script => ({ titlePage: [], paragraphs: [p("h", "sceneHeading", "INT. ROOM - DAY"), ...paragraphs] });

test("cast prefers the full name over an earlier first-name mention, dedupes cues and strips extensions", () => {
  const s = script(p("a", "action", "Mayans scatter. Maya holds a revolver. MAYA SANTOS turns to Eli."),
    p("c", "character", "MAYA SANTOS (V.O.) (CONT'D)"), p("d", "dialogue", "Hi."), p("c2", "character", "MAYA SANTOS"),
    p("c3", "character", "ELI"), p("c4", "character", "RUTH (O.S.)"));
  const cast = castSuggestions(s, 0);
  assert.deepEqual(cast.map(r => [r.label, r.paragraphId, r.quote, r.source]), [
    ["MAYA SANTOS", "a", "MAYA SANTOS", "script"], ["ELI", "a", "Eli", "script"], ["RUTH", "c4", "RUTH", "script"],
  ]);
  assert.equal(cast[0]!.start, 39);
  assert.equal(cast[2]!.end, 4);
  assert.deepEqual(castSuggestions(s, 5), []);
  assert.deepEqual(castSuggestions(s, 0), cast, "IDs are stable for a pure function");
});

test("cast stays in its scene, prefers the full name at the same offset, and excludes notes and tagged spans", () => {
  const s = script(p("a", "action", "Maya Santos enters."), p("c", "character", "MAYA SANTOS"),
    p("h2", "sceneHeading", "EXT. ROAD - NIGHT"), p("a2", "action", "Maya waits."), p("c2", "character", "RUTH"));
  assert.equal(castSuggestions(s, 0)[0]!.quote, "Maya Santos");
  assert.equal(castSuggestions(s, 1)[0]!.quote, "RUTH");
  s.paragraphs[1]!.runs = [{ text: "Maya Santos", note: true }, { text: " enters." }];
  assert.equal(castSuggestions(s, 0)[0]!.paragraphId, "c");
  s.paragraphs[2]!.runs[0]!.fdx = { TagNumber: "1" };
  assert.deepEqual(castSuggestions(s, 0), []);
});

test("locate normalizes quotes, dashes and spaces while returning original plain-text offsets", () => {
  const s = script(p("a", "action", 'She lifts Ruth’s “arm—cast” beside a\u00a0car.'));
  const span = locateElement(s, 0, 'RUTH\'S "arm-cast"');
  assert.deepEqual(span, { paragraphId: "a", start: 10, end: 27 });
  assert.deepEqual(locateElement(s, 0, "a car"), { paragraphId: "a", start: 35, end: 40 });
  assert.deepEqual(locateElement(s, 0, "arm"), { paragraphId: "a", start: 18, end: 21 }, "a dash is a word boundary");
});

test("locate uses action lines only, with whole-word boundaries and scene isolation", () => {
  const s = script(p("c", "character", "CAR"), p("d", "dialogue", "The car."), p("a", "action", "A carpet. A car."),
    p("note", "note", "unicorn"), p("h2", "sceneHeading", "EXT. CAR - DAY"), p("a2", "action", "unicorn"));
  assert.deepEqual(locateElement(s, 0, "car"), { paragraphId: "a", start: 12, end: 15 });
  assert.equal(locateElement(s, 0, "carp"), null);
  assert.equal(locateElement(s, 0, "unicorn"), null);
  s.paragraphs[3]!.runs = [{ text: "Nothing." }];
  assert.equal(locateElement(s, 0, "car"), null, "a car mentioned only in dialogue isn't on set");
  assert.equal(locateElement(s, 0, ""), null);
  assert.equal(locateElement(script(p("a", "action", "écart caré car")), 0, "car")!.start, 11);
});

test("locate skips whole and partial overlaps with notes and tags, including matches across runs", () => {
  const a = p("a", "action", "");
  a.runs = [{ text: "car", note: true }, { text: " car", fdx: { TagNumber: "4" } }, { text: " c" }, { text: "ar" }];
  const s = script(a);
  assert.deepEqual(locateElement(s, 0, "car"), { paragraphId: "a", start: 8, end: 11 });
  a.runs = [{ text: "ar" }, { text: "m", note: true }, { text: " cast" }];
  assert.equal(locateElement(s, 0, "arm cast"), null);
  a.runs[1] = { text: "m", fdx: { TagNumber: "1" } };
  assert.equal(locateElement(s, 0, "arm cast"), null);
});

test("adjacent hidden notes do not become word boundaries or part of cast names", () => {
  const a = p("a", "action", ""), c = p("c", "character", "");
  a.runs = [{ text: "PRIVATE", note: true }, { text: "Maya holds a car" }, { text: "PRIVATE", note: true }];
  c.runs = [{ text: "PRIVATE", note: true }, { text: "MAYA (V.O.)" }];
  const s = script(a, c);
  assert.deepEqual(locateElement(s, 0, "Maya"), { paragraphId: "a", start: 7, end: 11 });
  assert.deepEqual(locateElement(s, 0, "car"), { paragraphId: "a", start: 20, end: 23 });
  assert.equal(castSuggestions(s, 0)[0]!.label, "MAYA");
  assert.equal(castSuggestions(s, 0)[0]!.quote, "Maya");
});

test("normalize validates categories and labels, canonicalizes synonyms and dedupes category plus label", () => {
  const s = script(p("a", "action", "Maya watches extras, smoke, sparks, a wig, coat and car."), p("c", "character", "MAYA"));
  const raw = { elements: [
    { category: "extras", label: "Crowd", text: "extras" }, { category: "Background Actors", label: "CROWD", text: "extras" },
    { category: "SFX", label: "Smoke", text: "smoke" }, { category: "VFX", label: "Sparks", text: "sparks" },
    { category: "Hair/Makeup", label: "Wig", text: "wig" }, { category: "wArDrObE", label: "Coat", text: "coat" },
    { category: "Props", label: "Car", text: "car" }, { category: "Vehicles", label: "Car", text: "car" },
    { category: "Cast Members", label: "Fake", text: "Maya" }, { category: "Unknown", label: "Car", text: "car" },
    { category: "Props", label: "Missing", text: "gun" }, { category: "Props", label: " ", text: "car" },
    { category: "Props", label: "a".repeat(201), text: "car" }, null, { category: "Props", label: 5, text: "car" },
  ] };
  const out = normalizeSuggestions(raw, s, 0);
  assert.deepEqual(out.map(r => r.category), ["Cast Members", "Background Actors", "Special Effects", "Visual Effects", "Makeup/Hair", "Wardrobe", "Props", "Vehicles"]);
  assert.equal(out[0]!.label, "MAYA");
  assert.ok(out.slice(1).every(r => r.source === "model" && r.quote));
  assert.deepEqual(normalizeSuggestions(null, s, 0), castSuggestions(s, 0));
});

test("normalize caps merged results at 30 with script cast first and drops all model cast", () => {
  const s = script(p("a", "action", "Maya holds a car."), p("c", "character", "MAYA"));
  const out = normalizeSuggestions(Array.from({ length: 50 }, (_, n) => ({ category: "Props", label: `Car ${n}`, text: "car" })), s, 0);
  assert.equal(out.length, 30);
  assert.equal(out[0]!.source, "script");
  assert.equal(out.at(-1)!.label, "Car 28");
  assert.deepEqual(normalizeSuggestions([{ category: "Cast Members", label: "Maya double", text: "Maya" }], s, 0), castSuggestions(s, 0));
});

test("a model element without a label is named from its quote", () => {
  const s = script(p("a", "action", "She drops a Messenger bag."));
  const rows = normalizeSuggestions({ elements: [{ category: "Wardrobe", text: "Messenger bag." }, { category: "Props", name: "Bag", text: "bag" }] }, s, 0);
  assert.deepEqual(rows.map(r => [r.category, r.label]), [["Wardrobe", "Messenger bag"], ["Props", "Bag"]]);
});

test("a whole-sentence quote narrows to the element's name when the name is in the scene", () => {
  const s = script(p("a", "action", "Municipal men dump the cans in the back of the garbage truck as it idles."));
  const [row] = normalizeSuggestions({ elements: [{ category: "Vehicles", label: "garbage truck", text: "Municipal men dump the cans in the back of the garbage truck as it idles." }] }, s, 0);
  assert.equal(row!.quote, "garbage truck");
});

test("a character introduced in capitals without speaking is cast too, only when the script has their cue", () => {
  const s: Script = { titlePage: [], paragraphs: [p("h", "sceneHeading", "EXT. RIDGE - DAY"), p("a", "action", "MAYA films. TOMMY MULLEN (18) beside her. A DOG barks. Zara waves."),
    p("c", "character", "MAYA"), p("d", "dialogue", "Rolling."),
    p("h2", "sceneHeading", "EXT. ROAD - DAY"), p("c2", "character", "TOMMY MULLEN"), p("d2", "dialogue", "Hi."), p("c3", "character", "ZARA")] };
  assert.deepEqual(castSuggestions(s, 0).map(r => [r.label, r.quote]), [["MAYA", "MAYA"], ["TOMMY MULLEN", "TOMMY MULLEN"]],
    "DOG has no cue and Zara isn't in capitals");
});

test("a whole-sentence quote whose name isn't in the scene is dropped, not highlighted whole", () => {
  const s = script(p("a", "action", "She takes a pistol out of her bag and waits."));
  assert.deepEqual(normalizeSuggestions({ elements: [{ category: "Props", label: "Service weapon", text: "She takes a pistol out of her bag and waits." }] }, s, 0), []);
});

test("a shared first name never stands for either character, and tagged cast isn't offered again", () => {
  const s: Script = { titlePage: [], paragraphs: [p("h", "sceneHeading", "INT. HALL - DAY"), p("a", "action", "JOHN SMITH enters. JOHN DOE follows. Maya waits."),
    p("c", "character", "JOHN DOE"), p("d", "dialogue", "Hi."), p("c2", "character", "MAYA SANTOS"), p("d2", "dialogue", "Hey."),
    p("h2", "sceneHeading", "INT. ROOM - DAY"), p("c3", "character", "JOHN SMITH"), p("d3", "dialogue", "Hello.")] };
  assert.deepEqual(castSuggestions(s, 0).map(r => [r.label, r.quote]), [["JOHN DOE", "JOHN DOE"], ["MAYA SANTOS", "Maya"], ["JOHN SMITH", "JOHN SMITH"]]);
  // Codex review: once Maya is tagged as cast, her cue mustn't come back as a new suggestion.
  s.paragraphs[1]!.runs = [{ text: "JOHN SMITH enters. JOHN DOE follows. " }, { text: "Maya", fdx: { TagNumber: "1" } }, { text: " waits." }];
  s.fdx = { rootAttrs: [], contentAttrs: [], before: [], after: [{ name: "TagData", attrs: [], children: [
    { name: "TagCategories", attrs: [], children: [{ name: "TagCategory", attrs: [["Id", "cast"], ["Name", "Cast Members"]], children: [] }] },
    { name: "TagDefinitions", attrs: [], children: [{ name: "TagDefinition", attrs: [["Id", "d1"], ["CatId", "cast"], ["Label", "Lead"], ["Number", "1"]], children: [] }] },
  ] }] };
  assert.deepEqual(castSuggestions(s, 0).map(r => r.label), ["JOHN DOE", "JOHN SMITH"]);
  // Sol: bold on part of the tagged name splits it into runs; it still counts as tagged.
  s.paragraphs[1]!.runs = [{ text: "JOHN SMITH enters. JOHN DOE follows. " }, { text: "Ma", bold: true, fdx: { TagNumber: "1" } } as any, { text: "ya", fdx: { TagNumber: "1" } }, { text: " waits." }];
  assert.deepEqual(castSuggestions(s, 0).map(r => r.label), ["JOHN DOE", "JOHN SMITH"]);
});

test("a tagged cue with an extension counts as tagged cast, and one character's cue in two cases isn't a shared first name", () => {
  const tagData = { rootAttrs: [], contentAttrs: [], before: [], after: [{ name: "TagData", attrs: [], children: [
    { name: "TagCategories", attrs: [], children: [{ name: "TagCategory", attrs: [["Id", "cast"], ["Name", "Cast Members"]], children: [] }] },
    { name: "TagDefinitions", attrs: [], children: [{ name: "TagDefinition", attrs: [["Id", "d1"], ["CatId", "cast"], ["Label", "Lead"], ["Number", "1"]], children: [] }] },
  ] }] } as Script["fdx"];
  const tagged: Script = { titlePage: [], fdx: tagData, paragraphs: [p("h", "sceneHeading", "INT. A - DAY"), p("a", "action", "Maya waits."),
    { id: "c", type: "character", runs: [{ text: "MAYA SANTOS (V.O.)", fdx: { TagNumber: "1" } }] }, p("d", "dialogue", "Hi.")] };
  assert.deepEqual(castSuggestions(tagged, 0), []);
  const cased: Script = { titlePage: [], paragraphs: [p("h", "sceneHeading", "INT. A - DAY"), p("a", "action", "Maya waits."),
    p("c", "character", "MAYA SANTOS"), p("d", "dialogue", "Hi."), p("c2", "character", "Maya Santos"), p("d2", "dialogue", "Again.")] };
  assert.deepEqual(castSuggestions(cased, 0).map(r => [r.label, r.quote]), [["MAYA SANTOS", "Maya"]]);
});

test("a cast tag on a line turned into a note covers no one, and tagging JOHN doesn't hide JOHN SMITH", () => {
  const tagData = (label: string) => ({ rootAttrs: [], contentAttrs: [], before: [], after: [{ name: "TagData", attrs: [], children: [
    { name: "TagCategories", attrs: [], children: [{ name: "TagCategory", attrs: [["Id", "cast"], ["Name", "Cast Members"]], children: [] }] },
    { name: "TagDefinitions", attrs: [], children: [{ name: "TagDefinition", attrs: [["Id", "d1"], ["CatId", "cast"], ["Label", label], ["Number", "1"]], children: [] }] },
  ] }] }) as Script["fdx"];
  const noted: Script = { titlePage: [], fdx: tagData("Lead"), paragraphs: [p("h", "sceneHeading", "INT. A - DAY"),
    { id: "n", type: "note", runs: [{ text: "Maya", fdx: { TagNumber: "1" } }] }, p("a", "action", "Maya waits."), p("c", "character", "MAYA SANTOS"), p("d", "dialogue", "Hi.")] };
  assert.deepEqual(castSuggestions(noted, 0).map(r => r.quote), ["Maya"]);
  const johns: Script = { titlePage: [], fdx: tagData("JOHN"), paragraphs: [p("h", "sceneHeading", "INT. A - DAY"), p("a", "action", "JOHN SMITH enters."),
    { id: "c", type: "character", runs: [{ text: "JOHN", fdx: { TagNumber: "1" } }] }, p("d", "dialogue", "Hi."), p("h2", "sceneHeading", "INT. B - DAY"), p("c2", "character", "JOHN SMITH"), p("d2", "dialogue", "Yes.")] };
  assert.deepEqual(castSuggestions(johns, 0).map(r => [r.label, r.quote]), [["JOHN SMITH", "JOHN SMITH"]]);
});
