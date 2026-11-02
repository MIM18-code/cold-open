// A writer's day in one window, with the real editor and every feature that draws on it or edits through it:
// typing with Enter, Tab and SmartType, page breaks from the print feature, proofreading, the navigator, index
// cards, reports, compare, rename, dictation, and FDX and .screenplay files that reopen the same.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { parseFdx, plainText } from "@screenplay/engine";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeWav } from "../src/renderer/features/dictation/wav.ts";
import { fakeModelServer, fakeSpeechHelper } from "./fakes.ts";
import { close, launch, runCommand } from "./helpers.ts";

type Row = [string, string];

const rows = (page: Page): Promise<Row[]> => page.evaluate(() =>
  (window as any).__app.session.script().paragraphs.map((p: any) => [p.type, p.runs.map((r: any) => r.text).join("")]));
const ids = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => p.id));
const idOf = async (page: Page, text: string): Promise<string> => {
  const id = await page.evaluate((wanted) => (window as any).__app.session.script().paragraphs
    .find((p: any) => p.runs.map((r: any) => r.text).join("") === wanted)?.id, text);
  expect(id, `a paragraph reading "${text}"`).toBeTruthy();
  return id as string;
};
const caret = (page: Page) => page.evaluate(() => (window as any).__app.editor?.getSelection()?.head ?? null);

/** Enter, closing a SmartType list first so Enter starts the next element instead of accepting a suggestion. */
async function enter(page: Page): Promise<void> {
  if (await page.locator(".editor-smarttype").count()) await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
}

/** Answer the next native save and open dialogs without showing them. */
async function answerDialogs(electronApp: ElectronApplication, answers: { save?: string; open?: string }): Promise<void> {
  await electronApp.evaluate(({ dialog }, { save, open }) => {
    if (save) dialog.showSaveDialog = (async () => ({ canceled: false, filePath: save })) as unknown as typeof dialog.showSaveDialog;
    if (open) dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [open] })) as unknown as typeof dialog.showOpenDialog;
  }, answers);
}

/** Open a file through File > Open. This window's script is changed, so it opens in a new hidden window. */
async function openInNewWindow(electronApp: ElectronApplication, page: Page, path: string): Promise<Page> {
  await answerDialogs(electronApp, { open: path });
  const opened = electronApp.waitForEvent("window");
  await runCommand(page, "file.open");
  const other = await opened;
  await other.waitForSelector(".shell");
  await expect.poll(() => other.evaluate(() => (window as any).__app.session.path)).toBe(path);
  return other;
}

async function closeWindow(page: Page): Promise<void> {
  await page.evaluate(() => void ((window as any).__app.session.dirty = false));
  await page.close();
}

/** Count the commands the renderer runs, however they were triggered. */
async function countCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).__app;
    const ran: string[] = ((window as any).__ran = []);
    const run = app.runCommand.bind(app);
    app.runCommand = (id: string) => (ran.push(id), run(id));
  });
}
const ran = (page: Page, id: string) => page.evaluate((command) => ((window as any).__ran as string[]).filter((c) => c === command).length, id);

/** A real key press as macOS delivers it to the window, through the main process (not Playwright's page input). */
async function nativeKey(electronApp: ElectronApplication, keyCode: string, modifiers: ("meta" | "shift" | "alt" | "control")[]): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "char", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }, { keyCode, modifiers });
}

const DICTATED = "Thunder rolls. Nora says, let's go.";
const PROPOSAL = {
  elements: [
    { type: "action", text: "Thunder rolls.", source_quote: "Thunder rolls.", uncertainty: "" },
    { type: "character", text: "NORA", source_quote: "Nora says,", uncertainty: "" },
    { type: "dialogue", text: "Let's go.", source_quote: "let's go.", uncertainty: "" },
  ],
  omissions: [],
  warnings: [],
};

