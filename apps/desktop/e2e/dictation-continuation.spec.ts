import { expect, test } from "@playwright/test";
import { close, confirmNextPrompt, launch } from "./helpers.ts";

type Run = Awaited<ReturnType<typeof launch>>;

async function stubDictation(run: Run): Promise<void> {
  await run.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("dictation:prepare");
    ipcMain.handle("dictation:prepare", () => ({ engine: "parakeet", speechMs: 1 }));
    for (const channel of ["dictation:process", "dictation:format"]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (_event, request) => {
        const text = request.text ?? "A dog waits outside.";
        if ((globalThis as any).__holdDictation) await new Promise(resolve => { (globalThis as any).__releaseDictation = resolve; });
        return { takeId: request.takeId, source: request.text ? "text" : "audio", transcript: text,
          elements: [{ type: "action", text, uncertainty: "" }], autoApplyErrors: [], diagnostics: [], warnings: [], commands: [],
          timings: { transcribeMs: 1, formatMs: 1, totalMs: 2 } };
      });
    }
  });
}

async function seed(run: Run): Promise<void> {
  await run.page.evaluate(() => {
    const a = (window as any).__app;
    const id = a.session.script().paragraphs[0].id;
    a.session.edit(() => {
      a.session.doc.setType(id, "action");
      a.session.doc.insertText(id, 0, "Earlier text stays.");
      a.session.doc.insertParagraph(1, { type: "action", runs: [{ text: "The script ends here." }] });
    });
    a.editor.setSelection({ paragraphId: id, offset: 3 });
  });
}

const paragraphs = (run: Run) => run.page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join("")));

test("a second transcript cannot erase a pending take; Insert appends and restores editor focus", async () => {
  const run = await launch();
  try {
    await stubDictation(run);
    await seed(run);
    await run.page.evaluate(() => (window as any).__app.togglePanel("dictation", true));
    const box = run.page.getByLabel("Transcript to format");
    await box.fill("A yellow bird lands on the table.");
    await run.page.getByRole("button", { name: "Format", exact: true }).click();
    await expect(run.page.locator(".dictation-el")).toHaveText("A yellow bird lands on the table.");
    await box.fill("A dog waits outside.");
    await expect(run.page.getByRole("button", { name: "Format", exact: true })).toBeDisabled();
    // The controller also protects a take when invoked by a command or a repeated event.
    await run.page.evaluate(() => (window as any).__dictation.formatText("A dog waits outside."));
    await expect(run.page.locator(".dictation-el")).toHaveText("A yellow bird lands on the table.");
    await run.page.getByRole("button", { name: "Insert 1 element", exact: true }).click();
    expect(await paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here.", "A yellow bird lands on the table."]);
    await expect(run.page.locator(".editor-pm")).toBeFocused();
    await run.page.keyboard.insertText(" More.");
    expect((await paragraphs(run)).at(-1)).toBe("A yellow bird lands on the table. More.");
    await expect(box).toHaveValue("A dog waits outside.");
    await run.page.getByRole("button", { name: "Format", exact: true }).click();
    await run.page.getByRole("button", { name: "Insert 1 element", exact: true }).click();
    expect((await paragraphs(run)).at(-1)).toBe("A dog waits outside.");
  } finally { await close(run.electronApp, run.page); }
});

test("text entered while formatting is in flight survives the result", async () => {
  const run = await launch();
  try {
    await stubDictation(run);
    await run.electronApp.evaluate(() => { (globalThis as any).__holdDictation = true; });
    await run.page.evaluate(() => (window as any).__app.togglePanel("dictation", true));
    const box = run.page.getByLabel("Transcript to format");
    await box.fill("The first take.");
    await run.page.getByRole("button", { name: "Format", exact: true }).click();
    await expect.poll(() => run.electronApp.evaluate(() => !!(globalThis as any).__releaseDictation)).toBe(true);
    await box.fill("The next take.");
    await run.electronApp.evaluate(() => (globalThis as any).__releaseDictation());
    await expect(run.page.locator(".dictation-el")).toHaveText("The first take.");
    await expect(box).toHaveValue("The next take.");
  } finally { await close(run.electronApp, run.page); }
});

test("native takes format into the editor, append repeatedly, and leave each take undoable", async () => {
  const run = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  try {
    await stubDictation(run);
    await seed(run);
    const before = await paragraphs(run);
    const dictation = run.page.getByRole("group", { name: "Dictation", exact: true });
    for (let i = 0; i < 2; i++) {
      await dictation.getByRole("button", { name: "Dictate", exact: true }).click();
      await expect(dictation.getByRole("status")).toContainText("end of script");
      await expect(run.page.locator(".editor-pm")).toBeFocused();
      await run.page.waitForTimeout(1100);
      await dictation.getByRole("button", { name: "Stop", exact: true }).click();
      await expect.poll(() => paragraphs(run)).toEqual([...before, ...Array(i + 1).fill("A dog waits outside.")]);
      await expect(run.page.locator(".dictation")).toHaveCount(0);
      await expect(run.page.locator(".editor-pm")).toBeFocused();
    }
    await run.page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await paragraphs(run)).toEqual([...before, "A dog waits outside."]);
  } finally { await close(run.electronApp, run.page); }
});

