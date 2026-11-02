import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { close, launch } from "./helpers.ts";

const write = `
  const s = window.__app.session;
  s.edit(() => {
    const doc = s.doc;
    const first = doc.toScript().paragraphs[0].id;
    doc.insertText(first, 0, "INT. KITCHEN - NIGHT");
    const action = doc.splitParagraph(first, 20, "action");
    doc.insertText(action, 0, "Maya stands at the sink.");
  });
`;

test("save, reopen and export keep the script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const { electronApp, page } = await launch();
  await page.evaluate(write);
  expect(await page.evaluate(() => (window as any).__app.session.dirty)).toBe(true);

  const native = join(dir, "Kitchen.screenplay");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
  }, native);
  await page.evaluate(() => (window as any).__app.runCommand("file.saveAs"));
  await expect.poll(() => existsSync(native)).toBe(true);
  expect(readFileSync(native).subarray(0, 8).toString()).toBe("SCRNPLY1");
  expect(await page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
  await expect(page.locator(".titlebar-name")).toHaveText("Kitchen");

  const fdx = join(dir, "Kitchen.fdx");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
  }, fdx);
  await page.evaluate(() => (window as any).__app.runCommand("file.exportFdx"));
  await expect.poll(() => existsSync(fdx)).toBe(true);
  const xml = readFileSync(fdx, "utf8");
  expect(xml).toContain("INT. KITCHEN - NIGHT");
  expect(xml).toContain('Type="Action"');
  await electronApp.close();

  // Reopen the FDX in a fresh app: the text and types come back, and the window is clean.
  const second = await launch([fdx]);
  await expect(second.page.locator(".titlebar-name")).toHaveText("Kitchen");
  const types = await second.page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => p.type));
  expect(types).toEqual(["sceneHeading", "action"]);
  expect(await second.page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
  await second.electronApp.close();
});

test("FDX export keeps a scene's synopsis and says what it leaves out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const { electronApp, page } = await launch();
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "act", type: "section", depth: 1, runs: [{ text: "ACT ONE" }] },
      { id: "h", type: "sceneHeading", runs: [{ text: "INT. KITCHEN - NIGHT" }] },
      { id: "s", type: "synopsis", runs: [{ text: "Maya decides." }] },
      { id: "a", type: "action", runs: [{ text: "Maya stands at the sink." }] },
    ] }));
  });
  const fdx = join(dir, "Kitchen.fdx");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
  }, fdx);
  await page.evaluate(() => (window as any).__app.runCommand("file.exportFdx"));
  await expect.poll(() => existsSync(fdx)).toBe(true);
  expect(readFileSync(fdx, "utf8")).toContain("Maya decides.");
  await expect(page.locator(".toast").first())
    .toHaveText("Final Draft can't hold 1 item (notes, sections or synopses outside a scene heading); they were left out.");
  await close(electronApp, page);
});

test("Save keeps an omitted scene in a Fountain file, and Restore brings it back after reopening (final review #3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const path = join(dir, "Omit.fountain");
  writeFileSync(path, "INT. A - DAY\n\nAction one.\n\nEXT. B - NIGHT\n\nSecret middle scene text.\n\nBOB\nHello there.\n\nINT. C - DAY\n\nEnd.\n");
  const outline = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__app.session.doc.paragraphs()
    .map((p: any) => `${p.type} ${p.runs.map((r: any) => r.text).join("")}`));
  const caretOn = (page: import("@playwright/test").Page, text: string) => page.evaluate((heading) => {
    const app = (window as any).__app;
    const paragraph = app.session.doc.paragraphs().find((p: any) => p.runs.map((r: any) => r.text).join("") === heading);
    app.editor.focus();
    app.editor.setSelection({ paragraphId: paragraph.id, offset: 0 });
  }, text);

  const first = await launch([path]);
  await first.page.waitForSelector(".editor-pm");
  const before = await outline(first.page);
  await caretOn(first.page, "EXT. B - NIGHT");
  await first.page.evaluate(() => (window as any).__app.runCommand("revisions.omitScene"));
  expect((await outline(first.page)).filter((line) => line.startsWith("sceneHeading"))).toEqual(
    ["sceneHeading INT. A - DAY", "sceneHeading OMITTED", "sceneHeading INT. C - DAY"]);
  await first.page.evaluate(() => (window as any).__app.runCommand("file.save"));
  await expect.poll(() => readFileSync(path, "utf8")).toContain("Secret middle scene text.");
  await close(first.electronApp, first.page);

  const second = await launch([path]);
  await second.page.waitForSelector(".editor-pm");
  await caretOn(second.page, "OMITTED");
  await second.page.evaluate(() => (window as any).__app.runCommand("revisions.restoreScene"));
  expect(await outline(second.page)).toEqual(before);
  await close(second.electronApp, second.page);
});

