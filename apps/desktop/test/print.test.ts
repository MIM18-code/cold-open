// Print, PDF and title page logic, on synthetic scripts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_REVISIONS, ScreenplayDoc, linesPerPage, lockPages, markInserted, newRevisionSet, parseFdx, parseFountain, writeFdx, writeFountain, type Script,
} from "@screenplay/engine";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import { structureOf } from "../src/renderer/features/navigator/structure-model.ts";
import { paginateForPrint, printOptions, readPrintSettings, sharedPagination } from "../src/renderer/features/print/options.ts";
import { drawPages, pageAt, pageBreaks, pageSvg, printDocument } from "../src/renderer/features/print/pages.ts";
import { buildPdf, describeUnprintable, pageList, pdfCharacters, unprintable } from "../src/renderer/features/print/pdf.ts";
import {
  fdxTitlePage, fieldsFromTitlePage, fieldsOf, mergeFields, titleFields, titlePageLines, titlePageNode, valuesOf, withTitlePage,
} from "../src/renderer/features/title-page/titlepage.ts";

const sentences = (count: number) => Array.from({ length: count }, (_, i) => `Sentence ${String(i).padStart(2, "0")} is here.`).join(" ");

function longScript(): Script {
  const paragraphs: Script["paragraphs"] = [];
  for (let scene = 1; scene <= 12; scene++) {
    paragraphs.push({ id: `h${scene}`, type: "sceneHeading", sceneId: `s${scene}`, sceneNumber: String(scene), runs: [{ text: `INT. ROOM ${scene} - DAY` }] });
    paragraphs.push({ id: `a${scene}`, type: "action", runs: [{ text: sentences(6) }] });
    paragraphs.push({ id: `c${scene}`, type: "character", runs: [{ text: "BOB" }] });
    paragraphs.push({ id: `d${scene}`, type: "dialogue", runs: [{ text: "Plain " }, { text: "bold", bold: true }, { text: " and " }, { text: "underlined", underline: true }, { text: ". " + sentences(5) }] });
  }
  return { titlePage: [{ key: "Title", values: ["Synthetic"] }, { key: "Author", values: ["A. Writer"] }], paragraphs };
}

test("printing settings default sensibly and feed pagination", () => {
  const defaults = readPrintSettings({});
  assert.deepEqual(defaults, {
    sceneNumbers: "both", header: "", titlePage: true, paper: "letter", revisionMarks: true, revisionColors: false,
  });
  // Revised pages only is chosen per printout in the preview; a stored value from an older version is ignored.
  assert.equal("revisedOnly" in readPrintSettings({ "print.revisedOnly": true }), false);
  const custom = readPrintSettings({ "print.sceneNumbers": "left", "print.autoContinueds": false, "print.paper": "a4", "print.titlePage": false });
  assert.equal(custom.sceneNumbers, "left");
  assert.equal(custom.autoContinueds, false);
  const options = printOptions(longScript(), custom);
  assert.equal(options.autoContinueds, false);
  assert.equal(options.page?.height, 11.69);
  assert.equal(linesPerPage(paginateForPrint(longScript(), custom).layout.page), 58, "A4 holds four more lines");
  assert.equal(linesPerPage(paginateForPrint(longScript(), defaults).layout.page), 54);
});

test("pages carry numbers from page 2, scene numbers in both margins and the header text", () => {
  const script = longScript();
  const pagination = paginateForPrint(script, readPrintSettings({}));
  assert.ok(pagination.pages.length >= 3);
  const drawings = drawPages(script, pagination, { sceneNumbers: "both", header: "Blue Revision", titlePage: null });
  assert.equal(drawings.length, pagination.pages.length);
  const texts = (index: number) => drawings[index]!.items.map((item) => item.text);
  assert.ok(!texts(0).includes("1."), "page 1 is not numbered");
  const number = drawings[1]!.items.find((item) => item.text === "2.")!;
  assert.ok(number, "page 2 is numbered");
  assert.ok(Math.abs(number.y - (36 + 9.5)) < 1e-6, "on the header line, half an inch down");
  assert.ok(texts(1).includes("Blue Revision"));
  const heading = drawings[0]!.items.find((item) => item.text === "INT. ROOM 1 - DAY")!;
  const scene = drawings[0]!.items.filter((item) => item.text === "1" && item.y === heading.y);
  assert.equal(scene.length, 2);
  assert.ok(scene[0]!.x < heading.x && scene[1]!.x > heading.x);
  const leftOnly = drawPages(script, pagination, { sceneNumbers: "none", header: "", titlePage: null });
  assert.ok(!leftOnly[0]!.items.some((item) => item.text === "1" && item.y === heading.y));
  const bold = drawings.flatMap((d) => d.items).find((item) => item.text === "bold")!;
  assert.equal(bold.bold, true);
  assert.equal(drawings.flatMap((d) => d.items).find((item) => item.text === "underlined")!.underline, true);
});

