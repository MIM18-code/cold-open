// Omitted scenes keep everything they remove, locked pages follow their text, and Final Draft's deletion marks
// follow theirs: the reproductions from Sol's round-3 review (#3, #4 and #7).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_REVISIONS, ScreenplayDoc, deletionMarks, importedDeletionMarks, lockPages, moveScene, newRevisionSet, omitScene, omittedParagraphs,
  pageLocks, pageRevisions, paginate, parseFdx, plainText, unomitScene, writeFdx, type Line, type Page, type Paragraph, type Pagination,
} from "../src/index.ts";
import { parseXml } from "../src/xml.ts";
import { canonical, firstDifference } from "./canonical.ts";

const docOf = (paragraphs: Paragraph[]) => ScreenplayDoc.fromScript({ titlePage: [], paragraphs });
const text = (line: Line) => line.runs.map((run) => run.text).join("");
const firstLine = (page: Page) => page.lines.find((line) => !line.generated)!;
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `Sentence ${i + 1} is right here.`).join(" ");
const same = (a: string, b: string) => firstDifference(canonical(parseXml(a)), canonical(parseXml(b)));

test("Omit Scene stops at a section title and keeps the scene's synopsis and notes (Sol round 3, #3)", () => {
  const doc = docOf([
    { id: "h1", type: "sceneHeading", sceneId: "s1", sceneNumber: "1", runs: [{ text: "INT. KITCHEN - DAY" }] },
    { id: "y1", type: "synopsis", runs: [{ text: "card text" }] },
    { id: "a1", type: "action", runs: [{ text: "Nell pours " }, { text: "check this", note: true }, { text: " coffee." }] },
    { id: "act", type: "section", depth: 1, runs: [{ text: "ACT TWO" }] },
    { id: "h2", type: "sceneHeading", sceneId: "s2", sceneNumber: "2", runs: [{ text: "EXT. YARD - DAY" }] },
  ]);
  const original = structuredClone(doc.paragraphs());
  omitScene(doc, "s1");
  assert.deepEqual(doc.paragraphs().map((p) => [p.type, plainText(p.runs)]), [
    ["sceneHeading", "OMITTED"], ["section", "ACT TWO"], ["sceneHeading", "EXT. YARD - DAY"],
  ], "the act title stays in the script");
  const heading = doc.paragraphs()[0]!;
  assert.equal(heading.sceneNumber, "1");
  assert.deepEqual(omittedParagraphs(heading), original.slice(0, 3), "heading, synopsis and action with its note, whole");

  // Final Draft gets its OmittedScene paragraphs, written as Content is: the synopsis is the heading's index card
  // (Summary). What FDX cannot hold (the inline note) is named in the warnings.
  const warnings: string[] = [];
  const xml = writeFdx(doc.toScript(), { warnings });
  assert.match(xml, /<OmittedScene>\s*<Paragraph Type="Scene Heading" Number="1" id="h1">\s*<SceneProperties[^>]*>\s*<Summary>[\s\S]*card text[\s\S]*<\/SceneProperties>\s*<Text>INT\. KITCHEN - DAY<\/Text>\s*<\/Paragraph>\s*<Paragraph Type="Action" id="a1">/);
  assert.doesNotMatch(xml, /x-paragraphs/);
  assert.ok(warnings.some((warning) => warning.includes("check this")));
  assert.ok(!warnings.some((warning) => warning.includes("card text")), "the synopsis is written");
  // A Final Draft OMITTED heading reads its paragraphs back from the FDX.
  const imported = parseFdx(xml).paragraphs.find((p) => p.type === "sceneHeading" && plainText(p.runs) === "OMITTED")!;
  assert.deepEqual(omittedParagraphs(imported).map((p) => [p.id, p.type, plainText(p.runs)]).filter(([, type]) => type !== "synopsis"), [
    ["h1", "sceneHeading", "INT. KITCHEN - DAY"], ["a1", "action", "Nell pours  coffee."],
  ]);
  assert.deepEqual(omittedParagraphs(imported).filter((p) => p.type === "synopsis").map((p) => plainText(p.runs)), ["card text"]);

  // Restore Omitted Scene puts everything back as it was.
  assert.equal(unomitScene(doc, heading.id), true);
  assert.deepEqual(doc.paragraphs(), original);
  assert.equal(unomitScene(doc, "h1"), false, "a live heading has nothing to restore");
});

