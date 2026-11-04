import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { launch as launchApp, runCommand } from "./helpers.ts";

type Row = [string, string];

const SCRIPT: Row[] = [
  ["sceneHeading", "EXT. SALVAGE YARD - DAWN"],
  ["action", "NELL (40s) kicks the tire. VERN (60) watches from the shed."],
  ["character", "NELL"],
  ["dialogue", "You and me had a deal."],
  ["character", "VERN (V.O.)"],
  ["dialogue", "Nobody asked you, Nell."],
  ["sceneHeading", "INT. SHED - DAY"],
  ["action", "Vern sets down a mug."],
  ["character", "VERN"],
  ["dialogue", "Gone."],
  ["sceneHeading", "INT. GARAGE - NIGHT"],
  ["action", "Boxes everywhere."],
];

// Every test closes its app, pass or fail, so a failure never leaves a window process behind. The document is marked
// saved first, or closing would wait on the "Save changes?" box.
let running: { electronApp: ElectronApplication; page: Page } | undefined;
async function launch() {
  const app = await launchApp();
  running = app;
  return app;
}
test.afterEach(async () => {
  await running?.page.evaluate(() => void ((window as any).__app.session.dirty = false)).catch(() => undefined);
  await running?.electronApp.close().catch(() => undefined);
  running = undefined;
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "screenplay-reports-"));
}

/** Replace the open document with these paragraphs, with IDs p0, p1 and so on, and an empty undo stack. */
async function load(page: Page, rows: Row[]): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({
      titlePage: [],
      paragraphs: list.map(([type, text]: Row, i: number) => ({ id: `p${i}`, type, runs: [{ text }] })),
    }));
    app.session.undo.clear();
  }, rows);
}

const texts = (page: Page) => page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join("")));

/** Make the native file dialogs answer without showing anything. */
async function stubDialogs(electronApp: ElectronApplication, answers: { save?: string; open?: string }): Promise<void> {
  await electronApp.evaluate(({ dialog }, { save, open }) => {
    dialog.showSaveDialog = (async () => (save ? { canceled: false, filePath: save } : { canceled: true })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => (open ? { canceled: false, filePaths: [open] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  }, answers);
}

/** An editor that records what features ask of it. */
async function stubEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const calls: unknown[][] = [];
    (window as any).__calls = calls;
    const noop = () => undefined;
    (window as any).__app.setEditor({
      focus: noop, getSelection: () => null, setSelection: noop, currentParagraphId: () => null, currentElementType: () => null,
      setElementType: noop, toggleMark: noop, activeMarks: () => ({}), insertParagraphs: () => [], replaceText: noop, setRemoteCursors: noop, setPageBreaks: noop,
      onSelectionChange: () => noop,
      onPlainTextPaste: () => noop,
      revealParagraph: (id: string, options: unknown) => calls.push(["reveal", id, options]),
      setDecorations: (source: string, decorations: unknown[]) => calls.push(["decorations", source, decorations]),
    });
  });
}

const calls = (page: Page) => page.evaluate(() => (window as any).__calls as unknown[][]);