test("revised pages: marks on revised lines, the set in the header, paper color, revised pages only, A-pages", async () => {
  const doc = ScreenplayDoc.fromScript(longScript());
  const blue = newRevisionSet(NO_REVISIONS, { date: "10/30/26" });
  const state = { ...NO_REVISIONS, sets: [blue], currentSetId: blue.id, tracking: true };
  const settings = readPrintSettings({});
  const locks = lockPages(doc, paginateForPrint(doc.toScript(), settings));
  // A long revised passage on page 2 flows onto 2A.
  const added = `${sentences(60)} `;
  doc.insertText("a5", 0, added);
  markInserted(doc, doc.range("a5").start, added, blue.id);
  const script = doc.toScript();
  const pagination = paginateForPrint(script, settings, locks);
  const numbers = pagination.pages.map((page) => page.number);
  assert.deepEqual(numbers.filter((n) => !/[A-Z]$/.test(n)), locks.map((lock) => lock.number), "every locked page keeps its number");
  assert.equal(numbers[numbers.indexOf("2") + 1], "2A");
  const revisions = { state, marks: true, colors: true, revisedOnly: false };
  const drawings = drawPages(script, pagination, { sceneNumbers: "both", header: "", titlePage: null, revisions });
  const page2a = drawings.find((drawing) => drawing.key === "2A")!;
  assert.ok(page2a.revised);
  assert.equal(page2a.background, "#C6EDFE");
  const label = page2a.items.find((item) => item.text === "Blue Rev. 10/30/26")!;
  const number = page2a.items.find((item) => item.text === "2A.")!;
  assert.ok(label && number && label.y === number.y && label.x < number.x, "the set's name and date sit left of the page number");
  // 2A holds text that only moved there: new paper with page 2's revision, but no marks.
  assert.ok(!page2a.items.some((item) => item.text === "*"));
  const marks = drawings.find((drawing) => drawing.key === "2")!.items.filter((item) => item.text === "*");
  assert.ok(marks.length > 10);
  assert.ok(marks.every((item) => Math.abs(item.x - 7.75 * 72) < 1e-6), "marks at Final Draft's 7.75 inch column");
  const unrevised = drawings.find((drawing) => !drawing.revised)!;
  assert.equal(unrevised.background, undefined);
  assert.ok(!unrevised.items.some((item) => item.text === "*" || item.text.startsWith("Blue Rev.")));
  // Marks off, colors off, and only revised pages, which drops the title page too.
  const only = drawPages(script, pagination, { sceneNumbers: "both", header: "", titlePage: [], revisions: { ...revisions, marks: false, colors: false, revisedOnly: true } });
  assert.deepEqual(only.map((d) => d.key), drawings.filter((d) => d.revised).map((d) => d.key));
  assert.ok(only.every((d) => !d.background && !d.items.some((item) => item.text === "*")));
  assert.match(pageSvg(page2a, pagination.layout.page), /<rect width="612" height="792" fill="#C6EDFE"\/>/);
  const pdf = await PDFDocument.load(await buildPdf(only, pagination.layout.page, { title: "Revised" }));
  assert.equal(pdf.getPageCount(), only.length);
});

