import { expect, test } from "@playwright/test";
import { close, launch } from "./helpers.ts";

test("fixed magnification survives opening an inspector and stays independent of print layout", async () => {
  const run = await launch();
  try {
    await run.page.evaluate(async () => {
      const app = (window as any).__app;
      await app.setSetting("editor.zoom", 1.5);
      await app.setSetting("editor.zoomMode", "fixed");
    });
    await expect(run.page.getByRole("combobox", { name: "Script zoom" })).toHaveValue("1.5");
    await run.page.evaluate(() => (window as any).__app.togglePanel("tableRead", true));
    await expect.poll(() => run.page.locator(".editor-view").evaluate((el) => el.style.getPropertyValue("--editor-zoom"))).toBe("1.5");
    await run.page.evaluate(() => (window as any).__app.runCommand("editor.zoomFit"));
    await expect(run.page.getByRole("combobox", { name: "Script zoom" })).toHaveValue("fit");
  } finally { await close(run.electronApp, run.page); }
});

test("disabled commands remain searchable and explain their current constraint", async () => {
  const run = await launch();
  try {
    await run.page.evaluate(() => { const app = (window as any).__app; app.setView("cards"); app.setPalette(true); });
    await run.page.getByRole("combobox", { name: "Command" }).fill("Format Draft");
    await expect(run.page.locator(".palette [role=option][aria-disabled=true]")).toHaveCount(1);
    await run.page.keyboard.press("Enter");
    await expect(run.page.getByRole("status").filter({ hasText: "Open the Write view first" })).toBeVisible();
    await expect(run.page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  } finally { await close(run.electronApp, run.page); }
});

test("scene navigator is one tab stop and supports arrow navigation and one-step move", async () => {
  const run = await launch();
  try {
    await run.page.evaluate(() => {
      const app = (window as any).__app;
      app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
        { id: "one", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. FIRST - DAY" }] },
        { id: "one-a", type: "action", runs: [{ text: "First action." }] },
        { id: "two", sceneId: "s2", type: "sceneHeading", runs: [{ text: "INT. SECOND - NIGHT" }] },
        { id: "two-a", type: "action", runs: [{ text: "Second action." }] },
        { id: "three", sceneId: "s3", type: "sceneHeading", runs: [{ text: "EXT. THIRD - DAY" }] },
        { id: "three-a", type: "action", runs: [{ text: "Third action." }] },
      ] }));
      app.session.undo.stopCapturing();
    });
    const list = run.page.getByRole("listbox", { name: "Scenes" });
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect.poll(() => list.locator('[role=option][tabindex="0"]').count()).toBe(1);
    await list.getByRole("option").first().focus();
    await run.page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option").nth(1)).toBeFocused();
    await run.page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => run.page.evaluate(() => (window as any).__app.session.doc.paragraphs()
      .filter((p: any) => p.type === "sceneHeading").map((p: any) => p.runs.map((r: any) => r.text).join("")))).toEqual(
      ["INT. SECOND - NIGHT", "INT. FIRST - DAY", "EXT. THIRD - DAY"]);
    await run.page.evaluate(() => (window as any).__app.session.undo.undo());
    await expect.poll(() => run.page.evaluate(() => (window as any).__app.session.doc.paragraphs()
      .filter((p: any) => p.type === "sceneHeading").map((p: any) => p.runs.map((r: any) => r.text).join("")))).toEqual(
      ["INT. FIRST - DAY", "INT. SECOND - NIGHT", "EXT. THIRD - DAY"]);
  } finally { await close(run.electronApp, run.page); }
});
