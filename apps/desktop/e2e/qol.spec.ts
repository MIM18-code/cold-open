// Real hidden Electron integration. Only the local model's HTTP response is a fixture.
import { expect, test, type Page } from "@playwright/test";
import { fakeModelServer } from "./fakes.ts";
import { close, launch, runCommand } from "./helpers.ts";

const TEXT = "Interior kitchen night. Maya stands at the sink. Maya says, I can't do this anymore.";
const PROPOSAL = { elements: [
  { type: "scene_heading", text: "INT. KITCHEN - NIGHT", source_quote: "Interior kitchen night.", uncertainty: "" },
  { type: "action", text: "Maya stands at the sink.", source_quote: "Maya stands at the sink.", uncertainty: "" },
  { type: "character", text: "MAYA", source_quote: "Maya says, I can't do this anymore.", uncertainty: "" },
  { type: "dialogue", text: "I can't do this anymore.", source_quote: "I can't do this anymore.", uncertainty: "" },
], omissions: [], warnings: [] };
async function draft(page: Page) {
  await page.evaluate((text) => {
    const a = (window as any).__app;
    a.session.doc.load({ titlePage: [], paragraphs: [{ id: "rough", type: "action", runs: [{ text }] }] });
    a.session.undo.clear();
    a.editor.setSelection({ paragraphId: "rough", offset: 0 }); a.editor.focus();
  }, TEXT);
}
const EXPECTED = ["INT. KITCHEN - NIGHT", "MAYA stands at the sink.", "MAYA", "I can't do this anymore."];
const texts = (page: Page) => page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join("")));

test("main draft shortcut uses the real IPC formatter, directly replaces text, and undoes once", async () => {
  const model = await fakeModelServer(PROPOSAL);
  const run = await launch();
  try {
    await run.page.evaluate((url) => (window as any).__app.setSetting("dictation.endpoint", url), model.endpoint);
    await draft(run.page);
    await run.page.keyboard.press("Meta+Shift+Enter");
    await expect.poll(() => texts(run.page)).toEqual(EXPECTED);
    await expect(run.page.getByRole("dialog")).toHaveCount(0);
    await expect(run.page.locator(".sidepanel-right")).toHaveCount(0);
    await run.page.keyboard.press("Meta+z");
    await expect.poll(() => texts(run.page)).toEqual([TEXT]);
    expect(await run.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()))).toBe(true);
  } finally { await close(run.electronApp, run.page); await model.close(); }
});

test("native menu input triggers Format Draft exactly once", async () => {
  const model = await fakeModelServer(PROPOSAL);
  const run = await launch();
  try {
    await run.page.evaluate((url) => (window as any).__app.setSetting("dictation.endpoint", url), model.endpoint);
    await draft(run.page);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      const command = a.commands.find((c: any) => c.id === "draftFormat.run");
      const original = command.run; (window as any).__formatCount = 0;
      command.run = (...args: any[]) => { (window as any).__formatCount++; return original(...args); };
      a.refreshMenu();
    });
    await run.page.waitForTimeout(100); // allow the native menu's documented 50 ms debounce
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      wc.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["meta", "shift"] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["meta", "shift"] });
    });
    await expect.poll(() => texts(run.page)).toEqual(EXPECTED);
    expect(await run.page.evaluate(() => (window as any).__formatCount)).toBe(1);
  } finally { await close(run.electronApp, run.page); await model.close(); }
});

test("preview preference leaves the draft unchanged until Apply", async () => {
  const model = await fakeModelServer(PROPOSAL);
  const run = await launch();
  try {
    await run.page.evaluate(async (url) => {
      await (window as any).__app.setSetting("dictation.endpoint", url);
      await (window as any).__app.setSetting("draftFormat.alwaysReview", true);
    }, model.endpoint);
    await draft(run.page);
    await run.page.getByRole("button", { name: /Format Draft/ }).click();
    await expect(run.page.getByRole("dialog", { name: "Review draft formatting" })).toBeVisible();
    expect(await texts(run.page)).toEqual([TEXT]);
    await run.page.getByRole("button", { name: "Keep original" }).click();
    expect(await texts(run.page)).toEqual([TEXT]);
  } finally { await close(run.electronApp, run.page); await model.close(); }
});

test("new document tabs retain independent sessions without showing test windows", async () => {
  test.skip(process.platform !== "darwin", "native document tabs are macOS only");
  const run = await launch();
  try {
    await draft(run.page);
    const original = await run.page.evaluate(() => (window as any).__app.session.id);
    const nextWindow = run.electronApp.waitForEvent("window");
    await runCommand(run.page, "writing.newTab");
    const other = await nextWindow; await other.waitForSelector(".editor-pm");
    expect(await other.evaluate(() => (window as any).__app.session.id)).not.toBe(original);
    expect(await texts(other)).toEqual([""]);
    expect(await texts(run.page)).toEqual([TEXT]);
    await other.evaluate(() => { (window as any).__app.session.dirty = false; });
    expect(await run.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()))).toBe(true);
  } finally { await close(run.electronApp, run.page); }
});

test("shortcut reference, focus mode and page navigation work in the hidden app", async () => {
  const run = await launch();
  try {
    await draft(run.page);
    await runCommand(run.page, "writing.shortcuts");
    await expect(run.page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await run.page.getByRole("textbox", { name: "Search shortcuts" }).fill("dialogue");
    await expect(run.page.locator(".writing-shortcuts tr").filter({ hasText: "Dialogue" }).first()).toBeVisible();
    await run.page.keyboard.press("Escape");
    await runCommand(run.page, "writing.focus");
    await expect(run.page.locator(".sidepanel-left")).toBeHidden();
    await run.page.locator(".editor-pm").click(); await run.page.keyboard.press("Escape");
    await expect(run.page.locator(".sidepanel-left")).toBeVisible();
    await runCommand(run.page, "writing.goToPage");
    await run.page.getByRole("textbox", { name: "Page number" }).fill("1");
    await run.page.getByRole("button", { name: "Go to page", exact: true }).click();
    await expect(run.page.getByRole("dialog")).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});
