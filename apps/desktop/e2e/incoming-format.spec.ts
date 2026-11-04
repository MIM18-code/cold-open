import { expect, test, type Page } from "@playwright/test";
import { close, launch } from "./helpers.ts";

const FIRST = "Lena says, Keep the light on.";
const SECOND = "Lena says, Close the door.";
type Run = Awaited<ReturnType<typeof launch>>;
async function setup(run: Run): Promise<void> {
  await run.electronApp.evaluate(({ ipcMain }) => {
    (globalThis as any).__incomingRequests = [];
    ipcMain.removeHandler("dictation:format");
    ipcMain.handle("dictation:format", async (_event, request) => {
      (globalThis as any).__incomingRequests.push(request);
      if ((globalThis as any).__holdIncoming) await new Promise(resolve => { (globalThis as any).__releaseIncoming = resolve; });
      return { takeId: request.takeId, source: "text", transcript: request.text,
        elements: [{ type: "character", text: "LENA", uncertainty: "" },
          { type: "dialogue", text: request.text.split("says, ")[1] ?? request.text, uncertainty: "" }],
        autoApplyErrors: (globalThis as any).__unsafeIncoming ? ["Wording changed"] : [],
        error: (globalThis as any).__incomingError,
        diagnostics: [], warnings: [], commands: [], timings: { transcribeMs: 0, formatMs: 1, totalMs: 1 } };
    });
  });
  await run.page.evaluate(() => {
    const a = (window as any).__app;
    const id = a.session.script().paragraphs[0].id;
    a.session.edit(() => { a.session.doc.setType(id, "action"); a.session.doc.insertText(id, 0, "Earlier writing."); });
    a.session.undo.stopCapturing();
    a.editor.setSelection({ paragraphId: id, offset: 16 });
    a.editor.focus();
  });
}
const rows = (page: Page) => page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => [p.type, p.runs.map((r: any) => r.text).join("")]));
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate(value => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document.querySelector(".editor-pm")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}
async function enable(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Auto-format (on|off) incoming text/ }).click();
  await expect(page.getByRole("button", { name: /Auto-format (on|off) incoming text/ })).toHaveAttribute("aria-pressed", "true");
}
const ready = (page: Page) => expect(page.locator(".incoming-format-status")).toHaveCount(0);

test("optional automatic formatting targets only a new paste and preserves later typing and Undo", async () => {
  const run = await launch();
  try {
    await setup(run);
    await expect(run.page.getByRole("button", { name: /Auto-format (on|off) incoming text/ })).toHaveAttribute("aria-pressed", "false");
    await paste(run.page, " Ordinary paste.");
    expect(await rows(run.page)).toEqual([["action", "Earlier writing. Ordinary paste."]]);
    await run.page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."]]);
    await enable(run.page);
    await paste(run.page, FIRST);
    await run.page.keyboard.insertText("Later typing stays.");
    await ready(run.page);
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."], ["character", "LENA"], ["dialogue", "Keep the light on."], ["action", "Later typing stays."]]);
    await expect(run.page.locator(".editor-pm")).toBeFocused();
    await run.page.keyboard.press("Meta+z");
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."], ["action", FIRST], ["action", "Later typing stays."]]);
  } finally { await close(run.electronApp, run.page); }
});

test("a second take can arrive while the first formats, without moving the continuation caret", async () => {
  const run = await launch();
  try {
    await setup(run);
    await enable(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).__holdIncoming = true; });
    await paste(run.page, FIRST);
    await expect.poll(() => run.electronApp.evaluate(() => !!(globalThis as any).__releaseIncoming)).toBe(true);
    await paste(run.page, SECOND);
    const caret = await run.page.evaluate(() => (window as any).__app.editor.getSelection());
    await run.electronApp.evaluate(() => { (globalThis as any).__holdIncoming = false; (globalThis as any).__releaseIncoming(); });
    await ready(run.page);
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."], ["character", "LENA"], ["dialogue", "Keep the light on."], ["character", "LENA"], ["dialogue", "Close the door."], ["action", ""]]);
    expect(await run.page.evaluate(() => (window as any).__app.editor.getSelection())).toEqual(caret);
    await expect(run.page.locator(".editor-pm")).toBeFocused();
    expect(await run.electronApp.evaluate(() => (globalThis as any).__incomingRequests.length)).toBe(2);
  } finally { await close(run.electronApp, run.page); }
});

test("pasting between existing words preserves the text on both sides", async () => {
  const run = await launch();
  try {
    await setup(run);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.editor.setSelection({ paragraphId: a.session.script().paragraphs[0].id, offset: 8 });
    });
    await enable(run.page);
    await paste(run.page, FIRST);
    await ready(run.page);
    expect(await rows(run.page)).toEqual([["action", "Earlier "], ["character", "LENA"], ["dialogue", "Keep the light on."], ["action", ""], ["action", "writing."]]);
  } finally { await close(run.electronApp, run.page); }
});