test("a writer's day: type, check, restructure, compare, rename, dictate, export and reopen", async () => {
  test.setTimeout(150_000);
  const folder = mkdtempSync(join(tmpdir(), "screenplay-workday-"));
  const model = await fakeModelServer(PROPOSAL);
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.waitForSelector(".editor-pm");
    await countCommands(page);

    // First run: the empty heading shows an example; the welcome points at app features, not screenplay basics.
    await expect(page.locator(".editor-pm .editor-placeholder")).toHaveAttribute("data-placeholder", "INT. LOCATION - DAY");
    await expect(page.locator(".editor-welcome")).toContainText("Format Draft");
    await expect(page.locator(".editor-welcome")).not.toContainText("Tab");

    // Type a scene with Enter, Tab and SmartType, the way Final Draft writers do.
    await page.evaluate(() => (window as any).__app.editor.focus());
    await page.keyboard.type("int. kitchen - night");
    await expect(page.locator(".editor-welcome")).toHaveCount(0);
    await expect(page.locator(".editor-pm .editor-placeholder")).toHaveCount(0);
    await enter(page);
    await page.keyboard.type("Maya opens the fridge.");
    await enter(page);
    await page.keyboard.press("Tab");
    await page.keyboard.type("maya");
    await enter(page);
    await page.keyboard.type("Nothing here.");
    await enter(page);
    await page.keyboard.press("Tab");
    await page.keyboard.type("m");
    await expect(page.locator(".editor-smarttype li").first()).toHaveText("MAYA");
    await page.keyboard.press("Enter");
    await expect(page.locator(".editor-smarttype")).toHaveCount(0);
    await enter(page);
    await page.keyboard.type("Still nothing.");
    await page.keyboard.press("Tab");
    await page.keyboard.type("beat");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Fine.");
    await enter(page);
    await page.keyboard.press("Tab");
    await page.keyboard.type("mya");
    await enter(page);
    await page.keyboard.type("Hello?");
    await enter(page);
    await page.keyboard.type("She sits.");
    await enter(page);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("ext. yard - night");
    await enter(page);
    await page.keyboard.type("Rain on the car.");
    const typed: Row[] = [
      ["sceneHeading", "INT. KITCHEN - NIGHT"], ["action", "Maya opens the fridge."], ["character", "MAYA"], ["dialogue", "Nothing here."],
      ["character", "MAYA"], ["dialogue", "Still nothing."], ["parenthetical", "(beat)"], ["dialogue", "Fine."],
      ["character", "MYA"], ["dialogue", "Hello?"], ["action", "She sits."], ["sceneHeading", "EXT. YARD - NIGHT"], ["action", "Rain on the car."],
    ];
    expect(await rows(page)).toEqual(typed);
    await expect(page.locator(".editor-pm > .editor-p")).toHaveCount(typed.length);

    // Bold from a real key press runs once (one Bold, not on and off again); the title bar's B shows it.
    const action = await idOf(page, "Maya opens the fridge.");
    await page.evaluate((id) => (window as any).__app.editor.setSelection({ paragraphId: id, offset: 0 }, { paragraphId: id, offset: 4 }), action);
    await nativeKey(electronApp, "B", ["meta"]);
    await expect(page.locator(".editor-t-action strong")).toHaveText("Maya");
    expect(await ran(page, "editor.bold")).toBe(1);
    await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "false");
    // Playwright's keys go straight to the page; the editor runs them, also once.
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".editor-t-action em")).toHaveText("Maya");
    expect(await ran(page, "editor.italic")).toBe(1);
    await expect(page.getByRole("button", { name: "Italic" })).toHaveAttribute("aria-pressed", "true");
    // The toolbar buttons toggle them off again and keep the selection in the script.
    await page.getByRole("button", { name: "Bold" }).click();
    await page.getByRole("button", { name: "Italic" }).click();
    await expect(page.locator(".editor-t-action strong, .editor-t-action em")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => (window as any).__app.editor.getSelection())).toEqual(
      { anchor: { paragraphId: action, offset: 0 }, head: { paragraphId: action, offset: 4 } });

    // A third scene long enough to need a second page: the print feature's page breaks are drawn in the editor.
    const rain = await idOf(page, "Rain on the car.");
    await page.evaluate((id) => {
      const editor = (window as any).__app.editor;
      editor.setSelection({ paragraphId: id, offset: 16 });
      const lines = Array.from({ length: 40 }, (_, i) => ({ type: "action", text: `Water climbs the garage wall, line ${i + 1} of the long night.` }));
      editor.insertParagraphs([{ type: "sceneHeading", text: "INT. GARAGE - NIGHT" }, ...lines]);
    }, rain);
    await expect(page.locator(".editor-pm .editor-pagebreak").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".editor-pm .editor-pagebreak-number").first()).toHaveText("2.");

    // Proofreading underlines the misspelled cue in the editor; Accept fixes it as one undo step of its own, however
    // soon after the last edit it comes, and one Cmd+Z puts back exactly the script from before it.
    await page.evaluate(() => (window as any).__app.togglePanel("proofread", true));
    await expect(page.locator(".editor-pm .proofread-mark", { hasText: "MYA" })).toHaveCount(1);
    const steps = () => page.evaluate(() => {
      const undo = (window as any).__app.session.undo;
      return { undo: undo.undoStack.length as number, redo: undo.redoStack.length as number };
    });
    // Typing just before the click puts the fix inside the undo manager's 600 ms capture window, where it would
    // merge with the typing unless it starts a step of its own.
    await page.evaluate(() => (window as any).__app.editor.focus());
    await page.keyboard.type(" Dawn.");
    const beforeAccept = await rows(page);
    expect(beforeAccept.at(-1)).toEqual(["action", "Water climbs the garage wall, line 40 of the long night. Dawn."]);
    const stepsBefore = await steps();
    const finding = page.locator(".proofread-item", { hasText: "MYA" });
    await finding.getByRole("button", { name: /Accept/ }).click();
    await expect(page.locator(".editor-pm .proofread-mark", { hasText: "MYA" })).toHaveCount(0);
    const accepted = await rows(page);
    expect(accepted.filter(([type]) => type === "character").map(([, text]) => text)).toEqual(["MAYA", "MAYA", "MAYA"]);
    expect(accepted).toEqual(beforeAccept.map((row, i) => (i === 8 ? ["character", "MAYA"] : row)));
    expect(await steps()).toEqual({ undo: stepsBefore.undo + 1, redo: 0 });
    await page.evaluate(() => (window as any).__app.editor.focus());
    await page.keyboard.press("Meta+z");
    await expect.poll(() => rows(page)).toEqual(beforeAccept);
    expect(await steps()).toEqual({ undo: stepsBefore.undo, redo: 1 });
    await page.keyboard.press("Meta+Shift+z");
    await expect.poll(() => rows(page)).toEqual(accepted);
    expect(await steps()).toEqual({ undo: stepsBefore.undo + 1, redo: 0 });

    // The navigator: a click puts the caret at the start of that scene's heading.
    const yard = await idOf(page, "EXT. YARD - NIGHT");
    await page.locator(".navigator-row", { hasText: "EXT. YARD - NIGHT" }).click();
    await expect.poll(() => caret(page)).toEqual({ paragraphId: yard, offset: 0 });
    await expect(page.locator(".navigator-row.on")).toContainText("EXT. YARD - NIGHT");

    // Index cards: drag the yard card before the kitchen card; the script view shows the new order.
    const kitchen = await idOf(page, "INT. KITCHEN - NIGHT");
    const sceneOf = (id: string) => page.evaluate((heading) => (window as any).__app.session.doc.paragraph(heading).sceneId ?? heading, id);
    await page.evaluate(() => (window as any).__app.setView("cards"));
    const yardCard = page.locator(`.cards-card[data-scene-id="${await sceneOf(yard)}"]`);
    const kitchenCard = page.locator(`.cards-card[data-scene-id="${await sceneOf(kitchen)}"]`);
    const box = (await kitchenCard.boundingBox())!;
    await yardCard.dragTo(kitchenCard, { targetPosition: { x: 8, y: box.height / 2 } });
    await page.evaluate(() => (window as any).__app.setView("script"));
    await expect(page.locator(".editor-pm .editor-t-sceneHeading")).toHaveText(["EXT. YARD - NIGHT", "INT. KITCHEN - NIGHT", "INT. GARAGE - NIGHT"]);
    // One undo puts the scenes back.
    await runCommand(page, "editor.undo");
    await expect(page.locator(".editor-pm .editor-t-sceneHeading")).toHaveText(["INT. KITCHEN - NIGHT", "EXT. YARD - NIGHT", "INT. GARAGE - NIGHT"]);

    // Reports: a row click closes the dialog and reveals the scene in the editor.
    await runCommand(page, "reports.open");
    const reports = page.getByRole("dialog", { name: "Reports" });
    await reports.getByRole("tab", { name: "Scenes" }).click();
    await reports.locator("table.reports-table tbody tr", { hasText: "INT. GARAGE - NIGHT" }).click();
    await expect(reports).toBeHidden();
    const garage = await idOf(page, "INT. GARAGE - NIGHT");
    await expect.poll(() => caret(page)).toEqual({ paragraphId: garage, offset: 0 });

    // Compare with an earlier draft: the changes are highlighted in the editor until cleared.
    const earlier = join(folder, "earlier.fountain");
    writeFileSync(earlier, "INT. KITCHEN - NIGHT\n\nMaya opens the freezer.\n\nMAYA\nNothing here.\n");
    await answerDialogs(electronApp, { open: earlier });
    await runCommand(page, "compare.open");
    const compare = page.getByRole("dialog", { name: "Compare Drafts" });
    await compare.getByRole("button", { name: "Choose earlier draft…" }).click();
    await expect(compare.locator(".compare-summary")).toContainText("changed");
    await compare.getByRole("button", { name: "Highlight in script" }).click();
    await expect(compare).toBeHidden();
    await expect(page.locator(".editor-pm .compare-changed", { hasText: "fridge" })).toHaveCount(1);
    await expect(page.locator(".editor-pm .compare-added").first()).toBeVisible();
    await runCommand(page, "compare.clear");
    await expect(page.locator(".editor-pm .compare-changed, .editor-pm .compare-added")).toHaveCount(0);

    // Rename Character changes the cues and the mentions, and one undo takes it all back.
    await runCommand(page, "rename.open");
    const rename = page.getByRole("dialog", { name: "Rename Character" });
    await rename.getByRole("option", { name: /^MAYA/ }).click();
    await rename.getByLabel("New name").fill("Nora");
    await rename.getByRole("button", { name: "Rename" }).click();
    await expect(rename).toBeHidden();
    await expect(page.locator(".editor-pm .editor-t-character")).toHaveText(["NORA", "NORA", "NORA"]);
    await expect(page.locator(".editor-pm .editor-t-action").first()).toHaveText("Nora opens the fridge.");
    await runCommand(page, "editor.undo");
    await expect(page.locator(".editor-pm .editor-t-character")).toHaveText(["MAYA", "MAYA", "MAYA"]);
    await expect(page.locator(".editor-pm .editor-t-action").first()).toHaveText("Maya opens the fridge.");

    // Dictation: a take through the fake helper and model is inserted, formatted, at the caret.
    const helper = fakeSpeechHelper(folder, DICTATED);
    // The helper is granted through the native Choose dialog in main, as a writer would pick it.
    await electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
    }, helper);
    await page.evaluate(async (url) => {
      await (window as any).desktop.invoke("dictation:choose-helper");
      await (window as any).__app.setSetting("dictation.endpoint", url);
    }, model.endpoint);
    const sits = await idOf(page, "She sits.");
    await page.evaluate((id) => (window as any).__app.editor.setSelection({ paragraphId: id, offset: 9 }), sits);
    const wav = Array.from(encodeWav([new Float32Array(16000).fill(0.2)]));
    await page.evaluate((bytes) => (window as any).__dictation.processAudio(new Uint8Array(bytes)), wav);
    await expect(page.locator(".dictation-el")).toHaveCount(3);
    await page.getByRole("button", { name: "Insert 3 elements" }).click();
    const afterTake = await rows(page);
    const at = afterTake.findIndex(([, text]) => text === "She sits.");
    expect(afterTake.slice(at, at + 5)).toEqual([
      ["action", "She sits."], ["action", "Thunder rolls."], ["character", "NORA"], ["dialogue", "Let's go."], ["sceneHeading", "EXT. YARD - NIGHT"],
    ]);
    await expect(page.locator(".editor-pm .editor-t-dialogue", { hasText: "Let's go." })).toHaveCount(1);

    // Export Final Draft, then open the export: the same script, element for element.
    const fdx = join(folder, "day.fdx");
    await answerDialogs(electronApp, { save: fdx });
    await runCommand(page, "file.exportFdx");
    await expect.poll(() => existsSync(fdx)).toBe(true);
    const script = await rows(page);
    expect(parseFdx(readFileSync(fdx, "utf8")).paragraphs.map((p) => [p.type, plainText(p.runs)])).toEqual(script);
    const fromFdx = await openInNewWindow(electronApp, page, fdx);
    expect(await rows(fromFdx)).toEqual(script);
    await closeWindow(fromFdx);

    // Save as .screenplay and reopen it: the same script with the same paragraph IDs.
    const native = join(folder, "day.screenplay");
    await answerDialogs(electronApp, { save: native });
    await runCommand(page, "file.saveAs");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    const reopened = await openInNewWindow(electronApp, page, native);
    expect(await rows(reopened)).toEqual(script);
    expect(await ids(reopened)).toEqual(await ids(page));
    await closeWindow(reopened);

    expect(errors).toEqual([]);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);
  } finally {
    await close(electronApp, page);
    await model.close();
  }
});