/** The page with a number, and the text its first line starts with. */
function start(pagination: Pagination, number: string): { paragraphId: string; from: number; text: string } {
  const page = pagination.pages.find((p) => p.number === number);
  assert.ok(page, `page ${number} in ${pagination.pages.map((p) => p.number).join(", ")}`);
  const line = firstLine(page);
  return { paragraphId: line.paragraphId, from: line.from, text: text(line).slice(0, 14) };
}

test("a page locked inside a paragraph keeps starting with its text through edits (Sol round 3, #4)", () => {
  const doc = docOf([
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "a", type: "action", runs: [{ text: numbered(180) }] },
  ]);
  const locks = lockPages(doc, paginate(doc.toScript()));
  assert.ok(locks[1]!.paragraphId === "a" && locks[1]!.offset > 0, "page 2 starts inside the paragraph");
  const page2 = start(paginate(doc.toScript(), { locks: pageLocks(doc)! }), "2").text;
  assert.match(page2, /^Sentence \d+ /);
  const paginated = () => paginate(doc.toScript(), { locks: pageLocks(doc)! });

  // Text inserted before the break: page 2 still starts with the same sentence, and page 1 runs onto 1A.
  const inserted = "Inserted sentence. ".repeat(20);
  doc.insertText("a", 0, inserted);
  let result = paginated();
  assert.equal(start(result, "2").text, page2);
  assert.equal(start(result, "2").from, locks[1]!.offset + inserted.length);
  assert.ok(result.pages.some((page) => page.number === "1A"), "an A-page");

  // Text deleted before it.
  doc.deleteText("a", 0, inserted.length + 40);
  assert.equal(start(paginated(), "2").text, page2);

  // Return before the break moves page 2's text into a new paragraph; Backspace joins it back.
  const second = doc.splitParagraph("a", 200);
  result = paginated();
  assert.deepEqual([start(result, "2").paragraphId, start(result, "2").text], [second, page2]);
  doc.mergeWithPrevious(second);
  assert.equal(start(paginated(), "2").text, page2);

  // FDX export writes where the page starts now.
  const xml = writeFdx(doc.toScript());
  const position = Number([...xml.matchAll(/<LockedPage [^>]*Position="(\d+)"/g)][1]![1]);
  const script = doc.toScript();
  const before = script.paragraphs.slice(0, script.paragraphs.findIndex((p) => p.id === pageLocks(doc)![1]!.paragraphId));
  assert.equal(position, before.reduce((sum, p) => sum + plainText(p.runs).length + 1, 0) + pageLocks(doc)![1]!.offset);
});

test("a locked page whose first characters are deleted starts at a whole word", () => {
  const doc = docOf([
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "a", type: "action", runs: [{ text: numbered(180) }] },
  ]);
  const locks = lockPages(doc, paginate(doc.toScript()));
  const offset = locks[1]!.offset;
  const page2 = () => {
    const line = firstLine(paginate(doc.toScript(), { locks: pageLocks(doc)! }).pages.find((page) => page.number === "2")!);
    const whole = plainText(doc.paragraph(line.paragraphId).runs);
    return { before: whole.slice(0, line.from), text: text(line) };
  };
  // "...is right here. Sentence 106 is right here. Sentence 107..." loses "ght here. Sentence 106 is right here. Se":
  // the page starts with the word "rintence", not with "ntence".
  doc.deleteText("a", offset - 10, 40);
  assert.match(page2().before, /\s$/);
  assert.match(page2().text, /^rintence /);
  // The space before the page's first word deleted: the joined word starts the page whole.
  doc.deleteText("a", 0, offset);
  doc.insertText("a", 0, numbered(100));
  const relocked = lockPages(doc, paginate(doc.toScript()))[1]!;
  doc.deleteText("a", relocked.offset - 1, 1);
  assert.match(page2().before, /(^|\s)$/);
  assert.match(page2().text, /^here\.Sentence /);
  // Every word printed whole, once: the page text is the paragraph text.
  const all = paginate(doc.toScript(), { locks: pageLocks(doc)! }).pages.flatMap((page) => page.lines)
    .filter((line) => line.paragraphId === "a" && !line.generated).map(text).join(" ").replace(/\s+/g, " ");
  assert.equal(all, plainText(doc.paragraph("a").runs).replace(/\s+/g, " "));
});

