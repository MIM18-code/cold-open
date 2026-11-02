import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";

import { close, launch, runCommand } from "./helpers.ts";

// A synthetic script long enough for several pages, with scene numbers and speeches that break across pages.
function paragraphs(scenes: number) {
  const sentences = (count: number) => Array.from({ length: count }, (_, i) => `Sentence ${i} is right here.`).join(" ");
  const out: unknown[] = [];
  for (let scene = 1; scene <= scenes; scene++) {
    out.push({ id: `h${scene}`, type: "sceneHeading", sceneId: `h${scene}`, sceneNumber: String(scene), runs: [{ text: `INT. ROOM ${scene} - DAY` }] });
    out.push({ id: `a${scene}`, type: "action", runs: [{ text: sentences(5) }] });
    out.push({ id: `c${scene}`, type: "character", runs: [{ text: "ANNA" }] });
    out.push({ id: `d${scene}`, type: "dialogue", runs: [{ text: sentences(scene === 2 ? 60 : 9) }] });
  }
  return out;
}

/** Load a script into the open document; the script editor draws it. */
async function loadScript(page: Page, scenes: number): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: list }));
  }, paragraphs(scenes));
}

/** The page count the status bar reports (its tooltip always holds the total). */
async function pageTotal(page: Page): Promise<number> {
  return Number((await page.locator(".print-status").getAttribute("title"))?.match(/^(\d+) pages?$/)?.[1] ?? 0);
}