test("highlighted dictation needs review, keeps its original target and refuses a changed source", async () => {
  const run = await launch();
  try {
    await stubDictation(run);
    await seed(run);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      const id = a.session.script().paragraphs[0].id;
      a.editor.setSelection({ paragraphId: id, offset: 0 }, { paragraphId: id, offset: 19 });
    });
    // Use the same audio-delivery path as Stop, without waiting for the fake microphone in this target test.
    await run.page.evaluate(() => (window as any).__dictation.processAudio(new Uint8Array(), true, true));
    await expect(run.page.getByRole("button", { name: "Replace selected text", exact: true })).toBeVisible();
    expect(await paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here."]);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.editor.setSelection({ paragraphId: a.session.script().paragraphs[1].id, offset: 0 });
    });
    await run.page.getByRole("button", { name: "Replace selected text", exact: true }).click();
    expect(await paragraphs(run)).toEqual(["A dog waits outside.", "The script ends here."]);
    await run.page.evaluate(() => (window as any).__app.session.undo.undo());
    await run.page.evaluate(async () => {
      const a = (window as any).__app;
      const id = a.session.script().paragraphs[0].id;
      a.editor.setSelection({ paragraphId: id, offset: 0 }, { paragraphId: id, offset: 19 });
      await (window as any).__dictation.processAudio(new Uint8Array(), true, true);
      a.session.edit(() => a.session.doc.insertText(id, 0, "New work. "));
    });
    const before = await paragraphs(run);
    await run.page.getByRole("button", { name: "Replace selected text", exact: true }).click();
    expect(await paragraphs(run)).toEqual(before);
    await expect(run.page.locator(".dictation-el")).toHaveText("A dog waits outside.");
  } finally { await close(run.electronApp, run.page); }
});

test("holding Space to talk stops on release and delivers to the editor", async () => {
  const run = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  try {
    await stubDictation(run);
    await seed(run);
    await run.page.evaluate(async () => {
      const a = (window as any).__app;
      await a.setSetting("dictation.mode", "push");
      a.togglePanel("dictation", true);
    });
    const mic = run.page.locator(".dictation-mic");
    await mic.focus();
    await run.page.keyboard.down("Space");
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await expect(mic).toBeFocused();
    await run.page.waitForTimeout(1100);
    await run.page.keyboard.up("Space");
    await expect.poll(() => paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here.", "A dog waits outside."]);
    await expect(mic).toHaveAttribute("aria-pressed", "false");
    await expect(run.page.locator(".editor-pm")).toBeFocused();
  } finally { await close(run.electronApp, run.page); }
});

test("an uncertain native take stays in review and a document switch cancels an active recording", async () => {
  const run = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  try {
    await stubDictation(run);
    await seed(run);
    await run.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("dictation:process");
      ipcMain.handle("dictation:process", (_event, request) => ({ takeId: request.takeId, source: "audio", transcript: "A dog waits outside.",
        elements: [{ type: "action", text: "A cat waits outside.", uncertainty: "" }], autoApplyErrors: ["Wording changed"],
        diagnostics: [], warnings: [], commands: [], timings: { transcribeMs: 1, formatMs: 1, totalMs: 2 } }));
    });
    await run.page.evaluate(() => (window as any).__dictation.processAudio(new Uint8Array(), true, true));
    expect(await paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here."]);
    await expect(run.page.getByRole("button", { name: "Insert 1 element", exact: true })).toBeVisible();
    await confirmNextPrompt(run.electronApp);
    await run.page.getByRole("button", { name: "Discard", exact: true }).click();
    await run.page.evaluate(() => (window as any).__dictation.toggleRecording());
    await expect.poll(() => run.page.evaluate(() => (window as any).__dictation.store.state.phase)).toBe("recording");
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.setSession(a.session.constructor.untitled());
    });
    expect(await run.page.evaluate(() => (window as any).__dictation.store.state.phase)).toBe("idle");
    expect(await paragraphs(run)).toEqual([""]);
    await expect(run.page.locator(".dictation-el")).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});

test("Continue at end gives Wispr Flow a caret at the end and Format Draft formats only a highlight", async () => {
  const run = await launch();
  try {
    await stubDictation(run);
    await seed(run);
    await run.page.getByRole("button", { name: "Continue at end", exact: true }).click();
    await expect(run.page.locator(".editor-pm")).toBeFocused();
    await run.page.keyboard.insertText(" A dog waits outside.");
    expect(await paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here. A dog waits outside."]);
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      const id = a.session.script().paragraphs.at(-1).id;
      a.editor.setSelection({ paragraphId: id, offset: 22 }, { paragraphId: id, offset: 42 });
    });
    await run.page.keyboard.press("Meta+Shift+Enter");
    await expect.poll(() => paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here. ", "A dog waits outside."]);
    await expect(run.page.locator(".editor-pm")).toBeFocused();
  } finally { await close(run.electronApp, run.page); }
});

test("a silent recording reveals its error, and Stop still works after switching views", async () => {
  const run = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  try {
    await stubDictation(run);
    await seed(run);
    await run.page.evaluate(() => {
      // Feed the real recorder a silent stream without opening a real microphone.
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const mute = context.createGain();
        mute.gain.value = 0;
        oscillator.connect(mute);
        const destination = context.createMediaStreamDestination();
        mute.connect(destination);
        oscillator.start();
        void context.resume();
        (window as any).__silentContext = context;
        return destination.stream;
      };
    });
    await run.page.getByRole("button", { name: "Dictate", exact: true }).click();
    await expect.poll(() => run.page.evaluate(() => (window as any).__dictation.store.state.seconds)).toBeGreaterThan(0.5);
    await run.page.evaluate(() => (window as any).__app.setView("cards"));
    await run.page.evaluate(() => (window as any).__app.runCommand("dictation.toggle"));
    await expect(run.page.locator(".dictation-error")).toContainText("The recording is silent");
    expect(await paragraphs(run)).toEqual(["Earlier text stays.", "The script ends here."]);
    expect(await run.page.evaluate(() => (window as any).__dictation.store.state.phase)).toBe("idle");
    await run.page.evaluate(() => (window as any).__silentContext.close());
  } finally { await close(run.electronApp, run.page); }
});