test("a pasted control character never stops a saved FDX from opening, and junk after </FinalDraft> is ignored (final review #2, #6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const path = join(dir, "Damaged.fdx");
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Scene Heading" id="h"><Text>INT. KITCHEN - NIGHT</Text></Paragraph>
    <Paragraph Type="Action" id="a"><Text>Maya stands at the sink.</Text></Paragraph>
  </Content>
</FinalDraft>
alDraft>
`);
  const first = await launch([path]);
  await expect(first.page.locator(".titlebar-name")).toHaveText("Damaged");
  await expect(first.page.locator(".toast", { hasText: "Opened with 1 repair" })).toHaveCount(1);
  await first.page.evaluate(() => {
    const s = (window as any).__app.session;
    // What a paste from a word processor leaves: a vertical tab where it had a line break.
    s.edit(() => s.doc.insertText("a", 24, "\u000BShe waits."));
  });
  await first.page.evaluate(() => (window as any).__app.runCommand("file.save"));
  await expect(first.page.locator(".toast", { hasText: "control character" })).toHaveCount(1);
  await expect.poll(() => readFileSync(path, "utf8")).toContain("Maya stands at the sink. She waits.");
  expect(readFileSync(path, "utf8")).not.toContain("\u000B");
  expect(readFileSync(path, "utf8").endsWith("</FinalDraft>\n")).toBe(true);
  await close(first.electronApp, first.page);

  const second = await launch([path]);
  await expect(second.page.locator(".titlebar-name")).toHaveText("Damaged");
  const texts = await second.page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join("")));
  expect(texts).toEqual(["INT. KITCHEN - NIGHT", "Maya stands at the sink. She waits."]);
  await expect(second.page.locator(".toast", { hasText: "Opened with" })).toHaveCount(0);
  await close(second.electronApp, second.page);
});

test("closing with unsaved changes asks, and Cancel keeps the window", async () => {
  const { electronApp, page } = await launch();
  await page.evaluate(write);
  await electronApp.evaluate(() => {
    (globalThis as any).asked = 0;
    (globalThis as any).e2eMessageBox = () => ((globalThis as any).asked++, 2);
  });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => electronApp.evaluate(() => (globalThis as any).asked)).toBe(1);
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  // Don't Save lets it close.
  await electronApp.evaluate(() => {
    (globalThis as any).e2eMessageBox = () => 1;
  });
  await electronApp.close();
});

test("an opened script shows its proofreading marks before any edit, and keeps them while typing elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const path = join(dir, "Marks.fountain");
  writeFileSync(path, "INT. ROOM - DAY\n\nNell sees the the dog.\n\nRain falls.\n");
  const { electronApp, page } = await launch();
  try {
    await page.evaluate(() => (window as any).__app.togglePanel("proofread", true));
    await electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any;
    }, path);
    await page.evaluate(() => (window as any).__app.runCommand("file.open"));
    await expect(page.locator(".titlebar-name")).toHaveText("Marks");
    await expect(page.locator(".proofread-item")).toHaveCount(1);
    await expect(page.locator(".editor-pm .proofread-mark")).toHaveText(["the the"]);
    // An edit to another paragraph finds the same thing; the mark stays.
    await page.evaluate(() => {
      const session = (window as any).__app.session;
      const last = session.script().paragraphs.at(-1).id;
      session.edit(() => session.doc.insertText(last, 0, "Cold "));
    });
    await page.waitForTimeout(800);
    await expect(page.locator(".editor-pm .proofread-mark")).toHaveText(["the the"]);
  } finally {
    await close(electronApp, page);
  }
});

test("Open Recent reaches a chosen script after a restart, and a page cannot add a file it was never given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const userData = mkdtempSync(join(tmpdir(), "screenplay-e2e-"));
  const script = join(dir, "Chosen.fountain");
  const secret = join(dir, "Private.fountain");
  writeFileSync(script, "INT. ROOM - DAY\n\nMaya waits.\n");
  writeFileSync(secret, "INT. VAULT - NIGHT\n\nNot for the page.\n");
  const start = async () => {
    const electronApp = await electron.launch({
      args: [join(import.meta.dirname, ".."), `--user-data-dir=${userData}`],
      env: { ...process.env, SCREENPLAY_E2E: "1" },
    });
    const page = await electronApp.firstWindow();
    await page.waitForSelector(".shell");
    return { electronApp, page };
  };
  const invoke = (page: import("@playwright/test").Page, channel: string, ...args: unknown[]) =>
    page.evaluate(([c, a]) => (window as any).desktop.invoke(c, ...(a as unknown[])).then((value: unknown) => ({ value }), (error: Error) => ({ error: String(error.message ?? error) })), [channel, args] as const);

  let run = await start();
  try {
    await run.electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any;
    }, script);
    await run.page.evaluate(() => (window as any).__app.runCommand("file.open"));
    await expect(run.page.locator(".titlebar-name")).toHaveText("Chosen");
    expect((await invoke(run.page, "files:add-recent", secret)).error).toMatch(/not opened through the app/);
    expect((await invoke(run.page, "files:recent")).value).toEqual([script]);
  } finally {
    await close(run.electronApp, run.page);
  }

  run = await start();
  try {
    expect((await invoke(run.page, "files:recent")).value).toEqual([script]);
    expect((await invoke(run.page, "files:read", secret)).error).toMatch(/not opened through the app/);
    const opened = await invoke(run.page, "files:read", script);
    expect((opened.value as { name: string }).name).toBe("Chosen.fountain");
  } finally {
    await close(run.electronApp, run.page);
  }
});

test("external edits are protected: Save does not overwrite them and Save Copy keeps both versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-conflict-"));
  const original = join(dir, "Shared.fountain");
  const copy = join(dir, "My version.fountain");
  writeFileSync(original, "INT. ROOM - DAY\n\nOriginal text.\n");
  const { electronApp, page } = await launch([original]);
  await expect(page.locator(".titlebar-name")).toHaveText("Shared");
  await page.evaluate(() => {
    const s = (window as any).__app.session;
    s.edit(() => {
      const p = s.doc.paragraphs().find((p: any) => p.type === "action");
      s.doc.insertText(p.id, 0, "Writer's change. ");
    });
  });
  expect(await page.evaluate(() => (window as any).__app.session.dirty)).toBe(true);
  // Simulate a second editor (or cloud-synced replacement) changing the on-disk bytes.
  writeFileSync(original, "EXT. ROAD - NIGHT\n\nExternal revision.\n");
  await electronApp.evaluate(() => {
    (globalThis as any).conflictPrompts = 0;
    (globalThis as any).e2eMessageBox = () => { (globalThis as any).conflictPrompts++; return 2; };
  });
  await page.evaluate(() => (window as any).__app.runCommand("file.save"));
  expect(readFileSync(original, "utf8")).toContain("External revision.");
  expect(readFileSync(original, "utf8")).not.toContain("Writer's change.");
  expect(await page.evaluate(() => (window as any).__app.session.dirty)).toBe(true);
  expect(await electronApp.evaluate(() => (globalThis as any).conflictPrompts)).toBe(1);
  await electronApp.evaluate(({ dialog }, path) => {
    (globalThis as any).e2eMessageBox = () => 0;
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
  }, copy);
  await page.evaluate(() => (window as any).__app.runCommand("file.save"));
  await expect.poll(() => existsSync(copy)).toBe(true);
  expect(readFileSync(copy, "utf8")).toContain("Writer's change.");
  expect(readFileSync(original, "utf8")).toContain("External revision.");
  await close(electronApp, page);
});

test("the scene number lock survives FDX export and reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-lock-"));
  const { electronApp, page } = await launch();
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h1", type: "sceneHeading", sceneNumber: "1", runs: [{ text: "INT. KITCHEN - NIGHT" }] },
      { id: "h2", type: "sceneHeading", sceneNumber: "2", runs: [{ text: "EXT. YARD - DAY" }] },
    ] }));
    app.session.undo.clear();
  });
  await page.evaluate(() => (window as any).__app.runCommand("revisions.lockScenes"));

  const fdx = join(dir, "Locked.fdx");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
  }, fdx);
  await page.evaluate(() => (window as any).__app.runCommand("file.exportFdx"));
  await expect.poll(() => existsSync(fdx)).toBe(true);
  const xml = readFileSync(fdx, "utf8");
  expect(xml).toContain('ColdOpenSceneNumbersLocked="Yes"');
  expect(xml).toContain("ColdOpenLockedScenes=\"[[&quot;h1&quot;,&quot;1&quot;]");
  await electronApp.close();

  // Reopened, the draft is still locked: Remove Scene Numbers refuses.
  const second = await launch([fdx]);
  await expect(second.page.locator(".titlebar-name")).toHaveText("Locked");
  await second.page.evaluate(() => (window as any).__app.runCommand("structure.removeSceneNumbers"));
  await expect(second.page.locator(".toast", { hasText: "Scene numbers are locked. Unlock them first." })).toHaveCount(1);
  await second.electronApp.close();
});
