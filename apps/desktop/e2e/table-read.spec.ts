import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFdx } from "@screenplay/engine";
import { close, launch, runCommand } from "./helpers.ts";

test("installed Apple Premium voices synthesize actual WAV through trusted IPC without downloading models", async () => {
  test.skip(process.platform !== "darwin", "Installed voices are macOS-only");
  const run = await launch();
  try {
    const result = await run.page.evaluate(async () => {
      const bridge = (window as any).desktop;
      const status = await bridge.invoke("table-read:status");
      const system = status.engines.find((e: any) => e.id === "system");
      const voice = system.voices.find((v: any) => v.language.startsWith("en")) ?? system.voices[0];
      if (!voice) return { noVoice: true, note: system.note };
      const request = { id: "native-read-1", engine: "system", voice: voice.id, text: "The kitchen door is open." };
      const first = await bridge.invoke("table-read:synthesize", request);
      const second = await bridge.invoke("table-read:synthesize", { ...request, id: "native-read-2" });
      const bytes = new Uint8Array(first.audio);
      return { noVoice: false, header: String.fromCharCode(...bytes.slice(0, 4)), length: bytes.length,
        cached: second.cached, neuralReady: status.engines.filter((e: any) => e.id !== "system").some((e: any) => e.ready) };
    });
    // Only Premium and Enhanced voices are listed; a Mac without one shows how to add them instead.
    if (result.noVoice) { expect(result.note).toContain("Manage Voices"); test.skip(true, "No Apple Premium or Enhanced voice is installed on this Mac."); }
    expect(result.header).toBe("RIFF"); expect(result.length).toBeGreaterThan(1000);
    expect(result.cached).toBe(true); expect(result.neuralReady).toBe(false);
    expect(await run.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()))).toBe(true);
  } finally { await close(run.electronApp, run.page); }
});

test("cast aliases are confirmed by the writer, stored per character, and recast one role", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const voices = ["Ava (Premium)", "Zoe (Premium)", "Tom (Enhanced)", "Evan (Enhanced)", "Karen (Premium)"].map((id) => ({ id, label: id, language: "en-US" }));
      ipcMain.removeHandler("table-read:status");
      ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [
        { id: "system", label: "Apple Premium voices", tier: "Built in", ready: true, available: true, voices, note: "Fixture" },
      ] }));
    });
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
        { id: "m1", type: "character", runs: [{ text: "DETECTIVE MAYA" }] },
        { id: "md", type: "dialogue", runs: [{ text: "The door was open." }] },
        { id: "m2", type: "character", runs: [{ text: "MAYA" }] },
        { id: "md2", type: "dialogue", runs: [{ text: "I know it was." }] },
        { id: "e1", type: "character", runs: [{ text: "ELI" }] },
        { id: "ed", type: "dialogue", runs: [{ text: "Then close it." }] },
      ] });
    });
    await runCommand(run.page, "tableRead.open");
    await expect(run.page.getByLabel("Voice engine")).toBeVisible();

    // An alias is only a suggestion until the writer confirms it.
    const aliases = run.page.getByRole("group", { name: "Possible character aliases" });
    await expect(aliases).toBeVisible();
    await expect(aliases).toContainText("MAYA might be DETECTIVE MAYA");
    await aliases.getByRole("button", { name: "Same person" }).click();
    await expect(run.page.getByLabel("Voice for MAYA", { exact: true })).toHaveCount(0);
    const mayaRow = run.page.getByLabel("Voice for DETECTIVE MAYA", { exact: true });
    await expect(mayaRow).toBeVisible();
    const aliasedRow = run.page.locator(".reader-cast-row").filter({ hasText: "DETECTIVE MAYA" });
    await aliasedRow.locator("summary").click();
    await expect(aliasedRow.getByRole("button", { name: /^Use .* for DETECTIVE MAYA$/ })).toHaveCount(3);

    // A manual choice is stored in the per-character shared map and locks the role.
    const voice = await mayaRow.locator("option").nth(1).getAttribute("value");
    expect(voice).toBeTruthy();
    await mayaRow.selectOption(voice!);
    await expect(run.page.getByLabel("Lock DETECTIVE MAYA")).toBeChecked();
    await expect.poll(() => run.page.evaluate(() => {
      return (window as any).__app.session.doc.meta.get('tableRead.cast.v3.character.["m1","voice.system"]') ?? null;
    })).toBe(voice);

    // Recasting one role must not disturb another role's voice.
    const eliRow = run.page.getByLabel("Voice for ELI", { exact: true });
    const eliBefore = await eliRow.locator("option").nth(2).getAttribute("value");
    await eliRow.selectOption(eliBefore!);
    await run.page.getByRole("button", { name: "Recast ELI" }).click();
    await expect.poll(() => run.page.evaluate(() => {
      return (window as any).__app.session.doc.meta.get('tableRead.cast.v3.character.["e1","voice.system"]') ?? null;
    })).not.toBe(eliBefore);
    const keptMaya = await run.page.evaluate(() => {
      return (window as any).__app.session.doc.meta.get('tableRead.cast.v3.character.["m1","voice.system"]') ?? null;
    });
    expect(keptMaya).toBe(voice);
  } finally { await close(run.electronApp, run.page); }
});

