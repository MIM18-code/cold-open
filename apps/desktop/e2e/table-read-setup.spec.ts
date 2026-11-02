import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { close, launch, runCommand } from "./helpers.ts";

// Stub the download boundary in main. No model URL is requested by these tests.
async function stubPacks(app: ElectronApplication, lowMemory = false) {
  await app.evaluate(({ ipcMain }, low) => {
    const state = { calls: 0, cancelled: 0, mode: "wait", kept: false, pending: false, previews: 0, consent: false, keeps: 0, failBind: false, binds: 0, bound: false, discards: 0, holdKeep: false, finishKeep: undefined as (() => void) | undefined, acknowledgedPack: undefined as string | undefined };
    (globalThis as any).voiceSetupFixture = state;
    const packs = [
      { id: "phonon", engine: "phonon", label: "Phonon fixture", installed: false },
      { id: "qwen-design", engine: "qwen-design", label: "Qwen VoiceDesign fixture", installed: true },
      { id: "qwen-base-06b", engine: "qwen", label: "Qwen Base fixture", installed: true },
    ].map((p) => ({ ...p, sizeBytes: 1048576, diskBytes: p.installed ? 1048576 : 0, memoryGB: 16,
      minimumMacOS: 15, license: "apache-2.0", licenseUrls: ["https://www.apache.org/licenses/LICENSE-2.0"], provenance: "Synthetic test fixture", revision: ["a".repeat(40)] }));
    (globalThis as any).voiceSetupPacks = packs;
    const status = () => ({ memoryGB: low ? 8 : 32, cacheBytes: 0, models: packs, engines: ["system", "phonon", "qwen"].map((id) => ({ id, label: id, available: true,
      ready: id !== "phonon" || packs[0]!.installed, note: "Fixture", tier: "Local", voices: id === "qwen" && state.kept
        ? [{ id: "designed-fixture", label: "MAYA", language: "en" }] : [{ id: "fixture", label: "Fixture voice", language: "en" }] })) });
    const handle = (name: string, fn: (...args: any[]) => unknown) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn); };
    handle("table-read:models", () => packs);
    handle("table-read:status", status);
    handle("table-read:prepare", (_event, _engine, _consent, acknowledgedPack) => { state.acknowledgedPack = acknowledgedPack; return status(); });
    let cancel: (() => void) | undefined;
    handle("table-read:install", async (event, id, consent, allow) => {
      if (consent !== true) throw new Error("Missing consent");
      state.calls++; state.consent = allow;
      const pack = packs.find((p) => p.id === id)!;
      pack.diskBytes = 524288;
      event.sender.send("table-read:model-progress", { packId: id, completedBytes: 524288, totalBytes: pack.sizeBytes });
      if (state.mode === "fail") throw new Error("Voice checksum mismatch. The model will not be loaded.");
      if (state.mode === "wait") await new Promise<void>((_resolve, reject) => { cancel = () => reject(new Error("Download cancelled")); });
      pack.installed = true; pack.diskBytes = pack.sizeBytes; return packs;
    });
    handle("table-read:cancel", () => { state.cancelled++; cancel?.(); cancel = undefined; });
    handle("table-read:remove", (_event, id) => { const p = packs.find((p) => p.id === id)!; p.installed = false; p.diskBytes = 0; return packs; });
    handle("table-read:design-voice", async (_event, input) => {
      if (input.action === "discard") { state.discards++; state.pending = false; return; }
      if (input.action === "bind") { state.binds++; if (state.failBind) throw new Error("ENOSPC: no space left on device"); state.bound = true; state.kept = true; state.pending = false; return; }
      if (input.action === "keep") {
        state.keeps++;
        if (state.holdKeep) await new Promise<void>((resolve) => { state.finishKeep = resolve; });
        state.pending = true; return { id: "designed-fixture", label: "MAYA", language: "en", engine: "qwen" };
      }
      state.previews++;
      if (!input.provenance.includes("Private; do not share")) throw new Error("Private provenance missing");
      const b = Buffer.alloc(48044); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
      b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
      b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(48000, 40);
      return { id: "preview-fixture", audio: new Uint8Array(b) };
    });
  }, lowMemory);
}