test("a Final Draft script exported as Fountain keeps its title page", async () => {
  const folder = mkdtempSync(join(tmpdir(), "screenplay-workday-"));
  const { electronApp, page } = await launch();
  try {
    const fixture = fileURLToPath(new URL("../../../packages/engine/test/fixtures/synthetic.fdx", import.meta.url));
    await answerDialogs(electronApp, { open: fixture });
    await runCommand(page, "file.open");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.format)).toBe("fdx");
    // The title page lives in Final Draft's own XML; the document's own fields are empty.
    expect(await page.evaluate(() => (window as any).__app.session.script().titlePage)).toEqual([]);
    const fountain = join(folder, "keys.fountain");
    await answerDialogs(electronApp, { save: fountain });
    await runCommand(page, "file.exportFountain");
    await expect.poll(() => existsSync(fountain)).toBe(true);
    expect(readFileSync(fountain, "utf8")).toMatch(/^Title:\s*_?KEYS_?/m);
  } finally {
    await close(electronApp, page);
  }
});

test("a read-only session refuses local edits and says so in the editor", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.waitForSelector(".editor-pm");
    await page.evaluate(() => {
      const session = (window as any).__app.session;
      const id = session.script().paragraphs[0].id;
      session.edit(() => session.doc.insertText(id, 0, "INT. HALL - DAY"));
      session.setReadOnly(true);
    });
    await expect(page.locator(".editor-banner")).toContainText("Read-only");
    await expect(page.locator(".editor-pm")).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("button", { name: "Bold" })).toBeDisabled();
    // Typing, Enter and commands change nothing; session.edit itself refuses.
    await page.locator(".editor-pm").click();
    await page.keyboard.type("more");
    await page.keyboard.press("Enter");
    await runCommand(page, "editor.element.action");
    // Undo would take back the heading typed before the session became read-only; that is a local edit too.
    await runCommand(page, "editor.undo");
    expect(await rows(page)).toEqual([["sceneHeading", "INT. HALL - DAY"]]);
    const refused = await page.evaluate(() => {
      const session = (window as any).__app.session;
      try {
        session.edit(() => session.doc.insertText(session.script().paragraphs[0].id, 0, "X"));
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(refused).toBe("This script is read-only.");
    // Remote changes still arrive and are drawn.
    await page.evaluate(() => {
      const session = (window as any).__app.session;
      session.doc.ydoc.transact(() => session.doc.insertText(session.script().paragraphs[0].id, 15, " (LATER)"), "remote");
    });
    await expect(page.locator(".editor-pm .editor-t-sceneHeading")).toHaveText("INT. HALL - DAY (LATER)");
    // The outline shows its editing controls disabled, with a notice, rather than refusing after a click.
    await page.evaluate(() => (window as any).__app.setView("outline"));
    await expect(page.getByRole("button", { name: "Add section" })).toBeDisabled();
    await expect(page.locator(".structure-readonly")).toContainText("Read-only");
    expect(await rows(page)).toEqual([["sceneHeading", "INT. HALL - DAY (LATER)"]]);
    expect(errors).toEqual([]);
    await page.evaluate(() => (window as any).__app.setView("script"));
    // Back to editable: typing works again.
    await page.evaluate(() => (window as any).__app.session.setReadOnly(false));
    await expect(page.locator(".editor-banner")).toHaveCount(0);
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.editor.setSelection({ paragraphId: app.session.script().paragraphs[0].id, offset: 23 });
      app.editor.focus();
    });
    await page.keyboard.type("!");
    expect((await rows(page))[0]).toEqual(["sceneHeading", "INT. HALL - DAY (LATER)!"]);
  } finally {
    await close(electronApp, page);
  }
});