test("writing-first navigation and full dialogue reports use the actual document", async () => {
  const run = await launch();
  try {
    await run.page.evaluate(() => {
      const a = (window as any).__app;
      a.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s", sceneId: "s", type: "sceneHeading", runs: [{ text: "INT. KITCHEN - NIGHT" }] },
        { id: "c", type: "character", runs: [{ text: "MAYA (V.O.)" }] },
        { id: "d", type: "dialogue", runs: [{ text: "The door is open." }] },
        { id: "n", type: "note", runs: [{ text: "Check the ending." }] },
      ] });
    });
    await run.page.getByRole("button", { name: "Plan", exact: true }).click();
    await run.page.getByRole("menuitemradio", { name: /Outline/ }).click();
    await run.page.getByRole("button", { name: "Write", exact: true }).click();
    await expect(run.page.locator(".editor-pm")).toBeVisible();
    await runCommand(run.page, "reports.open");
    await run.page.getByRole("tab", { name: "Dialogue", exact: true }).click();
    await expect(run.page.getByRole("dialog").getByText("The door is open.", { exact: true })).toBeVisible();
    await run.page.getByRole("tab", { name: "Notes", exact: true }).click();
    await expect(run.page.getByRole("dialog").getByText("Check the ending.", { exact: true })).toBeVisible();
    await run.page.keyboard.press("Escape");
    await runCommand(run.page, "tableRead.open");
    await expect(run.page.getByLabel("Voice engine")).toBeVisible();
    await expect(run.page.getByLabel("Reading range", { exact: true })).toBeVisible();
    await run.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const contrasts = await run.page.locator(".table-reader select:enabled").evaluateAll((controls) => {
      const luminance = (color: string) => {
        const values = color.match(/[\d.]+/g)!.slice(0, 3).map((channel) => {
          const value = Number(channel) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
      };
      return controls.map((control) => {
        const style = getComputedStyle(control);
        const foreground = luminance(style.color), background = luminance(style.backgroundColor);
        return { label: control.getAttribute("aria-label"), ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
      });
    });
    expect(contrasts.length).toBeGreaterThanOrEqual(4);
    for (const control of contrasts) expect(control.ratio, `${control.label} must be readable in dark mode`).toBeGreaterThanOrEqual(4.5);
  } finally { await close(run.electronApp, run.page); }
});