test("pagination, page breaks, preview, PDF export, printing and the title page", async () => {
  const { electronApp, page, userData } = await launch();
  const pdfPath = join(userData, "export.pdf");
  // No native dialogs in tests: Save answers with a path, and "save changes?" answers Don't Save.
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  }, pdfPath);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Page breaks reach the editor, with (MORE) and CHARACTER (CONT'D) where a speech breaks, and the status bar
  // shows the caret's page.
  await page.waitForSelector(".editor-pm");
  await loadScript(page, 10);
  const pageCount = () => pageTotal(page);
  await expect.poll(pageCount).toBeGreaterThan(3);
  const pages = await pageCount();
  await expect(page.locator(".print-status")).toHaveText(new RegExp(`^Page \\d+ of ${pages}$`));
  await expect(page.locator(".editor-pagebreak-number")).toHaveText(Array.from({ length: pages - 1 }, (_, i) => `${i + 2}.`));
  await expect(page.locator(".editor-pagebreak", { has: page.locator(".editor-pagebreak-more") }).locator(".editor-pagebreak-contd").first())
    .toHaveText("ANNA (CONT'D)");

  // Typing more re-paginates after a pause.
  await loadScript(page, 20);
  await expect.poll(pageCount).toBeGreaterThan(pages);
  const longer = await pageCount();

  // Print preview draws every page.
  await runCommand(page, "print.print");
  await expect(page.locator(".print-page")).toHaveCount(longer);
  await expect(page.locator(".print-count")).toHaveText(`${longer} pages`);
  await page.keyboard.press("Escape");

  // Title page: edit, store in the document, and print first.
  await runCommand(page, "title-page.edit");
  await page.locator('.title-page-form input[name="Title"]').fill("The Test Script");
  await expect(page.locator('.title-page-form input[name="Credit"]')).toHaveValue("Written by");
  await page.locator('.title-page-form textarea[name="Author"]').fill("A. Writer");
  await page.locator('.title-page-form input[name="Draft date"]').fill("October 30, 2026");
  await page.locator('.title-page-form textarea[name="Contact"]').fill("A. Writer\nwriter@example.com");
  await page.locator(".title-page-form button[type=submit]").click();
  const titlePage = await page.evaluate(() => (window as any).__app.session.script().titlePage);
  expect(titlePage).toEqual([
    { key: "Title", values: ["The Test Script"] }, { key: "Credit", values: ["Written by"] }, { key: "Author", values: ["A. Writer"] },
    { key: "Draft date", values: ["October 30, 2026"] }, { key: "Contact", values: ["A. Writer", "writer@example.com"] },
  ]);
  await runCommand(page, "print.print");
  await expect(page.locator(".print-page")).toHaveCount(longer + 1);
  await expect(page.locator(".print-page").first()).toHaveClass(/print-title/);
  await expect(page.locator(".print-page").first()).toContainText("THE TEST SCRIPT");

  // Print sends the pages to the print service (which renders them without a dialog in tests).
  await page.getByRole("button", { name: "Print…" }).click();
  await expect(page.locator(".toast")).toContainText(`Rendered ${longer + 1} pages for printing.`);

  // Save PDF writes a PDF with the title page and every script page.
  await page.getByRole("button", { name: "Save PDF…" }).click();
  await expect.poll(() => existsSync(pdfPath)).toBe(true);
  await expect(page.locator(".toast").last()).toContainText("Exported export.pdf");
  const pdf = await PDFDocument.load(readFileSync(pdfPath));
  expect(pdf.getPageCount()).toBe(longer + 1);
  expect(pdf.getTitle()).toBe("The Test Script");

  // Printing settings: the section is there and changes reach the settings store.
  await runCommand(page, "workspace.settings");
  await page.locator(".workspace-settings nav .list-row", { hasText: "Printing" }).click();
  await page.locator(".print-settings select").first().selectOption("left");
  await page.locator(".print-settings .print-check", { hasText: "Print the title page" }).locator("input").uncheck();
  expect(await page.evaluate(() => [(window as any).__app.settings["print.sceneNumbers"], (window as any).__app.settings["print.titlePage"]])).toEqual(["left", false]);
  await page.keyboard.press("Escape");

  // Export PDF from the File menu command, now without the title page.
  await runCommand(page, "print.exportPdf");
  await expect.poll(async () => (await PDFDocument.load(readFileSync(pdfPath))).getPageCount()).toBe(longer);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("title page edits keep other fields and undo; pagination follows a new document; nothing shows on screen", async () => {
  const { electronApp, page } = await launch();
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const titlePage = () => page.evaluate(() => (window as any).__app.session.script().titlePage);

  // A Fountain title page with keys the dialog does not show, and "Authors" rather than "Author".
  const fountain = [
    { key: "Title", values: ["Old Title"] }, { key: "Authors", values: ["A. Writer"] },
    { key: "Revision", values: ["Blue"] }, { key: "Format", values: ["Short"] },
  ];
  await page.evaluate((fields) => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.meta.set("titlePage", fields));
    app.session.undo.clear();
  }, fountain);

  // Saving without a change leaves the stored fields alone.
  await runCommand(page, "title-page.edit");
  await expect(page.locator('.title-page-form input[name="Title"]')).toHaveValue("Old Title");
  await page.locator(".title-page-form button[type=submit]").click();
  expect(await titlePage()).toEqual(fountain);
  expect(await page.evaluate(() => (window as any).__app.session.undo.undoStack.length)).toBe(0);

  // An edit keeps the other fields and the original key, and is one undoable step.
  await runCommand(page, "title-page.edit");
  await page.locator('.title-page-form input[name="Title"]').fill("New Title");
  await page.locator('.title-page-form textarea[name="Author"]').fill("A. Writer\nB. Writer");
  await page.locator(".title-page-form button[type=submit]").click();
  expect(await titlePage()).toEqual([
    { key: "Title", values: ["New Title"] }, { key: "Authors", values: ["A. Writer", "B. Writer"] },
    { key: "Revision", values: ["Blue"] }, { key: "Format", values: ["Short"] },
  ]);
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await titlePage()).toEqual(fountain);

  // A new document in the window: the page count follows it.
  const status = page.locator(".print-status");
  await expect(status).toHaveAttribute("title", "1 page");
  await page.evaluate(() => {
    const app = (window as any).__app;
    const next = app.session.constructor.untitled();
    app.setSession(next);
    const sentences = Array.from({ length: 400 }, (_, i) => `Sentence ${i} is here.`).join(" ");
    next.edit(() => next.doc.load({ titlePage: [], paragraphs: [
      { id: "h", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
      { id: "c", type: "character", runs: [{ text: "ANNA" }] },
      { id: "d", type: "dialogue", runs: [{ text: sentences }] },
    ] }));
  });
  await expect.poll(() => pageTotal(page)).toBeGreaterThan(3);
  const pages = await pageTotal(page);
  await expect(status).toHaveText(new RegExp(`^Page \\d+ of ${pages}$`));

  // (MORE) prints at each dialogue break until the setting turns it off.
  await runCommand(page, "print.print");
  await expect(page.locator(".print-page")).toHaveCount(pages);
  await expect(page.locator(".print-page text", { hasText: "(MORE)" })).toHaveCount(pages - 1);
  await page.evaluate(() => (window as any).__app.setSetting("print.dialogueBreaks", false));
  await expect(page.locator(".print-page text", { hasText: "(MORE)" })).toHaveCount(0);

  // Printing renders in a hidden window that is gone afterwards, and the app window stays hidden in tests.
  await page.getByRole("button", { name: "Print…" }).click();
  await expect(page.locator(".toast")).toContainText("pages for printing.");
  const windows = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()));
  expect(windows).toEqual([false]);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("Unicode PDF export requests system fonts and lets the writer cancel; revised pages only never sticks", async () => {
  const { electronApp, page, userData } = await launch();
  const pdfPath = join(userData, "unicode.pdf");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    (globalThis as any).boxes = [];
    (globalThis as any).e2eMessageBox = (options: { message: string; detail?: string }) => ((globalThis as any).boxes.push(options), 1);
  }, pdfPath);
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h", type: "sceneHeading", runs: [{ text: "INT. NOODLE BAR - NIGHT" }] },
      { id: "a", type: "action", runs: [{ text: "A sign reads 李记. Café regulars nod." }] },
    ] }));
  });
  const boxes = () => electronApp.evaluate(() => (globalThis as any).boxes as { message: string; detail: string }[]);

  // Cancel: no file.
  await runCommand(page, "print.exportPdf");
  await expect.poll(async () => (await boxes()).length).toBe(1);
  const [box] = await boxes();
  expect(box!.message).toBe("Use system-font PDF rendering for this draft?");
  expect(box!.detail).toContain('李 (page 1) and 记 (page 1) need fallback fonts');
  expect(box!.detail).not.toContain('would print as "?"');
  await page.waitForTimeout(300);
  expect(existsSync(pdfPath)).toBe(false);

  // Accepting system-font rendering writes a PDF without changing the screenplay text.
  await electronApp.evaluate(() => {
    (globalThis as any).e2eMessageBox = (options: unknown) => ((globalThis as any).boxes.push(options), 0);
  });
  await runCommand(page, "print.exportPdf");
  await expect.poll(() => existsSync(pdfPath)).toBe(true);
  expect((await boxes()).length).toBe(2);

  // A stored "revised pages only" from an older version is ignored, and the preview's box starts off every time.
  await page.evaluate(() => (window as any).__app.setSetting("print.revisedOnly", true));
  await runCommand(page, "print.print");
  await expect(page.locator(".print-count")).toHaveText("1 page");
  const only = page.locator(".print-toolbar .print-check input");
  await expect(only).not.toBeChecked();
  await only.check();
  await expect(page.locator(".print-count")).toHaveText("No revised pages");
  await page.keyboard.press("Escape");
  await runCommand(page, "print.print");
  await expect(page.locator(".print-toolbar .print-check input")).not.toBeChecked();
  await expect(page.locator(".print-count")).toHaveText("1 page");
  await page.keyboard.press("Escape");
  await close(electronApp, page);
});