test("page breaks for the editor and the caret's page", () => {
  const script = longScript();
  const pagination = paginateForPrint(script, readPrintSettings({}));
  const breaks = pageBreaks(pagination);
  assert.equal(breaks.length, pagination.pages.length - 1);
  assert.deepEqual(breaks.map((b) => b.pageNumber), pagination.pages.slice(1).map((p) => p.number));
  for (const pageBreak of breaks) {
    const page = pagination.pages[Number(pageBreak.pageNumber) - 1]!;
    const first = page.lines.find((line) => !line.generated)!;
    assert.equal(pageBreak.paragraphId, first.paragraphId);
    assert.equal(pageBreak.offset, first.from);
    if (pageBreak.contd) assert.equal(pageBreak.contd, "BOB (CONT'D)");
  }
  const split = breaks.find((b) => b.offset > 0);
  if (split) {
    const index = Number(split.pageNumber) - 1;
    assert.equal(pageAt(pagination, split.paragraphId, split.offset), index);
    assert.equal(pageAt(pagination, split.paragraphId, 0), index - 1);
  }
  assert.equal(pageAt(pagination, "missing"), -1);
});

test("PDF export: one page per sheet plus the title page, at Letter size", async () => {
  const script = longScript();
  const pagination = paginateForPrint(script, readPrintSettings({}));
  const titlePage = titlePageLines(script, pagination.layout.page);
  const drawings = drawPages(script, pagination, { sceneNumbers: "both", header: "", titlePage });
  const bytes = await buildPdf(drawings, pagination.layout.page, { title: "Synthetic", author: "A. Writer" });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), pagination.pages.length + 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 612, height: 792 });
  assert.equal(pdf.getTitle(), "Synthetic");
  // Characters the standard fonts cannot encode print as "?" instead of failing the export.
  const odd = await buildPdf([{ key: "1", items: [{ text: "Emoji 🎬 and 日本", x: 72, y: 100 }] }], pagination.layout.page, { title: "x" });
  assert.ok(odd.length > 0);
});

