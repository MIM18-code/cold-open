import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenplayDoc, setSceneNumbersLocked, writeFdx } from "@screenplay/engine";

import { close, launch, runCommand } from "./helpers.ts";

function importedCollision(locked: boolean): string {
  const path = join(mkdtempSync(join(tmpdir(), "scene-numbers-")), "Draft.fdx");
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "a", type: "sceneHeading", sceneNumber: "12A", runs: [{ text: "INT. HALL - DAY" }] },
    { id: "b", type: "sceneHeading", sceneNumber: "12A", runs: [{ text: "INT. STAIRS - DAY" }] },
    { id: "c", type: "sceneHeading", sceneNumber: "13", runs: [{ text: "EXT. ROAD - DAY" }] },
  ] });
  setSceneNumbersLocked(doc, locked);
  writeFileSync(path, writeFdx(doc.toScript()));
  doc.ydoc.destroy();
  return path;
}

const numbers = (page: Page) => page.evaluate(() => (window as any).__app.session.doc.paragraphs()
  .filter((p: any) => p.type === "sceneHeading").map((p: any) => p.sceneNumber));

const snapshot = (page: Page) => page.evaluate(() => {
  const session = (window as any).__app.session;
  return { script: session.script(), version: session.version, dirty: session.dirty, undo: session.undo.undoStack.length };
});

test("unlocked imported duplicates survive preview and block every delivery until the writer resolves them", async () => {
  const path = importedCollision(false);
  const { electronApp, page } = await launch([path]);
  try {
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.path)).toBe(path);
    await electronApp.evaluate(({ dialog }) => {
      (globalThis as any).sceneNumberSaveDialogs = 0;
      dialog.showSaveDialog = (async () => {
        (globalThis as any).sceneNumberSaveDialogs++;
        return { canceled: true, filePath: "" };
      }) as typeof dialog.showSaveDialog;
    });
    const before = await snapshot(page);
    await runCommand(page, "print.print");
    await expect(page.locator(".print-preview")).toBeVisible();
    expect(await snapshot(page)).toEqual(before);
    await page.locator(".print-toolbar").getByRole("button", { name: "Print…", exact: true }).click();
    await expect(page.locator(".toast").filter({ hasText: "Duplicate scene numbers: 12A" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    expect(await snapshot(page)).toEqual(before);

    for (const command of ["print.exportPdf", "file.exportFdx", "file.exportFountain"]) {
      await runCommand(page, command);
      expect(await snapshot(page)).toEqual(before);
    }
    await runCommand(page, "delivery.open");
    await page.getByRole("button", { name: "Export previewed PDF…" }).click();
    await expect(page.getByRole("alert")).toContainText("Duplicate scene numbers: 12A");
    await page.keyboard.press("Escape");
    expect(await snapshot(page)).toEqual(before);
    expect(await electronApp.evaluate(() => (globalThis as any).sceneNumberSaveDialogs)).toBe(0);

    await runCommand(page, "revisions.numberConflicts");
    await expect(page.locator(".roadmap-dialog")).toContainText("Duplicate 12A");
    const input = page.getByRole("textbox", { name: "New number for INT. STAIRS - DAY" });
    await input.fill("12B");
    await page.locator(".field").filter({ has: input }).getByRole("button", { name: "Apply this number" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Every assigned scene number is unique." })).toHaveCount(1);
    expect(await numbers(page)).toEqual(["12A", "12B", "13"]);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await numbers(page)).toEqual(["12A", "12A", "13"]);
  } finally { await close(electronApp, page); }
});

test("opening and canceling Print Preview leaves locked collisions untouched; export can settle them", async () => {
  const path = importedCollision(true);
  const { electronApp, page } = await launch([path]);
  try {
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.path)).toBe(path);
    await electronApp.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
    });
    const before = await snapshot(page);
    await runCommand(page, "print.print");
    await expect(page.locator(".print-preview")).toBeVisible();
    expect(await snapshot(page)).toEqual(before);
    await page.keyboard.press("Escape");
    expect(await snapshot(page)).toEqual(before);
    await runCommand(page, "file.exportFdx");
    expect(await numbers(page)).toEqual(["12A", "12B", "13"]);
  } finally { await close(electronApp, page); }
});