test("fake TTS drives modes, seeking, pause, notes and read-only listening", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      for (const channel of ["table-read:status", "table-read:synthesize", "table-read:cancel"]) ipcMain.removeHandler(channel);
      ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [{ id: "system", label: "Fake voices", tier: "Test", ready: true,
        available: true, note: "", voices: [{ id: "fake", label: "Fake", language: "en-US" }] }] }));
      const calls: string[] = [];
      (globalThis as any).__readCalls = calls;
      ipcMain.handle("table-read:cancel", () => {});
      ipcMain.handle("table-read:synthesize", (_event, request) => {
        calls.push(request.text);
        const bytes = Buffer.alloc(44 + 48000 * 5);
        bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
        bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32);
        bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
        return { audio: new Uint8Array(bytes), cached: false };
      });
    });
    await run.page.evaluate(() => {
      const app = (window as any).__app;
      app.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s", sceneId: "s", type: "sceneHeading", runs: [{ text: "INT. KITCHEN" }] },
        { id: "a", type: "action", runs: [{ text: "The door opens." }] },
        { id: "c", type: "character", runs: [{ text: "MAYA" }] },
        { id: "d", type: "dialogue", runs: [{ text: "Stay here." }] },
        { id: "s2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "EXT. ROAD" }] },
        { id: "c2", type: "character", runs: [{ text: "ELI" }] },
        { id: "d2", type: "dialogue", runs: [{ text: "Go now." }] },
      ] });
    });
    await runCommand(run.page, "tableRead.open");
    await run.page.getByLabel("Listening mode", { exact: true }).selectOption("dialogue");
    await run.page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(run.page.locator(".reader-line")).toHaveText("Stay here.");
    await run.page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(run.page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await run.page.getByLabel("Seek to passage", { exact: true }).selectOption("1");
    await expect(run.page.locator(".reader-line")).toHaveText("Go now.");
    await run.page.getByRole("button", { name: "Note at this line", exact: true }).click();
    await run.page.getByLabel("Project item text", { exact: true }).fill("Try a longer pause.");
    await run.page.getByRole("dialog").getByRole("button", { name: "Keep note", exact: true }).click();
    await runCommand(run.page, "tableRead.open");
    await run.page.getByRole("button", { name: "Stop", exact: true }).click();
    const note = await run.page.evaluate(() => [...(window as any).__app.session.doc.meta.values()].find((r: any) => r?.kind === "note"));
    expect(note.anchor.paragraphId).toBe("d2"); expect(note.readSession.revision).toBeTruthy();
    const calls = await run.electronApp.evaluate(() => (globalThis as any).__readCalls);
    expect(calls).not.toContain("The door opens."); expect(calls).not.toContain("MAYA");
    await run.page.getByLabel("Listening mode", { exact: true }).selectOption("range");
    await run.page.getByLabel("Reading range", { exact: true }).selectOption("scene:s2");
    await expect(run.page.getByText(/Table-read duration:/)).toBeVisible();
    const before = await run.page.evaluate(() => {
      const app = (window as any).__app; app.session.setReadOnly(true);
      return JSON.stringify(app.session.doc.meta.toJSON());
    });
    await run.page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(run.page.locator(".reader-line")).toHaveText("Go now.");
    expect(await run.page.evaluate(() => JSON.stringify((window as any).__app.session.doc.meta.toJSON()))).toBe(before);
    await run.page.getByRole("button", { name: "Stop", exact: true }).click();
  } finally { await close(run.electronApp, run.page); }
});

test("voice model requirements and writer activity are exposed without installing a pack", async () => {
  const run = await launch();
  try {
    const result = await run.page.evaluate(async () => {
      const bridge = (window as any).desktop;
      const models = await bridge.invoke("table-read:models");
      await bridge.invoke("table-read:activity", { typing: true, dictating: false });
      const paused = await bridge.invoke("table-read:status");
      await bridge.invoke("table-read:activity", { typing: false, dictating: false });
      const resumed = await bridge.invoke("table-read:status");
      const voices = await bridge.invoke("table-read:voice-catalogue");
      return { models, paused: paused.prefetchPaused, resumed: resumed.prefetchPaused,
        engines: resumed.engines.map((e: any) => e.id), tagged: voices.every((v: any) => Array.isArray(v.tags) && v.tags.length >= 4) };
    });
    expect(result.models.map((m: any) => m.id)).toContain("qwen-base-06b");
    expect(result.models.map((m: any) => m.id)).toContain("qwen-base-17b");
    for (const model of result.models) {
      expect(model.installed).toBe(false);
      expect(model.license.length).toBeGreaterThan(0);
      expect(model.minimumMacOS).toBeGreaterThanOrEqual(15);
      expect(model.memoryGB).toBeGreaterThanOrEqual(8);
      expect(model.diskBytes).toBe(0);
      expect(model).not.toHaveProperty("directory");
    }
    expect(result.engines).toContain("kokoro"); expect(result.engines).toContain("qwen");
    expect(result.paused).toBe(true); expect(result.resumed).toBe(false); expect(result.tagged).toBe(true);
  } finally { await close(run.electronApp, run.page); }
});

