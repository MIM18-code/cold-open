import { _electron as electron, expect, test } from "@playwright/test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("a save that fails while closing shows the error and the window can still close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const native = join(dir, "Kitchen.screenplay");
  const { electronApp, page } = await launch();
  const windows = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  try {
    await page.evaluate(write);
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
    }, native);
    await page.evaluate(() => (window as any).__app.runCommand("file.saveAs"));
    await expect.poll(() => existsSync(native)).toBe(true);
    // A read-only file in a read-only folder: the next save fails with EACCES.
    chmodSync(native, 0o444); chmodSync(dir, 0o555);
    await page.evaluate(() => {
      const s = (window as any).__app.session;
      s.edit(() => s.doc.insertText(s.doc.toScript().paragraphs[1].id, 0, "Later, "));
    });
    await electronApp.evaluate(() => { (globalThis as any).e2eMessageBox = () => 0; });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect(page.locator(".toast.toast-error")).toHaveCount(1);
    expect(await windows()).toBe(1);
    // Don't Save on the next try closes the window instead of being ignored.
    await electronApp.evaluate(() => { (globalThis as any).e2eMessageBox = () => 1; });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(windows).toBe(0);
  } finally {
    chmodSync(dir, 0o755); chmodSync(native, 0o644);
    // A window stuck in a close request would also stop the app from quitting.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
    await electronApp.close();
  }
});

test("a window whose renderer crashed during a close request can close after it reloads", async () => {
  const { electronApp, page } = await launch();
  const windows = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  try {
    await page.evaluate(write);
    // The "This window stopped working" sheet answers Reload straight away.
    await electronApp.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any; });
    // Count renderer-ready calls, so the second close goes through the reloaded page, not the not-loaded-yet path.
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis as any;
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: unknown[]) => unknown>;
      const original = handlers.get("shell:renderer-ready")!;
      g.readyCalls = 0;
      handlers.set("shell:renderer-ready", (...args: unknown[]) => { const result = original(...args); g.readyCalls++; return result; });
    });
    const loaded = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const reloaded = new Promise<void>((done) => window.webContents.once("did-finish-load", () => done()));
      window.close();
      window.webContents.forcefullyCrashRenderer();
      return reloaded.then(() => true);
    });
    expect(loaded).toBe(true);
    // Playwright's page stays crashed after the reload, so ask the main process whether the new page is ready.
    await expect.poll(() => electronApp.evaluate(() => (globalThis as any).readyCalls)).toBe(1);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(windows).toBe(0);
  } finally {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
    await electronApp.close();
  }
});

for (const [choice, button] of [["Save", 0], ["Don't Save", 1]] as const) {
  test(`closing with ${choice} while a backup is being written waits for it and leaves no recovery copy`, async () => {
    test.setTimeout(120_000);
    const { electronApp, page, userData } = await launch();
    const windows = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const flag = (name: string) => electronApp.evaluate((_electron, key) => (globalThis as any)[key], name);
    const native = join(mkdtempSync(join(tmpdir(), "screenplay-file-")), "Kitchen.screenplay");
    try {
      await page.evaluate(write);
      // Hold the next backup write open in the main process until the test releases it.
      await electronApp.evaluate(({ dialog, ipcMain }, path) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
        const g = globalThis as any;
        const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: unknown[]) => unknown>;
        const original = handlers.get("files:write")!;
        g.backupStarted = false; g.backupDone = false;
        handlers.set("files:write", async (event: unknown, ...args: unknown[]) => {
          if (!String(args[0]).includes("/autosave/")) return original(event, ...args);
          g.backupStarted = true;
          await new Promise<void>((done) => { g.releaseBackup = done; });
          try { return await original(event, ...args); } finally { g.backupDone = true; }
        });
      }, native);
      await expect.poll(() => flag("backupStarted"), { timeout: 45_000 }).toBe(true);
      await electronApp.evaluate((_electron, answer) => { (globalThis as any).e2eMessageBox = () => answer; }, button);
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      if (choice === "Save") await expect.poll(() => existsSync(native)).toBe(true);
      await new Promise((done) => setTimeout(done, 500));
      // The window waits for the write before it removes the copy and closes.
      expect(await windows()).toBe(1);
      await electronApp.evaluate(() => (globalThis as any).releaseBackup());
      await expect.poll(windows).toBe(0);
      await expect.poll(() => flag("backupDone")).toBe(true);
      expect(readdirSync(join(userData, "autosave")).filter((name) => name.endsWith(".screenplay"))).toEqual([]);
    } finally {
      await electronApp.evaluate(() => (globalThis as any).releaseBackup?.());
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
      await electronApp.close();
    }
  });
}