test("locking pages that run through dual dialogue keeps every page and line in the preview", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await page.evaluate((text) => {
    const app = (window as any).__app;
    const dual = (side: number) => ({ block: "b", side });
    app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
      { id: "c1", type: "character", runs: [{ text: "NELL" }], dual: dual(1) },
      { id: "d1", type: "dialogue", runs: [{ text }], dual: dual(1) },
      { id: "c2", type: "character", runs: [{ text: "BOB" }], dual: dual(2) },
      { id: "d2", type: "dialogue", runs: [{ text }], dual: dual(2) },
    ] });
    app.session.undo.clear();
  }, Array.from({ length: 160 }, (_, i) => `Sentence ${i + 1} is here.`).join(" "));
  const preview = async () => {
    await runCommand(page, "print.print");
    await expect(page.locator(".print-page").first()).toBeVisible();
    const numbers = await page.locator(".print-page").evaluateAll((pages) => pages.map((node) => node.getAttribute("data-page")));
    const lines = await page.locator(".print-page text").allTextContents();
    await page.keyboard.press("Escape");
    return { numbers, lines };
  };
  const free = await preview();
  expect(free.numbers).toEqual(["1", "2", "3"]);
  await runCommand(page, "revisions.lockPages");
  expect(await preview()).toEqual(free);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});