test("engine picker uses a deterministic local adapter without changing screenplay text", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const voices = [{ id: "fixture", label: "Fixture voice", language: "en-US", tags: ["adult", "American English", "warm", "test fixture"] }];
      ipcMain.removeHandler("table-read:status");
      ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [
        { id: "system", label: "Mac voices", tier: "Ready now", ready: true, available: true, voices, note: "Installed fixture" },
        { id: "kokoro", label: "Kokoro 82M", tier: "Quick Read", ready: true, available: true, voices, note: "Verified local fixture" }
      ] }));
      ipcMain.removeHandler("table-read:synthesize");
      ipcMain.handle("table-read:synthesize", () => {
        const bytes = Buffer.alloc(48044); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4);
        bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
        bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
        return { audio: new Uint8Array(bytes), cached: false };
      });
    });
    await run.page.evaluate(() => {
      (window as any).__app.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s", sceneId: "s", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
        { id: "c", type: "character", runs: [{ text: "MAYA" }] },
        { id: "d", type: "dialogue", runs: [{ text: "The door is open." }] }
      ] });
    });
    await runCommand(run.page, "tableRead.open");
    await run.page.getByLabel("Voice engine").selectOption("kokoro");
    await expect(run.page.getByText("Verified local fixture", { exact: true })).toBeVisible();
    await run.page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(run.page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await run.page.getByRole("button", { name: "Stop", exact: true }).click();
    const dialogue = await run.page.evaluate(() => (window as any).__app.session.script().paragraphs.find((p: any) => p.id === "d").runs[0].text);
    expect(dialogue).toBe("The door is open.");
  } finally { await close(run.electronApp, run.page); }
});