test("switching off during a request keeps the raw take and disables further automatic formatting", async () => {
  const run = await launch();
  try {
    await setup(run);
    await enable(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).__holdIncoming = true; });
    await paste(run.page, FIRST);
    await expect.poll(() => run.electronApp.evaluate(() => !!(globalThis as any).__releaseIncoming)).toBe(true);
    await run.page.getByRole("button", { name: /Auto-format (on|off) incoming text/ }).click();
    await run.electronApp.evaluate(() => (globalThis as any).__releaseIncoming());
    await ready(run.page);
    await paste(run.page, "Ordinary text.");
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."], ["action", FIRST], ["action", "Ordinary text."]]);
    expect(await run.electronApp.evaluate(() => (globalThis as any).__incomingRequests.length)).toBe(1);
  } finally { await close(run.electronApp, run.page); }
});

test("source edits, Undo and document switches cannot receive late formatting", async () => {
  for (const action of ["edit", "undo", "switch"]) {
    const run = await launch();
    try {
      await setup(run);
      await enable(run.page);
      await run.electronApp.evaluate(() => { (globalThis as any).__holdIncoming = true; });
      await paste(run.page, FIRST);
      await expect.poll(() => run.electronApp.evaluate(() => !!(globalThis as any).__releaseIncoming)).toBe(true);
      await run.page.evaluate(kind => {
        const a = (window as any).__app;
        if (kind === "edit") a.session.edit(() => a.session.doc.insertText(a.session.script().paragraphs[1].id, 0, "Changed. "));
        if (kind === "undo") a.session.undo.undo();
        if (kind === "switch") a.setSession(a.session.constructor.untitled());
      }, action);
      const before = await rows(run.page);
      await run.electronApp.evaluate(() => (globalThis as any).__releaseIncoming());
      await ready(run.page);
      expect(await rows(run.page)).toEqual(before);
    } finally { await close(run.electronApp, run.page); }
  }
});

test("uncertain formatting keeps the words on the page without interrupting typing", async () => {
  const run = await launch();
  try {
    await setup(run);
    await enable(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).__unsafeIncoming = true; });
    await paste(run.page, FIRST);
    await ready(run.page);
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."], ["action", FIRST], ["action", ""]]);
    await expect(run.page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(run.page.locator(".editor-pm")).toBeFocused();
  } finally { await close(run.electronApp, run.page); }
});

test("highlighted text and screenplay clipboard content retain normal paste behavior", async () => {
  const run = await launch();
  try {
    await setup(run);
    await enable(run.page);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      const id = a.session.script().paragraphs[0].id;
      a.editor.setSelection({ paragraphId: id, offset: 0 }, { paragraphId: id, offset: 7 });
    });
    await paste(run.page, "New");
    expect(await rows(run.page)).toEqual([["action", "New writing."]]);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      const id = a.session.script().paragraphs[0].id;
      a.editor.setSelection({ paragraphId: id, offset: 12 });
      a.editor.pasteData(JSON.stringify({ version: 1, paragraphs: [{ type: "dialogue", runs: [{ text: " Kept bold.", bold: true }] }] }), " Kept bold.");
    });
    await expect(run.page.locator(".editor-pm strong")).toHaveText(" Kept bold.");
    expect(await run.electronApp.evaluate(() => (globalThis as any).__incomingRequests.length)).toBe(0);
  } finally { await close(run.electronApp, run.page); }
});

test("an incoming take closes old character suggestions and Enter stays on the continuation line", async () => {
  const run = await launch();
  try {
    await setup(run);
    await enable(run.page);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.editor.insertParagraphs([{ type: "character", text: "MARA" }, { type: "dialogue", text: "Hello." }, { type: "character", text: "" }]);
      a.editor.focus();
    });
    await run.page.keyboard.type("ma");
    await expect(run.page.locator(".editor-smarttype")).toBeVisible();
    await paste(run.page, FIRST);
    await expect(run.page.locator(".editor-smarttype")).toHaveCount(0);
    await run.page.keyboard.press("Enter");
    await ready(run.page);
    const after = await rows(run.page);
    expect(after.filter(([type]: string[]) => type === "character").map(([, text]: string[]) => text)).toEqual(["MARA", "MA", "LENA"]);
    expect(after.slice(-2)).toEqual([["action", ""], ["action", ""]]);
    const caret = await run.page.evaluate(() => {
      const a = (window as any).__app;
      return [a.editor.getSelection().head.paragraphId, a.session.script().paragraphs.at(-1).id];
    });
    expect(caret[0]).toBe(caret[1]);
  } finally { await close(run.electronApp, run.page); }
});

test("formatter failures keep the transcript and explain the missing setup", async () => {
  const run = await launch();
  try {
    await setup(run);
    await enable(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).__incomingError = "Start the local formatter."; });
    await paste(run.page, FIRST);
    await ready(run.page);
    expect(await rows(run.page)).toEqual([["action", "Earlier writing."], ["action", FIRST], ["action", ""]]);
    await expect(run.page.getByText("Incoming text kept. Start the local formatter.", { exact: true })).toBeVisible();
  } finally { await close(run.electronApp, run.page); }
});