test("SVG pages and the print document", () => {
  const script = longScript();
  const pagination = paginateForPrint(script, readPrintSettings({}));
  const drawings = drawPages(script, pagination, { sceneNumbers: "both", header: "<Draft & co>", titlePage: null });
  const svg = pageSvg(drawings[1]!, pagination.layout.page);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 612 792"/);
  assert.match(svg, /&lt;Draft &amp; co&gt;/);
  assert.match(svg, /letter-spacing="-0\.17/);
  const html = printDocument(drawings, pagination.layout.page, "A <title>");
  assert.match(html, /@page \{ size: 8\.5in 11in; margin: 0; \}/);
  assert.equal(html.match(/class="page"/g)!.length, drawings.length);
  assert.match(html, /<title>A &lt;title&gt;<\/title>/);
});

test("title page fields round trip through the dialog values, Fountain and FDX", () => {
  const values = { Title: "The Synthetic", Credit: "Written by", Author: "A. Writer\nB. Writer", Source: "", "Draft date": "October 30, 2026", Contact: "Agent\n555 0100", Copyright: "" };
  const fields = fieldsOf(values);
  assert.deepEqual(fields.map((field) => field.key), ["Title", "Credit", "Author", "Draft date", "Contact"]);
  assert.deepEqual(valuesOf(fields).Author, "A. Writer\nB. Writer");

  const script: Script = { titlePage: fields, paragraphs: [{ id: "p1", type: "action", runs: [{ text: "Hello." }] }] };
  const fountain = parseFountain(writeFountain(script));
  assert.deepEqual(valuesOf(fountain.titlePage), valuesOf(fields));

  // A script that came from Final Draft: the edit rewrites its TitlePage XML, which FDX export writes.
  const fdx = `<?xml version="1.0" encoding="UTF-8"?><FinalDraft DocumentType="Script" Template="No" Version="6"><Content>`
    + `<Paragraph Type="Action"><Text>Hello.</Text></Paragraph></Content>`
    + `<TitlePage><HeaderAndFooter HeaderVisible="No"/><Content><Paragraph Alignment="Center"><Text>OLD TITLE</Text></Paragraph></Content></TitlePage></FinalDraft>`;
  const imported = parseFdx(fdx);
  assert.deepEqual(valuesOf(titleFields(imported)).Title, "OLD TITLE");
  const doc = ScreenplayDoc.fromScript(imported);
  doc.ydoc.transact(() => {
    doc.meta.set("titlePage", fields);
    doc.meta.set("fdx", withTitlePage(doc.meta.get("fdx") as NonNullable<Script["fdx"]>, fields));
  });
  const written = writeFdx(doc.toScript());
  assert.doesNotMatch(written, /OLD TITLE/);
  assert.match(written, /<HeaderAndFooter HeaderVisible="No"\/>/, "the TitlePage's other settings stay");
  const reread = parseFdx(written);
  const back = valuesOf(fieldsFromTitlePage(fdxTitlePage(reread)!));
  assert.equal(back.Title, "THE SYNTHETIC");
  assert.equal(back.Credit, "Written by");
  assert.equal(back.Author, "A. Writer\nB. Writer");
  assert.equal(back["Draft date"], "October 30, 2026");
  assert.equal(back.Contact, "Agent\n555 0100");
  // Removing every field removes the title page.
  assert.equal(fdxTitlePage({ fdx: withTitlePage(reread.fdx!, []) }), undefined);
});

test("the generated title page follows the standard layout", () => {
  const fields = fieldsOf({ Title: "Synthetic", Credit: "Written by", Author: "A. Writer", Source: "Based on a story", "Draft date": "Draft 3", Contact: "Agent\nPhone", Copyright: "" });
  const lines = titlePageLines({ titlePage: fields })!;
  const find = (text: string) => lines.find((line) => line.runs.map((run) => run.text).join("") === text)!;
  const title = find("SYNTHETIC"), author = find("A. Writer"), contact = find("Agent"), phone = find("Phone"), date = find("Draft 3");
  assert.ok(title.y >= 15 && title.y <= 20, "about a third of the way down");
  assert.ok(Math.abs(title.x + "SYNTHETIC".length / 2 / 10.2527 - 4.25) < 0.01, "centered on the page");
  assert.ok(author.y > title.y && find("Based on a story").y > author.y);
  assert.equal(contact.x, 1);
  assert.equal(phone.y, 52);
  assert.equal(date.y, 53);
  assert.ok(date.x > 6, "draft date at the bottom right");
  assert.equal(titlePageNode(fields).children.length, 1);
  assert.equal(titlePageLines({ titlePage: [] }), null);
});

test("reads the fields of a Final Draft style title page", () => {
  const paragraph = (text: string, alignment: string) => `<Paragraph Alignment="${alignment}"><Text>${text}</Text></Paragraph>`;
  const blank = (count: number) => Array.from({ length: count }, () => paragraph("", "Left")).join("");
  const xml = `<FinalDraft DocumentType="Script" Template="No" Version="6"><Content><Paragraph Type="Action"><Text>x</Text></Paragraph></Content><TitlePage><Content>`
    + blank(15) + paragraph("BIG TITLE", "Center") + blank(1) + paragraph("written by", "Center") + blank(1) + paragraph("Some Writer", "Center")
    + blank(2) + paragraph("Based on the book", "Center") + blank(20) + paragraph("Copyright 2026", "Left") + paragraph("Agency Name", "Left")
    + paragraph("agent@example.com", "Left") + paragraph("Revised Draft 2026", "Right") + `</Content></TitlePage></FinalDraft>`;
  const values = valuesOf(fieldsFromTitlePage(fdxTitlePage(parseFdx(xml))!));
  assert.deepEqual(values, {
    Title: "BIG TITLE", Credit: "written by", Author: "Some Writer", Source: "Based on the book",
    "Draft date": "Revised Draft 2026", Contact: "Agency Name\nagent@example.com", Copyright: "Copyright 2026",
  });
  // Printing uses Final Draft's own lines.
  const lines = titlePageLines(parseFdx(xml))!;
  assert.equal(lines.find((line) => line.runs[0]!.text === "BIG TITLE")!.y, 15);
});

test("saving the dialog keeps fields it does not show and the keys they were stored under", () => {
  const original = [
    { key: "Title", values: ["Old"] }, { key: "Authors", values: ["A. Writer"] }, { key: "Revision", values: ["Blue"] },
    { key: "Notes", values: ["Note one"] }, { key: "Format", values: ["Short"] },
  ];
  const values = { ...valuesOf(original), Title: "New", Copyright: "", "Draft date": "Draft 2" };
  assert.deepEqual(mergeFields(original, values), [
    { key: "Title", values: ["New"] }, { key: "Authors", values: ["A. Writer"] }, { key: "Revision", values: ["Blue"] },
    { key: "Format", values: ["Short"] }, { key: "Draft date", values: ["Draft 2"] },
  ]);
  const fountain = parseFountain(writeFountain({ titlePage: mergeFields(original, values), paragraphs: [] }));
  assert.deepEqual(fountain.titlePage.find((field) => field.key === "Revision")?.values, ["Blue"]);
});

test("a generated title page without a credit line reads back with the authors apart from the title", () => {
  const fields = fieldsOf({ Title: "Synthetic", Author: "A. Writer" });
  const values = valuesOf(fieldsFromTitlePage(titlePageNode(fields)));
  assert.equal(values.Title, "SYNTHETIC");
  assert.equal(values.Author, "A. Writer");
});

/** Scene 2 starts on line 28: page 2 on US Letter (54 lines), still page 1 on A4 (58 lines). */
function paperScript(): Script {
  const paragraphs: Script["paragraphs"] = [{ id: "h1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. ONE - DAY" }] }];
  for (let i = 0; i < 26; i++) paragraphs.push({ id: `a${i}`, type: "action", runs: [{ text: `Line ${i}.` }] });
  paragraphs.push({ id: "h2", type: "sceneHeading", sceneId: "s2", runs: [{ text: "INT. TWO - DAY" }] });
  paragraphs.push({ id: "b", type: "action", runs: [{ text: "End." }] });
  return { titlePage: [], paragraphs };
}