test("ChatGPT settings expose plan status and casting asks once before sending bounded packets to ChatGPT", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const state = { signedIn: false, planUsageGranted: false, paused: false, approved: false, starts: 0, disclosures: [] as string[], welcomes: 0 };
      (globalThis as any).__chatgptFixture = state;
      for (const channel of ["ai:status", "ai:models", "ai:chatgpt-login", "ai:chatgpt-logout", "ai:chatgpt-resume", "ai:start",
        "table-read:status", "table-read:synthesize", "shell:message-box"]) ipcMain.removeHandler(channel);
      const account = () => ({ available: true, pending: false, signedIn: state.signedIn, email: state.signedIn ? "writer@example.test" : undefined,
        planUsageGranted: state.planUsageGranted, paused: state.paused,
        note: state.paused ? "ChatGPT plan requests are paused." : undefined });
      ipcMain.handle("ai:status", () => ({ encryption: true, providers: [{ provider: "chatgpt", ready: state.signedIn && state.planUsageGranted && !state.paused }],
        active: { provider: "chatgpt", model: "fixture-model", contextChars: 300000 }, chatgpt: account() }));
      ipcMain.handle("ai:models", () => ({ models: ["fixture-model"], entries: [{ id: "fixture-model", label: "Account fixture model" }] }));
      ipcMain.handle("ai:chatgpt-login", (_event, options) => { state.signedIn = true; state.planUsageGranted = !!options?.consent; return account(); });
      ipcMain.handle("ai:chatgpt-logout", () => { state.signedIn = false; state.planUsageGranted = false; return account(); });
      ipcMain.handle("ai:chatgpt-resume", () => { state.paused = false; return account(); });
      ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [{ id: "system", label: "Fake voices", tier: "Test", ready: true,
        available: true, note: "", voices: [{ id: "fake", label: "Fake voice", language: "en-US" }, { id: "other", label: "Other voice", language: "en-US" }] }] }));
      ipcMain.handle("table-read:synthesize", () => {
        const bytes = Buffer.alloc(48044);
        bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
        bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32);
        bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
        return { audio: new Uint8Array(bytes), cached: false };
      });
      ipcMain.handle("shell:message-box", (_event, options) => {
        // The first-sign-in welcome is OpenAI's required notice, not a casting disclosure.
        if (/usage limit was reached/.test(options.message)) { state.limits = [...(state.limits ?? []), options.buttons]; return { response: 1 }; }
        if (/using your ChatGPT plan/.test(options.message)) { state.welcomes = (state.welcomes ?? 0) + 1; return { response: 0 }; }
        state.disclosures.push(options.detail); return { response: state.approved ? 0 : 1 };
      });
      ipcMain.handle("ai:start", (event, request) => {
        state.starts++; (globalThis as any).__castingProvider = request.provider;
        if (state.limited) {
          setTimeout(() => event.sender.send("ai:event", { id: request.id, type: "error", code: "plan-limit", message: "Your ChatGPT plan's usage limit was reached. ChatGPT requests are paused." }), 10);
          return { id: request.id, provider: "chatgpt", model: "fixture-model" };
        }
        const packet = JSON.parse(request.messages[0].content);
        (globalThis as any).__castingPacket = packet;
        const role = packet.characters[0];
        setTimeout(() => event.sender.send("ai:event", { id: request.id, type: "done", text: JSON.stringify({ assignments: [
          { id: role.id, voice: "other", gender: "unclear", reason: "Matches the supplied dialogue.", evidence: ["d"] }
        ] }) }), 10);
        return { id: request.id, provider: "chatgpt", model: "fixture-model" };
      });
    });
    await run.page.evaluate(() => {
      const app = (window as any).__app;
      app.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s", sceneId: "s", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
        { id: "c", type: "character", runs: [{ text: "SAM" }] },
        { id: "d", type: "dialogue", runs: [{ text: "Stay here." }, { text: "PRIVATE INLINE NOTE", note: true }] },
        { id: "n", type: "note", runs: [{ text: "PRIVATE NOTE" }] },
      ] });
      app.openModal("workspace.settings", { section: "ai" });
    });
    await run.page.getByLabel("Provider", { exact: true }).selectOption("chatgpt");
    await expect(run.page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toBeVisible();
    await expect(run.page.getByText(/Cold Open is free and has no plan or charges of its own/)).toBeVisible();
    await expect(run.page.locator("[data-oai-siwc-button] img").first()).toHaveAttribute("src", /chatgpt-logo/);
    await run.page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(run.page.getByRole("button", { name: "Enable ChatGPT plan usage", exact: true })).toBeVisible();
    await run.page.getByRole("button", { name: "Enable ChatGPT plan usage", exact: true }).click();
    await expect(run.page.getByText("Using ChatGPT plan", { exact: true })).toBeVisible();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).__chatgptFixture.welcomes ?? 0)).toBe(1);
    await expect(run.page.getByLabel("ChatGPT model").locator("option[value=fixture-model]")).toHaveText("Account fixture model");
    await run.page.getByLabel("ChatGPT model").selectOption("fixture-model");
    await run.page.screenshot({ path: "/tmp/inklot-chatgpt-settings.png" });
    await run.page.keyboard.press("Escape");
    await runCommand(run.page, "tableRead.open");
    const scriptBefore = await run.page.evaluate(() => JSON.stringify((window as any).__app.session.script().paragraphs));
    const assign = run.page.getByRole("button", { name: "Assign distinct voices", exact: true });
    const disclosures = () => run.electronApp.evaluate(() => (globalThis as any).__chatgptFixture.disclosures.length);
    // Declining ChatGPT still casts, by name and pronoun matching, and sends nothing.
    await assign.click();
    await expect.poll(disclosures).toBe(1);
    await expect(run.page.getByLabel("Voice for SAM", { exact: true })).not.toHaveValue("");
    expect(await run.electronApp.evaluate(() => (globalThis as any).__chatgptFixture.starts)).toBe(0);
    await run.electronApp.evaluate(() => { (globalThis as any).__chatgptFixture.approved = true; });
    await assign.click();
    await expect(run.page.getByText("Cast by ChatGPT.", { exact: true })).toBeVisible();
    await expect(run.page.getByLabel("Voice for SAM", { exact: true })).toHaveValue("other");
    const sent = await run.electronApp.evaluate(() => ({ packet: (globalThis as any).__castingPacket, provider: (globalThis as any).__castingProvider, disclosure: (globalThis as any).__chatgptFixture.disclosures[1] }));
    expect(sent.provider).toBe("chatgpt");
    expect(sent.disclosure).toContain("lines and descriptions"); expect(sent.disclosure).toContain("Script notes stay out");
    expect(JSON.stringify(sent.packet)).not.toContain("PRIVATE NOTE");
    expect(JSON.stringify(sent.packet)).not.toContain("PRIVATE INLINE NOTE");
    // Approval is remembered for this provider.
    await assign.click();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).__chatgptFixture.starts)).toBe(2);
    expect(await disclosures()).toBe(2);

    // A plan limit offers Manage usage first, as OpenAI's guidelines ask, and casting falls back to name matching.
    await run.electronApp.evaluate(() => { (globalThis as any).__chatgptFixture.limited = true; });
    await assign.click();
    await expect.poll(() => run.electronApp.evaluate(() => (globalThis as any).__chatgptFixture.limits ?? [])).toEqual([["Manage usage", "Close"]]);
    await expect(run.page.getByText(/could not cast/)).toBeVisible();
    expect(await run.page.evaluate(() => JSON.stringify((window as any).__app.session.script().paragraphs))).toBe(scriptBefore);
    await run.page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(run.page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await run.page.getByRole("button", { name: "Stop", exact: true }).click();
  } finally { await close(run.electronApp, run.page); }
});