test("reports: tables, sorting, CSV export and revealing a row", async () => {
  const { electronApp, page } = await launch();
  await load(page, SCRIPT);
  await stubEditor(page);
  await runCommand(page, "reports.open");
  const dialog = page.getByRole("dialog", { name: "Reports" });
  await expect(dialog).toBeVisible();

  // Characters: NELL speaks once, VERN twice. Both are named in the opening action, so they start in scene 1.
  const rows = dialog.locator("table.reports-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("NELL");
  await dialog.getByRole("button", { name: "Speeches" }).click();
  await expect(rows.nth(0)).toContainText("VERN");
  await expect(rows.nth(0).locator("td").nth(1)).toHaveText("2");
  await dialog.getByRole("button", { name: "Speeches" }).click();
  await dialog.getByRole("button", { name: "Speeches" }).click();
  await expect(rows.nth(0)).toContainText("NELL");

  await dialog.getByRole("tab", { name: "Scenes" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("INT. SHED - DAY");
  await expect(rows.nth(1)).toContainText("DAY");
  await dialog.getByRole("tab", { name: "Locations" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("GARAGE");
  await dialog.getByRole("tab", { name: "Statistics" }).click();
  await expect(dialog).toContainText("Dialogue share");
  await expect(dialog).toContainText("Scene headings");

  // CSV through the save dialog.
  const csv = join(tempDir(), "characters.csv");
  await stubDialogs(electronApp, { save: csv });
  await dialog.getByRole("tab", { name: "Characters" }).click();
  await dialog.getByRole("button", { name: "Export CSV…" }).click();
  await expect.poll(() => existsSync(csv)).toBe(true);
  const text = readFileSync(csv, "utf8");
  expect(text.startsWith("﻿Character,Speeches,Dialogue words,Scenes")).toBe(true);
  expect(text).toContain("NELL,1,");
  expect(text).toContain("VERN,2,");

  // Clicking a row reveals its first appearance and closes the dialog.
  await rows.nth(0).click();
  await expect(dialog).toBeHidden();
  // Other features (proofreading) also draw through the editor, so look at the reveals only.
  expect((await calls(page)).filter((c) => c[0] === "reveal")).toEqual([["reveal", "p1", { select: true }]]);
});

test("rename: previews the change, applies it as one undoable edit and keeps the document", async () => {
  const { electronApp, page } = await launch();
  await load(page, SCRIPT);
  const sessionId = await page.evaluate(() => (window as any).__app.session.id);
  await runCommand(page, "rename.open");
  const dialog = page.getByRole("dialog", { name: "Rename Character" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("option", { name: /^VERN/ }).click();
  await dialog.getByLabel("New name").fill("Bo");
  await expect(dialog.locator(".rename-preview")).toContainText("2 cues and 2 mentions in 4 paragraphs");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();

  const after = await texts(page);
  expect(after).toEqual([
    "EXT. SALVAGE YARD - DAWN",
    "NELL (40s) kicks the tire. BO (60) watches from the shed.",
    "NELL",
    "You and me had a deal.",
    "BO (V.O.)",
    "Nobody asked you, Nell.",
    "INT. SHED - DAY",
    "Bo sets down a mug.",
    "BO",
    "Gone.",
    "INT. GARAGE - NIGHT",
    "Boxes everywhere.",
  ]);
  expect(await page.evaluate(() => (window as any).__app.session.id)).toBe(sessionId);

  // One undo puts every change back.
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await texts(page)).toEqual(SCRIPT.map(([, text]) => text));
});

test("compare: summary, grouped diff, both layouts, editor highlights and clearing them", async () => {
  const { electronApp, page } = await launch();
  const earlier = join(tempDir(), "earlier.fountain");
  writeFileSync(earlier, [
    "EXT. SALVAGE YARD - DAWN", "", "NELL (40s) kicks the tire. VERN (60) watches from the shed.", "", "NELL", "You and me had a bargain.", "",
    "VERN (V.O.)", "Nobody asked you, Nell.", "", "INT. SHED - DAY", "", "Vern sets down a mug.", "", "VERN", "Gone.", "",
    "INT. ATTIC - DAY", "", "Dust.", "",
  ].join("\n"));
  await load(page, SCRIPT);
  await stubEditor(page);
  await stubDialogs(electronApp, { open: earlier });
  await runCommand(page, "compare.open");
  const dialog = page.getByRole("dialog", { name: "Compare Drafts" });
  await dialog.getByRole("button", { name: "Choose earlier draft…" }).click();

  await expect(dialog.locator(".compare-summary")).toContainText("1 added");
  await expect(dialog.locator(".compare-summary")).toContainText("1 omitted");
  await expect(dialog.locator(".compare-summary")).toContainText("1 changed");
  // The edited line shows the word that changed, inline.
  const edited = dialog.locator('.compare-row[data-kind="changed"]');
  await expect(edited).toHaveCount(1);
  await expect(edited.locator("del")).toHaveText("bargain");
  await expect(edited.locator("ins")).toHaveText("deal");
  await expect(dialog.locator(".compare-scene-head", { hasText: "INT. ATTIC - DAY" })).toContainText("Omitted");
  await expect(dialog.locator(".compare-scene-head", { hasText: "INT. GARAGE - NIGHT" })).toContainText("Added");

  await dialog.getByRole("button", { name: "Side by side" }).click();
  const side = dialog.locator('.compare-row.side[data-kind="changed"]');
  await expect(side.locator(".compare-text").nth(0).locator("del")).toHaveText("bargain");
  await expect(side.locator(".compare-text").nth(1).locator("ins")).toHaveText("deal");

  // Highlights: the revised script's changed words and added paragraphs, drawn through the editor.
  await dialog.getByRole("button", { name: "Highlight in script" }).click();
  await expect(dialog).toBeHidden();
  const drawn = (await calls(page)).filter((c) => c[0] === "decorations" && c[1] === "compare");
  expect(drawn).toHaveLength(1);
  const decorations = drawn[0]![2] as { paragraphId: string; from?: number; to?: number; className: string }[];
  expect(decorations).toContainEqual({ paragraphId: "p3", from: 17, to: 21, className: "compare-changed", title: "Changed" });
  expect(decorations).toContainEqual({ paragraphId: "p10", className: "compare-added", title: "Added" });
  expect(decorations).toContainEqual({ paragraphId: "p11", className: "compare-added", title: "Added" });
  await runCommand(page, "compare.clear");
  expect((await calls(page)).filter((c) => c[0] === "decorations" && c[1] === "compare").at(-1)).toEqual(["decorations", "compare", []]);

  // Reopening shows the same result without choosing a file again.
  await runCommand(page, "compare.open");
  await expect(dialog.locator(".compare-summary")).toContainText("1 omitted");
});

test("compare: a Final Draft file keeps paragraph IDs, so an edit is one change", async () => {
  const { electronApp, page } = await launch();
  const fixture = fileURLToPath(new URL("../../../packages/engine/test/fixtures/synthetic.fdx", import.meta.url));
  await stubDialogs(electronApp, { open: fixture });
  await runCommand(page, "file.open");
  await expect.poll(() => page.evaluate(() => (window as any).__app.session.script().paragraphs.length)).toBeGreaterThan(5);
  const paragraphId = await page.evaluate(() => {
    const session = (window as any).__app.session;
    const target = session.script().paragraphs.find((p: any) => p.type === "action" && p.runs.length);
    session.edit(() => session.doc.insertText(target.id, 0, "Inserted words. "));
    return target.id as string;
  });
  await runCommand(page, "compare.open");
  const dialog = page.getByRole("dialog", { name: "Compare Drafts" });
  await dialog.getByRole("button", { name: "Choose earlier draft…" }).click();
  await expect(dialog.locator(".compare-summary")).toContainText("1 changed");
  await expect(dialog.locator('.compare-row[data-kind="changed"]')).toHaveCount(1);
  await expect(dialog.locator('.compare-row[data-kind="changed"] ins')).toContainText("Inserted words.");
  expect(paragraphId).toBeTruthy();
});

test("sides: choose scenes and export them as Final Draft and as Fountain", async () => {
  const { electronApp, page } = await launch();
  await load(page, SCRIPT);
  await runCommand(page, "reports.sides");
  const dialog = page.getByRole("dialog", { name: "Export Sides" });
  await expect(dialog.locator(".reports-sides-row")).toHaveCount(3);
  await expect(dialog.getByRole("button", { name: "Export…" })).toBeDisabled();
  await dialog.getByLabel("Scene 1", { exact: true }).check();
  await dialog.getByLabel("Scene 3", { exact: true }).check();
  await expect(dialog).toContainText("2 of 3 scenes selected");

  const fdx = join(tempDir(), "sides.fdx");
  await stubDialogs(electronApp, { save: fdx });
  await dialog.getByRole("button", { name: "Export…" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => existsSync(fdx)).toBe(true);
  const xml = readFileSync(fdx, "utf8");
  expect(xml).toContain("<FinalDraft");
  expect(xml).toContain("SALVAGE YARD");
  expect(xml).toContain("GARAGE");
  expect(xml).not.toContain("SHED - DAY");
  expect(xml).toContain('Number="1"');
  expect(xml).toContain('Number="3"');

  await runCommand(page, "reports.sides");
  await dialog.getByRole("button", { name: "Select all" }).click();
  await dialog.getByLabel("Scene 2", { exact: true }).uncheck();
  await dialog.getByLabel("Format").selectOption("fountain");
  const fountain = join(tempDir(), "sides.fountain");
  await stubDialogs(electronApp, { save: fountain });
  await dialog.getByRole("button", { name: "Export…" }).click();
  await expect.poll(() => existsSync(fountain)).toBe(true);
  const text = readFileSync(fountain, "utf8");
  expect(text).toContain("EXT. SALVAGE YARD - DAWN #1#");
  expect(text).toContain("INT. GARAGE - NIGHT #3#");
  expect(text).not.toContain("SHED");

  // The open document is untouched.
  expect(await texts(page)).toEqual(SCRIPT.map(([, text]) => text));
});

test("rename: a 3,000 paragraph script renames in one fast, undoable edit, and a titled name is one character", async () => {
  const { page } = await launch();
  const rows: Row[] = [];
  for (let i = 0; i < 750; i++) {
    rows.push(["sceneHeading", `INT. ROOM ${i} - DAY`], ["action", "DR. PARK (50s) frowns at Vern."], ["character", "VERN"], ["dialogue", "Park?"]);
  }
  await load(page, rows);
  const names = await page.evaluate(() => (window as any).__app.session.script().paragraphs.length);
  expect(names).toBe(3000);
  await runCommand(page, "rename.open");
  const dialog = page.getByRole("dialog", { name: "Rename Character" });
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await expect(dialog.getByRole("option", { name: /^DR\. PARK/ })).toBeVisible();
  await dialog.getByRole("option", { name: /^VERN/ }).click();
  await dialog.getByLabel("New name").fill("Bo");
  await expect(dialog.locator(".rename-preview")).toContainText("750 cues and 750 mentions");
  const started = Date.now();
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  expect(Date.now() - started).toBeLessThan(3000);
  const after = await texts(page);
  expect(after[1]).toBe("DR. PARK (50s) frowns at Bo.");
  expect(after[2]).toBe("BO");
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect((await texts(page))[2]).toBe("VERN");
});

test("reports, the navigator and the cards number pages as print does, on A4 paper", async () => {
  const { page } = await launch();
  // Scene 2 starts on line 28: page 2 on US Letter, page 1 on A4.
  const rows: Row[] = [["sceneHeading", "INT. ONE - DAY"], ...Array.from({ length: 26 }, (_, i): Row => ["action", `Line ${i}.`]),
    ["sceneHeading", "INT. TWO - DAY"], ["action", "End."]];
  await load(page, rows);
  await page.evaluate(() => (window as any).__app.setSetting("print.paper", "a4"));
  // Print preview has one page.
  await runCommand(page, "print.print");
  await expect(page.locator(".print-page")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await runCommand(page, "reports.open");
  const dialog = page.getByRole("dialog", { name: "Reports" });
  await dialog.getByRole("tab", { name: "Scenes" }).click();
  const page2 = dialog.locator("table.reports-table tbody tr").nth(1).locator("td").nth(5);
  await expect(page2).toHaveText("1");
  await dialog.getByRole("tab", { name: "Statistics" }).click();
  await expect(dialog.locator("tr", { hasText: /^Pages/ }).locator("td").nth(1)).toHaveText("1");
  await page.keyboard.press("Escape");

  await page.evaluate(() => (window as any).__app.setView("cards"));
  await expect(page.locator(".cards-card").nth(1).locator(".structure-length")).toContainText("p. 1");
  // Back on US Letter, every view moves scene 2 to page 2 together.
  await page.evaluate(() => (window as any).__app.setSetting("print.paper", "letter"));
  await expect(page.locator(".cards-card").nth(1).locator(".structure-length")).toContainText("p. 2");
});

test("compare: edits made while the dialog is open move the highlights with the text", async () => {
  const { electronApp, page } = await launch();
  const earlier = join(tempDir(), "earlier.fountain");
  writeFileSync(earlier, [
    "EXT. SALVAGE YARD - DAWN", "", "NELL (40s) kicks the tire. VERN (60) watches from the shed.", "", "NELL", "You and me had a bargain.", "",
    "VERN (V.O.)", "Nobody asked you, Nell.", "", "INT. SHED - DAY", "", "Vern sets down a mug.", "", "VERN", "Gone.", "",
    "INT. GARAGE - NIGHT", "", "Boxes everywhere.", "",
  ].join("\n"));
  await load(page, SCRIPT);
  await stubEditor(page);
  await stubDialogs(electronApp, { open: earlier });
  await runCommand(page, "compare.open");
  const dialog = page.getByRole("dialog", { name: "Compare Drafts" });
  await dialog.getByRole("button", { name: "Choose earlier draft…" }).click();
  await expect(dialog.locator('.compare-row[data-kind="changed"] ins')).toHaveText("deal");

  // A co-writer adds words before the changed one while the dialog stays open.
  await page.evaluate(() => {
    const doc = (window as any).__app.session.doc;
    doc.ydoc.transact(() => doc.insertText("p3", 0, "Well. "), "remote");
  });
  await expect(dialog.locator('.compare-row[data-kind="changed"] ins').first()).toHaveText(/Well/);
  await dialog.getByRole("button", { name: "Highlight in script" }).click();
  const drawn = (await calls(page)).filter((c) => c[0] === "decorations" && c[1] === "compare");
  const decorations = drawn.at(-1)![2] as { paragraphId: string; from?: number; to?: number }[];
  const text = (await texts(page))[3] as string;
  const marked = decorations.filter((d) => d.paragraphId === "p3").map((d) => text.slice(d.from, d.to));
  expect(marked).toContain("deal");
  expect(marked.join(" ")).not.toContain("had");
});