test("pack confirmation, progress, cancel, resume, verification retry and removal", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    await runCommand(run.page, "localFeatures.open");
    const pack = run.page.getByRole("region", { name: "Phonon fixture", exact: true });
    await pack.getByRole("button", { name: "Install…", exact: true }).click();
    await expect(pack.getByRole("group", { name: "Confirm Phonon fixture download" })).toContainText("1.0 MB (apache-2.0)");
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.calls)).toBe(0);
    await pack.getByRole("button", { name: "Confirm download" }).click();
    await expect(pack.getByRole("progressbar")).toHaveAttribute("value", "524288");
    await pack.getByRole("button", { name: "Cancel download" }).click();
    await expect(pack.getByRole("alert")).toContainText("cancelled");
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.mode = "fail"; });
    await pack.getByRole("button", { name: "Retry…", exact: true }).click();
    await pack.getByRole("button", { name: "Confirm download" }).click();
    await expect(pack.getByRole("alert")).toContainText("checksum mismatch");
    await expect(pack).toContainText("Incomplete");
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.mode = "success"; });
    await pack.getByRole("button", { name: "Retry…", exact: true }).click();
    await pack.getByRole("button", { name: "Confirm download" }).click();
    await expect(pack).toContainText("Installed");
    await pack.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(pack.getByRole("button", { name: "Install…", exact: true })).toBeVisible();
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.calls)).toBe(3);
  } finally { await close(run.electronApp, run.page); }
});

test("low memory requires a separate explicit warning acknowledgement", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp, true);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.mode = "success"; });
    await runCommand(run.page, "localFeatures.open");
    const pack = run.page.getByRole("region", { name: "Phonon fixture", exact: true });
    await expect(pack).toContainText("This Mac has 8 GB");
    await pack.getByRole("button", { name: "Install…", exact: true }).click();
    await expect(pack.getByRole("button", { name: "Confirm download" })).toBeDisabled();
    await pack.getByRole("checkbox", { name: "Install anyway with less memory" }).check();
    await pack.getByRole("button", { name: "Confirm download" }).click();
    await expect(pack).toContainText("Installed");
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.consent)).toBe(true);
  } finally { await close(run.electronApp, run.page); }
});

test("voice design auditions regenerate before an explicit save binds Qwen Base", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    await run.page.evaluate(() => (window as any).__app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "s", type: "sceneHeading", sceneId: "s", runs: [{ text: "INT. DINER - NIGHT" }] },
      { id: "m", type: "character", runs: [{ text: "MAYA" }] },
      { id: "d", type: "dialogue", runs: [{ text: "Wait here." }] },
    ] }));
    await runCommand(run.page, "tableRead.open");
    await run.page.getByRole("button", { name: "Design a voice for MAYA" }).click();
    const dialog = run.page.getByRole("dialog");
    await dialog.getByLabel("Voice description").fill("Gravelly older woman, tired, Boston");
    await dialog.getByRole("button", { name: "Generate audition", exact: true }).click();
    await expect(dialog.getByLabel("Designed voice audition")).toBeVisible();
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.kept)).toBe(false);
    await dialog.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(run.page.getByLabel("Voice engine", { exact: true })).toHaveValue("qwen");
    await expect(run.page.getByLabel("Voice for MAYA", { exact: true })).toHaveValue("designed-fixture");
    await expect(run.page.getByLabel("Lock MAYA", { exact: true })).toBeChecked();
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.previews)).toBe(2);
  } finally { await close(run.electronApp, run.page); }
});


