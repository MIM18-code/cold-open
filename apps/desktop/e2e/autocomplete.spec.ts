// Sentence completion is opt-in: off by default, then ⌘Return asks for the rest of the sentence, which shows in grey
// until → accepts it. The AI channel is stubbed; the editor, the command and the settings are the real ones.
import { expect, test } from "@playwright/test";
import { close, launch, runCommand } from "./helpers.ts";

test("sentence completion is off until turned on, then → accepts the grey suggestion as one undoable edit", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const state = { requests: [] as any[] };
      (globalThis as any).__complete = state;
      for (const channel of ["ai:status", "ai:start"]) ipcMain.removeHandler(channel);
      ipcMain.handle("ai:status", () => ({ encryption: true, providers: [{ provider: "ollama", ready: true }], active: { provider: "ollama", model: "", contextChars: 36000 },
        chatgpt: { available: false, signedIn: false, pending: false } }));
      ipcMain.handle("ai:start", (event, request) => {
        state.requests.push(request);
        setTimeout(() => event.sender.send("ai:event", { id: request.id, type: "done", text: JSON.stringify({ sentence: "Then a knock at the door." }) }), 20);
        return { id: request.id, provider: "ollama", model: "fixture" };
      });
    });
    await run.page.evaluate(() => (window as any).__app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "s", sceneId: "s", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
      { id: "n", type: "note", runs: [{ text: "PRIVATE NOTE" }] },
      { id: "a", type: "action", runs: [{ text: "Rain on the glass. Then a kn" }] },
    ] }));
    const text = () => run.page.evaluate(() => (window as any).__app.session.script().paragraphs.find((p: any) => p.id === "a").runs.map((r: any) => r.text).join(""));
    await run.page.locator(".ProseMirror").first().click();
    await run.page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a", offset: 28 }));

    // Off by default: the command is disabled and nothing is sent.
    expect(await run.page.evaluate(() => (window as any).__app.setting("ai.complete", "off"))).toBe("off");
    await runCommand(run.page, "ai.completeSentence");
    await run.page.waitForTimeout(200);
    expect(await run.electronApp.evaluate(() => (globalThis as any).__complete.requests.length)).toBe(0);

    await run.page.evaluate(() => (window as any).__app.openModal("workspace.settings", { section: "ai" }));
    await run.page.getByLabel("Sentence completion").selectOption("shortcut");
    await expect(run.page.getByText(/→ adds it, Esc or typing dismisses it/)).toBeVisible();
    await run.page.keyboard.press("Escape");
    await run.page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a", offset: 28 }));

    await runCommand(run.page, "ai.completeSentence");
    const ghost = run.page.locator(".editor-ghost");
    await expect(ghost).toHaveText("ock at the door.");
    const sent = await run.electronApp.evaluate(() => (globalThis as any).__complete.requests[0]);
    expect(sent.provider).toBe("ollama");
    expect(sent.messages[0].content).toContain('"Then a kn"');
    expect(sent.messages[0].content).not.toContain("PRIVATE NOTE");
    expect(await text()).toBe("Rain on the glass. Then a kn");

    // Esc dismisses without touching the script.
    await run.page.keyboard.press("Escape");
    await expect(ghost).toHaveCount(0);
    expect(await text()).toBe("Rain on the glass. Then a kn");

    // ⌘Return asks; → accepts; one undo takes it back.
    await run.page.keyboard.press("Meta+Enter");
    await expect(ghost).toHaveText("ock at the door.");
    await run.page.keyboard.press("ArrowRight");
    await expect(ghost).toHaveCount(0);
    expect(await text()).toBe("Rain on the glass. Then a knock at the door.");
    await expect(run.page.locator(".visually-hidden[aria-live]")).toHaveText(/Suggestion: ock at the door\. Right Arrow adds it/);
    await runCommand(run.page, "editor.undo");
    await expect.poll(text).toBe("Rain on the glass. Then a kn");

    // Typing right before accepting is not undone with the suggestion.
    await run.page.keyboard.type("o");
    await run.page.keyboard.press("Meta+Enter");
    await expect(ghost).toHaveText("ck at the door.");
    await run.page.keyboard.press("ArrowRight");
    await runCommand(run.page, "editor.undo");
    await expect.poll(text).toBe("Rain on the glass. Then a kno");
    await runCommand(run.page, "editor.undo");
    await expect.poll(text).toBe("Rain on the glass. Then a kn");

    // Turning completion off clears a suggestion on screen.
    await run.page.keyboard.press("Meta+Enter");
    await expect(ghost).toHaveText("ock at the door.");
    await run.page.evaluate(() => (window as any).__app.setSetting("ai.complete", "off"));
    await expect(ghost).toHaveCount(0);
    await run.page.evaluate(() => (window as any).__app.setSetting("ai.complete", "shortcut"));

    // Typing dismisses a suggestion and the typed key goes into the script.
    await run.page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a", offset: 28 }));
    await runCommand(run.page, "ai.completeSentence");
    await expect(ghost).toHaveText("ock at the door.");
    await run.page.keyboard.type("i");
    await expect(ghost).toHaveCount(0);
    expect(await text()).toBe("Rain on the glass. Then a kni");
  } finally { await close(run.electronApp, run.page); }
});

test("in pause mode a suggestion follows a pause after typing, but not a click into a line", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const state = { requests: 0 };
      (globalThis as any).__complete = state;
      for (const channel of ["ai:status", "ai:start"]) ipcMain.removeHandler(channel);
      ipcMain.handle("ai:status", () => ({ encryption: true, providers: [{ provider: "ollama", ready: true }], active: { provider: "ollama", model: "", contextChars: 36000 },
        chatgpt: { available: false, signedIn: false, pending: false } }));
      ipcMain.handle("ai:start", (event, request) => {
        state.requests++;
        setTimeout(() => event.sender.send("ai:event", { id: request.id, type: "done", text: JSON.stringify({ sentence: "Rain on the glass. Then a knock at the door." }) }), 20);
        return { id: request.id, provider: "ollama", model: "fixture" };
      });
    });
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.setSetting("ai.complete", "pause");
      a.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s", sceneId: "s", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
        { id: "a", type: "action", runs: [{ text: "Rain on the glass. Then a kn" }] },
      ] });
    });
    await run.page.locator(".ProseMirror").first().click();
    await run.page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a", offset: 28 }));
    await run.page.waitForTimeout(1800);
    expect(await run.electronApp.evaluate(() => (globalThis as any).__complete.requests)).toBe(0);
    await run.page.keyboard.type("o");
    await expect(run.page.locator(".editor-ghost")).toHaveText("ck at the door.", { timeout: 5000 });
  } finally { await close(run.electronApp, run.page); }
});