test("a recovered script keeps its title, and Save clears the recovery status", async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const native = join(dir, "Kitchen.screenplay");
  const first = await launch();
  try {
    await first.page.evaluate(write);
    // The 30-second backup runs first, so the status has an old "saved" entry for Save to clear.
    await expect(first.page.locator(".recovery-health")).toHaveText("Recovery copy saved", { timeout: 45_000 });
    await first.electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
    }, native);
    await first.page.evaluate(() => { (window as any).__app.session.name = "Night Kitchen"; });
    await first.page.evaluate(() => (window as any).__app.runCommand("file.saveAs"));
    await expect.poll(() => first.page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    await first.page.evaluate(() => {
      const s = (window as any).__app.session;
      s.edit(() => s.doc.insertText(s.doc.toScript().paragraphs[1].id, 0, "Later, "));
    });
    await expect(first.page.locator(".recovery-health")).toHaveText("Recovery pending");
  } finally {
    await close(first.electronApp, first.page);
  }
  // A backup is named by session ID; the saved file has the same header a backup would.
  copyFileSync(native, join(first.userData, "autosave", "0b5c43a2-5d0e-4c55-9d1f-2f6a4a3c9e11.screenplay"));
  const second = await launch([], first.userData);
  try {
    await second.page.getByRole("dialog", { name: "Recover unsaved scripts" }).getByRole("button", { name: /Night Kitchen/ }).click();
    await expect(second.page.locator(".titlebar-name")).toHaveAttribute("title", "Night Kitchen (recovered)");
  } finally {
    await close(second.electronApp, second.page);
  }
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

test("wrong-shaped values in the shared document do not blank the editor or stop Save and Export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-file-"));
  const { electronApp, page } = await launch();
  try {
    await page.evaluate(write);
    // What a co-writer with the write key, or a sent .screenplay file, can put in the synced metadata.
    await page.evaluate(() => {
      const doc = (window as any).__app.session.doc;
      doc.ydoc.transact(() => {
        doc.meta.set("fdx", { rootAttrs: [], contentAttrs: [], before: 7, after: [{ name: "a b=\"x\"><Evil/", attrs: [], children: [] }] });
        doc.meta.set("revisions", { sets: 5 });
        doc.meta.set("pageLocks", { pages: "x" });
        doc.meta.set("titlePage", "not a list");
        doc.meta.set("sceneNumbersLocked", { yes: 1 });
      }, "a co-writer");
    });
    // The editor still shows the script and still takes typing.
    await expect(page.locator(".ProseMirror")).toContainText("Maya stands at the sink.");
    await page.evaluate(() => {
      const s = (window as any).__app.session;
      const last = s.doc.toScript().paragraphs.at(-1).id;
      s.edit(() => s.doc.insertText(last, 0, "Later, "));
    });
    await expect(page.locator(".ProseMirror")).toContainText("Later, Maya stands at the sink.");

    for (const [command, name, expected] of [
      ["file.saveAs", "Kitchen.screenplay", null], ["file.exportFdx", "Kitchen.fdx", "Later, Maya stands at the sink."],
      ["file.exportFountain", "Kitchen.fountain", "Later, Maya stands at the sink."],
    ] as const) {
      const path = join(dir, name);
      await electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as any;
      }, path);
      await page.evaluate((id) => (window as any).__app.runCommand(id), command);
      await expect.poll(() => existsSync(path), { message: name }).toBe(true);
      if (expected) expect(readFileSync(path, "utf8")).toContain(expected);
    }
    expect(readFileSync(join(dir, "Kitchen.fdx"), "utf8")).not.toContain("Evil");
    await expect(page.locator(".toast.toast-error")).toHaveCount(0);
  } finally {
    await close(electronApp, page);
  }
});