async function openDesign(page: Page) {
  await page.evaluate(() => (window as any).__app.session.doc.load({ titlePage: [], paragraphs: [
    { id: "s", type: "sceneHeading", sceneId: "s", runs: [{ text: "INT. DINER - NIGHT" }] },
    { id: "m", type: "character", runs: [{ text: "MAYA" }] },
    { id: "d", type: "dialogue", runs: [{ text: "Wait here." }] },
  ] }));
  await runCommand(page, "tableRead.open");
  await page.getByRole("button", { name: "Design a voice for MAYA" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Voice description").fill("Gravelly adult alto");
  await dialog.getByRole("button", { name: "Generate audition", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeEnabled();
  return dialog;
}

async function changeCast(page: Page, field: string, value: string | boolean) {
  await page.evaluate(({ field, value }) => {
    const app = (window as any).__app;
    app.session.edit(() => {
      app.session.doc.meta.set(`tableRead.cast.v3.character.${JSON.stringify(["m", "name"])}`, "MAYA");
      app.session.doc.meta.set(`tableRead.cast.v3.character.${JSON.stringify(["m", field])}`, value);
    });
  }, { field, value });
}

for (const field of ["voice.qwen", "locked"]) test(`Keep asks before replacing a concurrent ${field} change`, async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    const dialog = await openDesign(run.page);
    await changeCast(run.page, field, field === "locked" ? true : "another-writer-voice");
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeEnabled();
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.keeps)).toBe(0);
    await run.electronApp.evaluate(() => { (globalThis as any).e2eMessageBox = () => 0; });
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.bound)).toBe(true);
    await expect(run.page.getByLabel("Voice for MAYA", { exact: true })).toHaveValue("designed-fixture");
  } finally { await close(run.electronApp, run.page); }
});

test("a cast change during Keep is confirmed again and declining discards the saved reference", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    const dialog = await openDesign(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.holdKeep = true; });
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.keeps)).toBe(1);
    await changeCast(run.page, "voice.qwen", "another-writer-voice");
    await changeCast(run.page, "locked", true);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.finishKeep(); });
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.discards)).toBe(1);
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.kept)).toBe(false);
    expect(await run.page.evaluate(() => (window as any).__app.session.doc.meta.get(`tableRead.cast.v3.character.${JSON.stringify(["m", "voice.qwen"])}`))).toBe("another-writer-voice");
    await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeDisabled();
  } finally { await close(run.electronApp, run.page); }
});

test("a binding refusal after saving discards the reference", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    const dialog = await openDesign(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.holdKeep = true; });
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.keeps)).toBe(1);
    await run.page.evaluate(() => (window as any).__app.session.setReadOnly(true));
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.finishKeep(); });
    await expect(dialog.getByRole("alert")).toContainText("read-only");
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.discards)).toBe(1);
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.kept)).toBe(false);
  } finally { await close(run.electronApp, run.page); }
});

test("VoiceDesign sends the exact pack in its memory acknowledgement", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp, true);
    await run.electronApp.evaluate(() => { (globalThis as any).e2eMessageBox = () => 0; });
    await openDesign(run.page);
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.acknowledgedPack)).toBe("qwen-design");
  } finally { await close(run.electronApp, run.page); }
});

test("pack broadcasts refresh Local features and playback in another window", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    await run.page.evaluate(() => (window as any).__app.setSetting("tableRead.engine", "phonon"));
    await runCommand(run.page, "tableRead.open");
    await expect(run.page.getByRole("button", { name: "Set up voice packs…", exact: true })).toBeVisible();
    const opening = run.electronApp.waitForEvent("window");
    await run.page.evaluate(() => (window as any).desktop.invoke("shell:new-window"));
    const other = await opening; await other.waitForSelector(".shell");
    await runCommand(other, "localFeatures.open");
    const pack = other.getByRole("region", { name: "Phonon fixture", exact: true });
    await expect(pack.getByRole("button", { name: "Install…", exact: true })).toBeVisible();
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      const p = (globalThis as any).voiceSetupPacks[0]; p.installed = true; p.diskBytes = p.sizeBytes;
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("table-read:models-changed");
    });
    await expect(pack).toContainText("Installed");
    await expect(run.page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      const p = (globalThis as any).voiceSetupPacks[0]; p.installed = false; p.diskBytes = 0;
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("table-read:models-changed");
    });
    await expect(pack.getByRole("button", { name: "Install…", exact: true })).toBeVisible();
    await expect(run.page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
    await expect(run.page.getByRole("button", { name: "Set up voice packs…", exact: true })).toBeVisible();
    await other.evaluate(() => { (window as any).__app.session.dirty = false; });
  } finally { await close(run.electronApp, run.page); }
});