test("an omitted scene's dual dialogue goes to Final Draft as a dual dialogue block", () => {
  const doc = docOf([
    { id: "h1", type: "sceneHeading", sceneId: "s1", sceneNumber: "1", runs: [{ text: "INT. KITCHEN - DAY" }] },
    { id: "c1", type: "character", runs: [{ text: "NELL" }], dual: { block: "d", side: 1 } },
    { id: "d1", type: "dialogue", runs: [{ text: "Left." }], dual: { block: "d", side: 1 } },
    { id: "c2", type: "character", runs: [{ text: "BOB" }], dual: { block: "d", side: 2 } },
    { id: "d2", type: "dialogue", runs: [{ text: "Right." }], dual: { block: "d", side: 2 } },
    { id: "h2", type: "sceneHeading", sceneId: "s2", sceneNumber: "2", runs: [{ text: "EXT. YARD - DAY" }] },
  ]);
  const original = structuredClone(doc.paragraphs().slice(0, 5));
  omitScene(doc, "s1");
  const xml = writeFdx(doc.toScript());
  assert.match(xml, /<OmittedScene>[\s\S]*<DualDialogue>[\s\S]*id="d2"[\s\S]*<\/DualDialogue>[\s\S]*<\/OmittedScene>/);
  const imported = parseFdx(xml).paragraphs.find((p) => plainText(p.runs) === "OMITTED")!;
  assert.deepEqual(omittedParagraphs(imported).map((p) => [p.id, p.dual?.side]), original.map((p) => [p.id, p.dual?.side]));
});

test("a locked page inside a moved scene stays with the scene", () => {
  const doc = docOf([
    { id: "h1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "a1", type: "action", runs: [{ text: numbered(180) }] },
    { id: "h2", type: "sceneHeading", sceneId: "s2", runs: [{ text: "EXT. YARD - DAY" }] },
    { id: "a2", type: "action", runs: [{ text: "The dog barks." }] },
  ]);
  const locks = lockPages(doc, paginate(doc.toScript()));
  const inside = locks.find((lock) => lock.paragraphId === "a1" && lock.offset > 0)!;
  moveScene(doc, "s2", "s1");
  const moved = pageLocks(doc)!.find((lock) => lock.number === inside.number)!;
  assert.deepEqual([moved.paragraphId, moved.offset], ["a1", inside.offset]);
});

const FDX = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Action" id="A"><Text>abcdefghij</Text></Paragraph>
    <Paragraph Type="Action" id="B"><Text>klmnopqrst</Text></Paragraph>
  </Content>
  <Revisions ActiveSet="1" Location="7.75" RevisionMode="Yes" RevisionsShown="All" ShowPageColor="No">
    <Revision Color="#000000000000" FullRevision="No" ID="1" Mark="*" Name="Blue Rev. (10/01/26)" PageColor="#C6C6EDEDFEFE" Style=""/>
  </Revisions>
  <DeletedText>
    <DeletedTextLocation Offset="16" RevisionID="1"/>
  </DeletedText>
</FinalDraft>
`;

test("Final Draft's deletion marks stay with their text and export where it is now (Sol round 3, #7)", () => {
  const script = parseFdx(FDX);
  assert.deepEqual(deletionMarks(script.paragraphs[1]!), [{ offset: 5, setId: "1" }]);
  assert.equal(importedDeletionMarks(script).size, 0);
  assert.equal(same(writeFdx(script), FDX), undefined, "an untouched file round-trips exactly");

  const doc = ScreenplayDoc.fromScript(script);
  doc.insertText("A", 0, "0123456789");
  const edited = doc.toScript();
  const state = { ...NO_REVISIONS, sets: [newRevisionSet(NO_REVISIONS)] };
  const pagination = paginate(edited);
  const marked = pageRevisions(edited, pagination, state)[0]!.marked.map((index) => pagination.pages[0]!.lines[index]!.paragraphId);
  assert.deepEqual(marked, ["B"], "the mark stays on B");
  assert.match(writeFdx(edited), /<DeletedTextLocation Offset="26" RevisionID="1"\/>/);
});

test("a DeletedText element that cannot be tied to paragraphs exactly is kept as Final Draft wrote it", () => {
  const unsorted = FDX.replace(`<DeletedTextLocation Offset="16" RevisionID="1"/>`,
    `<DeletedTextLocation Offset="16" RevisionID="1"/><DeletedTextLocation Offset="3" RevisionID="1"/>`);
  const script = parseFdx(unsorted);
  assert.deepEqual(script.paragraphs.map((p) => deletionMarks(p).length), [0, 0]);
  assert.deepEqual([...importedDeletionMarks(script).keys()], ["B", "A"]);
  assert.equal(same(writeFdx(script), unsorted), undefined);
});