test("the views share one pagination per script and printing settings, with the paper and locks applied", () => {
  const script = paperScript();
  const a4 = readPrintSettings({ "print.paper": "a4" });
  const letter = readPrintSettings({});
  let reads = 0;
  const noLocks = () => (reads++, null);
  const shared = sharedPagination(script, a4, noLocks);
  assert.equal(sharedPagination(script, a4, noLocks), shared, "the same object for the same script and settings");
  assert.equal(sharedPagination(script, readPrintSettings({ "print.paper": "a4", "print.header": "Blue" }), noLocks), shared,
    "settings that don't move page breaks share it");
  assert.equal(reads, 1, "locks are read only when paginating");
  // Print puts scene 2 on page 1 of A4; the navigator, cards, outline and reports must say so too.
  assert.equal(paginateForPrint(script, a4).positions.get("h2")!.page, 0);
  assert.equal(structureOf(script, shared).summaries[1]!.page, "1");
  assert.equal(structureOf(script).summaries[1]!.page, "2", "the default layout is US Letter");
  const onLetter = sharedPagination(script, letter, noLocks);
  assert.notEqual(onLetter, shared);
  assert.equal(structureOf(script, onLetter).summaries[1]!.page, "2");
  // Locked pages keep their numbers in the shared pagination too.
  const doc = ScreenplayDoc.fromScript(longScript());
  const locks = lockPages(doc, paginateForPrint(doc.toScript(), letter));
  doc.insertText("a5", 0, `${sentences(60)} `);
  const numbers = sharedPagination(doc.toScript(), letter, () => locks).pages.map((page) => page.number);
  assert.ok(numbers.includes("2A"));
});