test("an FDX keeps the table read beside the script and restores it on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-sidecar-"));
  const script = { titlePage: [], paragraphs: [
    { id: "s", type: "sceneHeading" as const, sceneId: "s", runs: [{ text: "INT. DINER - NIGHT" }] },
    { id: "m", type: "character" as const, runs: [{ text: "MAYA" }] },
    { id: "d", type: "dialogue" as const, runs: [{ text: "The door was open." }] },
  ] };
  const fdx = join(dir, "Diner.fdx");
  writeFileSync(fdx, writeFdx(script));
  const sidecar = fdx + ".coldopen-read.json";
  const stubVoices = async (app: import("@playwright/test").ElectronApplication) => app.evaluate(({ ipcMain }) => {
    const voices = [{ id: "fixture", label: "Fixture voice", language: "en-US", tags: ["adult", "warm", "test"] }];
    ipcMain.removeHandler("table-read:status");
    ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [
      { id: "system", label: "Mac voices", tier: "Ready now", ready: true, available: true, voices, note: "Fixture" },
    ] }));
    const scripted = (globalThis as any).e2eMessageBox;
    (globalThis as any).e2eMessageBox = (options: any) => {
      if (/Where should the table read live/.test(options.message)) return 1;
      if (/cannot keep all project material/.test(options.message)) return 0;
      return scripted ? scripted(options) : 0;
    };
  });

  const first = await launch([fdx]);
  try {
    await stubVoices(first.electronApp);
    await first.page.waitForSelector(".editor-pm");
    await runCommand(first.page, "tableRead.open");
    await first.page.getByLabel("Voice for MAYA", { exact: true }).selectOption("fixture");
    await expect(first.page.getByLabel("Lock MAYA")).toBeChecked();
    await runCommand(first.page, "file.save");
    await expect.poll(() => existsSync(sidecar)).toBe(true);
    const saved = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(saved.source.format).toBe("fdx");
    expect(saved.cast.characters.find((row: any) => row.name === "MAYA").voices.system).toBe("fixture");
    expect(JSON.stringify(saved)).not.toContain(fdx);
  } finally {
    await close(first.electronApp, first.page);
  }

  const second = await launch([fdx]);
  try {
    await stubVoices(second.electronApp);
    await second.page.waitForSelector(".editor-pm");
    await expect.poll(() => second.page.evaluate(() => {
      return (window as any).__app.session.doc.meta.get(
        'tableRead.cast.v3.character.["m","voice.system"]',
      ) ?? null;
    })).toBe("fixture");
    await runCommand(second.page, "tableRead.open");
    await expect(second.page.getByLabel("Voice for MAYA", { exact: true })).toHaveValue("fixture");
    await expect(second.page.getByRole("dialog")).toHaveCount(0);
    await second.page.evaluate(() => (window as any).__app.session.setReadOnly(true));
    await expect(second.page.getByRole("button", { name: "Save table-read file next to this script", exact: true })).toBeDisabled();
    await expect(second.page.getByRole("button", { name: "Import bundle…", exact: true })).toBeDisabled();
  } finally {
    await close(second.electronApp, second.page);
  }
});