test("closing during Keep cleans up a saved reference that arrives after unmount", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    const dialog = await openDesign(run.page);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.holdKeep = true; });
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.keeps)).toBe(1);
    await dialog.getByRole("button", { name: "Cancel generation", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.discards)).toBe(1);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.finishKeep(); });
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.discards)).toBe(2);
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.kept)).toBe(false);
  } finally { await close(run.electronApp, run.page); }
});

for (const beforeGeneration of [false, true]) test(`Keep confirms a cast change ${beforeGeneration ? "before first generation" : "across regeneration"}`, async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    const dialog = await openDesign(run.page);
    if (beforeGeneration) {
      await dialog.getByRole("button", { name: "Discard", exact: true }).click();
      await run.page.getByRole("button", { name: "Design a voice for MAYA" }).click();
      await dialog.getByLabel("Voice description").fill("Gravelly adult alto");
    }
    await changeCast(run.page, "voice.qwen", "another-writer-voice");
    await changeCast(run.page, "locked", true);
    await run.electronApp.evaluate(() => {
      (globalThis as any).voiceSetupFixture.confirmations = 0;
      (globalThis as any).e2eMessageBox = () => { (globalThis as any).voiceSetupFixture.confirmations++; return 1; };
    });
    await dialog.getByRole("button", { name: beforeGeneration ? "Generate audition" : "Regenerate", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.confirmations)).toBe(1);
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.keeps)).toBe(0);
    expect(await run.page.evaluate(() => (window as any).__app.session.doc.meta.get(`tableRead.cast.v3.character.${JSON.stringify(["m", "voice.qwen"])}`))).toBe("another-writer-voice");
  } finally { await close(run.electronApp, run.page); }
});


test("a failed voice publication preserves the cast and audition for retry", async () => {
  const run = await launch();
  try {
    await stubPacks(run.electronApp);
    await openDesign(run.page);
    await run.page.getByRole("dialog").getByRole("button", { name: "Discard", exact: true }).click();
    await changeCast(run.page, "voice.qwen", "previous-voice");
    await changeCast(run.page, "locked", false);
    await run.page.getByRole("button", { name: "Design a voice for MAYA" }).click();
    const dialog = run.page.getByRole("dialog");
    await dialog.getByLabel("Voice description").fill("Soft adult tenor");
    await dialog.getByRole("button", { name: "Generate audition", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeEnabled();
    const cast = () => run.page.evaluate(() => {
      const meta = (window as any).__app.session.doc.meta;
      return [meta.get(`tableRead.cast.v3.character.${JSON.stringify(["m", "voice.qwen"])}`),
        meta.get(`tableRead.cast.v3.character.${JSON.stringify(["m", "locked"])}`)];
    });
    const discards = await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.discards);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.failBind = true; });
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("ENOSPC");
    expect(await cast()).toEqual(["previous-voice", false]);
    await expect(dialog.getByLabel("Designed voice audition")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep voice", exact: true })).toBeEnabled();
    expect(await run.electronApp.evaluate(() => (globalThis as any).voiceSetupFixture.discards)).toBe(discards);
    await run.electronApp.evaluate(() => { (globalThis as any).voiceSetupFixture.failBind = false; });
    await dialog.getByRole("button", { name: "Keep voice", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await cast()).toEqual(["designed-fixture", true]);
    expect(await run.electronApp.evaluate(() => {
      const state = (globalThis as any).voiceSetupFixture;
      return [state.keeps, state.binds];
    })).toEqual([1, 2]);
  } finally { await close(run.electronApp, run.page); }
});
