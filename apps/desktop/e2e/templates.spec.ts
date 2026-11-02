import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { parseFdx, plainText } from "@screenplay/engine";

import { close, launch, runCommand } from "./helpers.ts";

test("New from Template starts a script with the chosen act structure", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await runCommand(page, "template.new");
  await page.getByRole("button", { name: /Multi-camera sitcom/ }).click();
  const script = await page.evaluate(() => {
    const current = (window as any).__app.session.script();
    return {
      template: current.template,
      acts: current.paragraphs.filter((part: { type: string }) => part.type === "newAct")
        .map((part: { runs: { text: string }[] }) => part.runs.map((run) => run.text).join("")),
    };
  });
  expect(script).toEqual({ template: "multiCamera", acts: ["COLD OPEN", "ACT ONE", "ACT TWO", "TAG"] });
  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("New from Template opens a second window when the current script has work", async () => {
  const { electronApp, page } = await launch();
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h", type: "sceneHeading", runs: [{ text: "INT. A - DAY" }] },
    ] }));
  });
  const opening = electronApp.waitForEvent("window");
  await runCommand(page, "template.new");
  await page.getByRole("button", { name: /Stage play/ }).click();
  const second = await opening;
  await second.waitForSelector(".editor-pm");
  await expect.poll(() => second.evaluate(() => (window as any).__app.session.script().template)).toBe("stage");
  await close(electronApp, second);
});

test("applying the multi-camera template formats an existing script, undoes as one edit, and exports a PDF", async () => {
  const { electronApp, page, userData } = await launch();
  const pdfPath = join(userData, "multicam.pdf");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
  }, pdfPath);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.waitForSelector(".editor-pm");
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h1", type: "sceneHeading", sceneId: "h1", runs: [{ text: "INT. APARTMENT - NIGHT" }] },
      { id: "a1", type: "action", runs: [{ text: "MAYA ENTERS WITH A FISH TANK." }] },
      { id: "c1", type: "character", runs: [{ text: "MAYA" }] },
      { id: "d1", type: "dialogue", runs: [{ text: "It is a long story." }] },
      { id: "h2", type: "sceneHeading", sceneId: "h2", runs: [{ text: "INT. KITCHEN - NIGHT" }] },
      { id: "a2", type: "action", runs: [{ text: "THE EXIT SIGN FLICKERS." }] },
    ] }));
    app.session.undo.clear();
  });

  await runCommand(page, "layout.edit");
  await page.getByLabel("Layout template").selectOption("multiCamera");
  await page.getByLabel("Underline entrances and exits").check();
  await page.getByRole("button", { name: "Apply document layout" }).click();

  const applied = await page.evaluate(() => {
    const script = (window as any).__app.session.script();
    return {
      template: script.template,
      exitSignUnderlined: script.paragraphs[5].runs.some((run: { underline?: boolean }) => run.underline),
      action: script.paragraphs[1].runs.map((run: { text: string; underline?: boolean }) => [run.text, run.underline === true]),
    };
  });
  expect(applied.template).toBe("multiCamera");
  expect(applied.exitSignUnderlined).toBe(false);
  expect(applied.action).toEqual([["MAYA ENTERS", true], [" WITH A FISH TANK.", false]]);

  // The whole template is one undo: layout, template rule and underlined entrance.
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  const undone = await page.evaluate(() => {
    const script = (window as any).__app.session.script();
    return { template: script.template, underlined: script.paragraphs[1].runs.some((run: { underline?: boolean }) => run.underline) };
  });
  expect(undone).toEqual({ template: undefined, underlined: false });
  await page.evaluate(() => (window as any).__app.session.undo.redo());

  // Two scenes with a page per scene in the multi-camera template, so the PDF has two pages.
  await runCommand(page, "print.exportPdf");
  await expect.poll(() => existsSync(pdfPath)).toBe(true);
  const pdf = await PDFDocument.load(readFileSync(pdfPath));
  expect(pdf.getPageCount()).toBe(2);

  const sidesPath = join(userData, "multicam-sides.fdx");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
  }, sidesPath);
  await runCommand(page, "reports.sides");
  const sides = page.getByRole("dialog", { name: "Export Sides" });
  await sides.getByRole("button", { name: "Select all" }).click();
  await sides.getByRole("button", { name: "Export…" }).click();
  await expect.poll(() => existsSync(sidesPath)).toBe(true);
  // Sides keep the multi-camera rule that every scene starts a new page.
  const sidesXml = readFileSync(sidesPath, "utf8");
  expect(sidesXml.match(/<Paragraph[^>]*Type="Scene Heading"[^>]*>/g)?.filter((tag) => tag.includes('StartsNewPage="Yes"')).length).toBeGreaterThanOrEqual(1);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});