test("a read-only script disables Rename, and an edit refused from any click shows a toast, not a silent failure", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.waitForSelector(".editor-pm");
    const script: Row[] = [["sceneHeading", "INT. SHED - DAY"], ["character", "VERN"], ["dialogue", "Gone."]];
    await page.evaluate((script) => {
      const session = (window as any).__app.session;
      session.doc.load({ titlePage: [], paragraphs: script.map(([type, text], i) => ({ id: `p${i}`, type, runs: [{ text }] })) });
      session.setReadOnly(true);
    }, script);
    // The command is disabled; the dialog, opened anyway, says why and keeps Rename off.
    await runCommand(page, "rename.open");
    const dialog = page.getByRole("dialog", { name: "Rename Character" });
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => (window as any).__app.openModal("rename.main"));
    await dialog.getByRole("option", { name: /^VERN/ }).click();
    await expect(dialog.getByLabel("New name")).toBeDisabled();
    await expect(dialog.locator(".rename-preview")).toContainText("This script is read-only.");
    await expect(dialog.getByRole("button", { name: "Rename" })).toBeDisabled();
    await page.keyboard.press("Escape");
    // A feature's own click handler that still tries an edit gets the window-wide toast.
    await page.evaluate(() => {
      const session = (window as any).__app.session;
      setTimeout(() => session.edit(() => session.doc.insertText("p2", 0, "Long ")), 0);
    });
    await expect(page.locator(".toast", { hasText: "This script is read-only." }).first()).toBeVisible();
    expect(await rows(page)).toEqual(script);
    expect(errors).toEqual([]);
  } finally {
    await close(electronApp, page);
  }
});