test("PDF export finds characters the built-in Courier can't print, and where they are", async () => {
  const script: Script = { titlePage: [{ key: "Title", values: ["Ωmega"] }], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "a", type: "action", runs: [{ text: "Hello 李. Café, “quotes” and — dashes print. Ж and 李 again." }] },
  ] };
  const pagination = paginateForPrint(script, readPrintSettings({}));
  const drawings = drawPages(script, pagination, { sceneNumbers: "both", header: "", titlePage: titlePageLines(script, pagination.layout.page) });
  const missing = unprintable(drawings, await pdfCharacters());
  assert.deepEqual(missing.map((entry) => [entry.char, entry.pages]), [["Ω", ["title"]], ["李", ["1"]], ["Ж", ["1"]]]);
  assert.equal(describeUnprintable(missing), "Ω (the title page), 李 (page 1) and Ж (page 1)");
  assert.equal(pageList(["title", "2", "3", "5", "8", "9"]), "the title page and pages 2, 3, 5 and 2 more");
  assert.deepEqual(unprintable(drawings.slice(0, 0), await pdfCharacters()), []);
});

test("PDF export joins an accent typed as two characters, and names an invisible character by its code", async () => {
  // "e" followed by a combining acute accent, as text pasted from some Mac apps arrives, and a zero-width space.
  const script: Script = { titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "a", type: "action", runs: [{ text: "Cafe\u0301 au lait.\u200B" }] },
  ] };
  const pagination = paginateForPrint(script, readPrintSettings({}));
  const drawings = drawPages(script, pagination, { sceneNumbers: "none", header: "", titlePage: null });
  const missing = unprintable(drawings, await pdfCharacters());
  assert.deepEqual(missing.map((entry) => entry.char), ["\u200B"], "the accent joins its letter as é, which Courier has");
  assert.equal(describeUnprintable(missing), "U+200B, an invisible character (page 1)");
  const pdf = await PDFDocument.load(await buildPdf(drawings, pagination.layout.page, { title: "Cafe" }));
  const drawn = pdf.context.enumerateIndirectObjects().map(([, object]) => object)
    .filter((object): object is PDFRawStream => object instanceof PDFRawStream)
    .map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n").toUpperCase();
  assert.ok(drawn.includes("<436166E9"), "Café is drawn with WinAnsi é, not as Cafe?");
});

test("right-to-left paragraphs print as one bidi line from their margin", async () => {
  const { rightToLeft, drawPages, pageSvg } = await import("../src/renderer/features/print/pages.ts");
  const { paginate } = await import("@screenplay/engine");
  type Script = import("@screenplay/engine").Script;
  assert.equal(rightToLeft("שלום עולם?"), true);
  assert.equal(rightToLeft("? שלום"), true);
  assert.equal(rightToLeft("She says שלום"), false);
  assert.equal(rightToLeft("مرحبا"), true);
  assert.equal(rightToLeft("123 ..."), false);
  assert.equal(rightToLeft("١ English"), false);
  assert.equal(rightToLeft("، English"), false);
  assert.equal(rightToLeft("ქართული שלום"), false);
  assert.equal(rightToLeft("ـمرحبا عالم"), true);
  assert.equal(rightToLeft("\u200F123 abc"), true);
  assert.equal(rightToLeft("\u200Eשלום"), false);
  assert.equal(rightToLeft("Ⅻ שלום"), false);
  const noted = { titlePage: [], paragraphs: [{ id: "a", type: "action" as const, runs: [{ text: "שלום", note: true as const }, { text: "Hello ", bold: true }, { text: "world" }] }] } as Script;
  const [plain] = drawPages(noted, paginate(noted), { titlePage: null, sceneNumbers: "none", header: "" } as any);
  assert.equal(plain!.items.some((item) => item.rtl), false);
  const script = { titlePage: [], paragraphs: [
    { id: "c", type: "character" as const, runs: [{ text: "RIVKA" }] },
    { id: "d", type: "dialogue" as const, runs: [{ text: "אמרתי " }, { text: "לא", bold: true }, { text: "?" }] },
  ] } as Script;
  const pagination = paginate(script);
  const [drawing] = drawPages(script, pagination, { titlePage: null, sceneNumbers: "none", header: "" } as any);
  const line = drawing!.items.find((item) => item.text.includes("אמרתי"))!;
  assert.deepEqual(line.rtl?.map((run) => [run.text, !!run.bold]), [["אמרתי ", false], ["לא", true], ["?", false]]);
  assert.match(pageSvg(drawing!, pagination.layout.page), /direction="rtl"[^>]*text-anchor="end">.*<tspan font-weight="bold">לא<\/tspan>/);
});