for (const template of ["feature", "oneHourDrama", "halfHourComedy"]) {
  test(`${template}: Return after Action keeps the next paragraph in Action`, async () => {
    const { electronApp, page } = await launch();
    try {
      await page.evaluate(() => {
        const session = (window as any).__app.session;
        session.edit(() => session.doc.load({ titlePage: [], paragraphs: [
          { id: "a", type: "action", runs: [{ text: "He waits." }] },
        ] }));
      });
      await runCommand(page, "layout.edit");
      await page.getByLabel("Layout template").selectOption(template);
      await page.getByRole("button", { name: "Apply document layout" }).click();
      await page.evaluate(() => {
        const editor = (window as any).__app.editor;
        editor.focus();
        editor.setSelection({ paragraphId: "a", offset: 9 }, { paragraphId: "a", offset: 9 });
      });
      await page.keyboard.press("Enter");
      await page.keyboard.type("He stops.");
      await expect.poll(() => page.evaluate(() => (window as any).__app.session.script().paragraphs.map((part: any) =>
        [part.type, part.runs.map((run: any) => run.text).join("")]))).toEqual([["action", "He waits."], ["action", "He stops."]]);
    } finally {
      await close(electronApp, page);
    }
  });
}


test("stage directions with inline notes export visible closing parentheses", async () => {
  const { electronApp, page, userData } = await launch();
  try {
    const path = join(userData, "stage.fdx");
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    }, path);
    await page.evaluate(() => {
      const session = (window as any).__app.session;
      session.edit(() => session.doc.load({ titlePage: [], paragraphs: [
        { id: "a", type: "action", runs: [{ text: "The door opens." }, { text: "Check prop", note: true }] },
        { id: "n", type: "action", runs: [{ text: "Private note", note: true }] },
      ] }));
    });
    await runCommand(page, "layout.edit");
    await page.getByLabel("Layout template").selectOption("stage");
    await page.getByLabel("Parenthesize stage directions").check();
    await page.getByRole("button", { name: "Apply document layout" }).click();
    expect(await page.evaluate(() => (window as any).__app.session.script().paragraphs[1].runs))
      .toEqual([{ text: "Private note", note: true }]);
    await runCommand(page, "file.exportFdx");
    await expect.poll(() => existsSync(path)).toBe(true);
    expect(plainText(parseFdx(readFileSync(path, "utf8")).paragraphs[0]!.runs)).toBe("(The door opens.)");
  } finally {
    await close(electronApp, page);
  }
});

test("Underline Entrances marks entrances written after the template, once", async () => {
  const { electronApp, page } = await launch();
  try {
    await runCommand(page, "template.new");
    await page.getByRole("button", { name: /Multi-camera sitcom/ }).click();
    await page.locator(".editor-t-sceneHeading").first().click();
    await page.keyboard.type("INT. KITCHEN - DAY");
    await page.keyboard.press("Enter");
    await page.keyboard.type("MARY enters with the mail. THE DOOR EXITS ITS TRACK.");
    await runCommand(page, "layout.underlineEntrances");
    await expect(page.getByText("Underlined 1 entrance or exit.")).toBeVisible();
    await runCommand(page, "layout.underlineEntrances");
    await expect(page.getByText("No entrances or exits to underline.")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__app.session.script().paragraphs.find((p: any) => p.type === "action" && p.runs.length)
      .runs.map((r: any) => [r.text, !!r.underline]))).toEqual([["MARY enters", true], [" with the mail. THE DOOR EXITS ITS TRACK.", false]]);
    // Undo takes back the underline alone; the words typed just before stay.
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await page.evaluate(() => (window as any).__app.session.script().paragraphs.find((p: any) => p.type === "action" && p.runs.length)
      .runs.map((r: any) => [r.text, !!r.underline]))).toEqual([["MARY enters with the mail. THE DOOR EXITS ITS TRACK.", false]]);
  } finally { await close(electronApp, page); }
});