test("automatic casting skips novelty voices, but a locked novelty choice survives Assign distinct voices", async () => {
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const voices = [
        { id: "Bells", label: "Bells", language: "en-US", tags: ["presentation unreviewed", "age unreviewed", "en-US", "timbre unreviewed", "novelty"] },
        { id: "Samantha", label: "Samantha", language: "en-US", tags: ["feminine", "adult", "American English", "clear"] },
        { id: "Daniel", label: "Daniel", language: "en-GB", tags: ["masculine", "adult", "British English", "low"] },
        { id: "Karen", label: "Karen", language: "en-AU", tags: ["feminine", "adult", "Australian English", "clear"] },
      ];
      ipcMain.removeHandler("table-read:status");
      ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [
        { id: "system", label: "Mac voices", tier: "Ready now", ready: true, available: true, voices, note: "Fixture" },
      ] }));
    });
    await run.page.evaluate(() => {
      (window as any).__app.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
        { id: "m1", type: "character", runs: [{ text: "MAYA" }] }, { id: "md", type: "dialogue", runs: [{ text: "Open." }] },
        { id: "e1", type: "character", runs: [{ text: "ELI" }] }, { id: "ed", type: "dialogue", runs: [{ text: "Closed." }] },
      ] });
    });
    // Nothing answers on this port, so the local model fails and name matching casts instead.
    await run.page.evaluate(() => (window as any).__app.setSetting("ai.ollama.endpoint", "http://127.0.0.1:9"));
    await runCommand(run.page, "tableRead.open");
    const maya = run.page.getByLabel("Voice for MAYA", { exact: true }), eli = run.page.getByLabel("Voice for ELI", { exact: true });
    await expect(run.page.getByText(/Where those say nothing, the local model reads/)).toBeVisible();
    await run.page.getByRole("button", { name: "Assign distinct voices" }).click();
    await expect(run.page.getByText(/The local model could not cast \(.+\)\. Voices were matched by name and pronouns instead\./)).toBeVisible();
    await expect(maya).not.toHaveValue("Bells");
    await expect(eli).not.toHaveValue("Bells");

    await maya.selectOption("Bells");
    await expect(run.page.getByLabel("Lock MAYA")).toBeChecked();
    await run.page.getByRole("button", { name: "Assign distinct voices" }).click();
    await expect(maya).toHaveValue("Bells");
    await expect(eli).not.toHaveValue("Bells");
  } finally { await close(run.electronApp, run.page); }
});

test("automatic casting keeps the cast in one accent, and the writer can change it", async () => {
  // Terra beta 6: MAYA, an American teenager, was cast with a British voice.
  const run = await launch();
  try {
    await run.electronApp.evaluate(({ ipcMain }) => {
      const voices = [
        { id: "Bryony", label: "Bryony", language: "en-GB", tags: ["female"] },
        { id: "Daniel", label: "Daniel", language: "en-GB", tags: ["male"] },
        { id: "Ava", label: "Ava", language: "en-US", tags: ["female"] },
        { id: "Samantha", label: "Samantha", language: "en-US", tags: ["female"] },
        { id: "Tom", label: "Tom", language: "en-US", tags: ["male"] },
      ];
      ipcMain.removeHandler("table-read:status");
      ipcMain.handle("table-read:status", () => ({ cacheBytes: 0, engines: [
        { id: "system", label: "Mac voices", tier: "Ready now", ready: true, available: true, voices, note: "Fixture" },
      ] }));
    });
    await run.page.evaluate(() => {
      (window as any).__app.session.doc.load({ titlePage: [], paragraphs: [
        { id: "s1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
        { id: "a1", type: "action", runs: [{ text: "MAYA (17), a girl in a hoodie, waits. ELI, a boy, joins her." }] },
        { id: "m1", type: "character", runs: [{ text: "MAYA" }] }, { id: "md", type: "dialogue", runs: [{ text: "Open." }] },
        { id: "e1", type: "character", runs: [{ text: "ELI" }] }, { id: "ed", type: "dialogue", runs: [{ text: "Closed." }] },
      ] });
    });
    await run.page.evaluate(() => (window as any).__app.setSetting("tableRead.accent", "en-us"));
    await runCommand(run.page, "tableRead.open");
    const accent = run.page.getByLabel("Accent for automatic casting");
    await expect(accent).toHaveValue("en-us");
    await expect(run.page.getByText(/Voices are American unless the script gives a character another accent\./)).toBeVisible();
    const maya = run.page.getByLabel("Voice for MAYA", { exact: true }), eli = run.page.getByLabel("Voice for ELI", { exact: true });
    await run.page.getByRole("button", { name: "Assign distinct voices" }).click();
    await expect(maya).toHaveValue(/^(Ava|Samantha)$/);
    await expect(eli).toHaveValue("Tom");
    await expect(maya.locator("option", { hasText: "Bryony · British" })).toHaveCount(1);
    await run.page.screenshot({ path: "test-results/accent-american.png" });

    await accent.selectOption("en-gb");
    await run.page.getByRole("button", { name: "Assign distinct voices" }).click();
    await expect(maya).toHaveValue("Bryony");
    await expect(eli).toHaveValue("Daniel");
  } finally { await close(run.electronApp, run.page); }
});
