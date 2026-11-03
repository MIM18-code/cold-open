// Production renderer smoke test. Native services and the local model are deterministic fixtures.
// Run after building: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium node scripts/qol-browser.mjs
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
const root = fileURLToPath(new URL("../dist/renderer/", import.meta.url));
const output = process.env.SCREENPLAY_SCREENSHOTS;
let browser;
const errors = [], checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: "light" });
  const bridgeFixture = () => {
    // about:blank is not a secure origin; supply the UUID facility Electron's file context provides.
    if (!crypto.randomUUID) crypto.randomUUID = () => {
      const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      const s = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    }
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel", configurable: true });
    const settings = { "appearance.theme": "light" }, listeners = new Map();
    window.__requests = []; window.__voiceRequests = []; window.__downloads = []; window.__exports = [];
    const loaded = new Set(["system"]), installed = new Set();
    const voiceModels = () => ["phonon", "ming"].map((id) => ({ id, engine: id, label: `${id} fixture`, installed: installed.has(id),
      sizeBytes: 1024, diskBytes: installed.has(id) ? 1024 : 0, minimumMacOS: 15, memoryGB: 1,
      license: "Synthetic fixture", provenance: "No real download in this UI test.", revision: ["fixture"] }));
    const voiceStatus = () => ({ cacheBytes: 0, memoryGB: 16, models: voiceModels(), engines: ["system", "phonon", "ming"].map((id) => ({ id,
      tier: id === "system" ? "Ready now" : id === "phonon" ? "Fast" : "Premium local",
      label: id === "system" ? "Mac voices" : id === "phonon" ? "Phonon 31m" : "Ming 3.0 · 0.5B",
      ready: loaded.has(id), available: true, note: "Synthetic voice fixture for UI verification; no model download.",
      voices: loaded.has(id) ? ["US_Emma", "UK_George", "UK_Charlotte"].map((name) => ({ id: name, label: name, language: "en-US" })) : [] })) });
    window.desktop = {
      platform: "darwin", spelling: { isMisspelled: () => false, suggestions: () => [], addToDictionary() {} },
      on(channel, listener) { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => set.delete(listener); },
      async invoke(channel, ...args) {
        if (channel === "phone:claim-key" || channel === "phone:path-key") return `fixture:${args[0]}`;
        if (channel === "phone:status") return { addresses: [{ name: "Fixture", address: "192.168.50.2" }], active: false, url: "", revision: "", inbox: [], certificate: null, encrypted: false, expiresAt: null,
          remembered: [], port: 4779, folderChosen: false, folderError: "", connectionError: "", liveRemembered: false,
          tailscale: { installed: false, running: false, magicDns: false, https: false } };
        if (channel === "table-read:status") return voiceStatus();
        if (channel === "table-read:models") return voiceModels();
        if (channel === "table-read:install") {
          if (args[1] !== true) throw new Error("Download consent missing");
          window.__downloads.push(args[0]); installed.add(args[0]);
          for (const fn of listeners.get("table-read:models-changed") ?? []) fn();
          return voiceModels();
        }
        if (channel === "table-read:prepare") { if (!installed.has(args[0])) throw new Error("Voice pack is not installed"); loaded.add(args[0]); return voiceStatus(); }
        if (channel === "table-read:synthesize") {
          window.__voiceRequests.push(args[0]);
          const bytes = new Uint8Array(48044), view = new DataView(bytes.buffer);
          const ascii = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at+i] = value.charCodeAt(i); };
          ascii(0,"RIFF"); view.setUint32(4,48036,true); ascii(8,"WAVEfmt "); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,24000,true); view.setUint32(28,48000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); ascii(36,"data"); view.setUint32(40,48000,true);
          return { audio: bytes, cached: false };
        }
        if (channel === "files:save-dialog") return "/tmp/fixture-export.csv";
        if (channel === "files:write") { window.__exports.push(args); return; }
        if (channel === "print:print") { window.__print = args[0]; return { printed: false, reason: "test", testBytes: 123 }; }
        if (channel === "settings:get") return settings;
        if (channel === "settings:set") { settings[args[0]] = args[1]; for (const fn of listeners.get("settings:changed") ?? []) fn(...args); return; }
        if (channel === "files:list-autosaves" || channel === "files:recent") return [];
        if (channel === "files:autosave-dir") return "/tmp/screenplay-fixture";
        if (channel === "ai:status") return { providers: [], active: { provider: "ollama", model: "fixture", contextChars: 36000 }, chatgpt: {}, encryption: true };
        if (channel === "dictation:format") {
          window.__requests.push(args[0]);
          if (window.__delayFormat) await new Promise((r) => setTimeout(r, window.__delayFormat));
          return { takeId: args[0].takeId, source: "text", transcript: args[0].text,
            elements: [{ type: "character", text: "MARA", uncertainty: "" }, { type: "dialogue", text: "We leave tonight.", uncertainty: "" }, { type: "character", text: "ELI", uncertainty: "" }, { type: "dialogue", text: "Not without the tape.", uncertainty: "" }],
            autoApplyErrors: window.__reviewFormat ? ["Check the speaker assignment."] : [], diagnostics: [], warnings: [], commands: [], timings: { transcribeMs: 0, formatMs: 1, totalMs: 1 } };
        }
        return undefined;
      },
    };
  };
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.evaluate(bridgeFixture);
  page.on("pageerror", (e) => { errors.push(e.message); console.error("RENDERER", e.message); });
  page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE", m.text()); });
  // Render the already-built app entirely in memory; no browser network navigation is required.
  const html = await readFile(join(root, "index.html"), "utf8");
  const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  const css = /<link[^>]+href="([^"]+)"/.exec(html)?.[1];
  assert.ok(script && css, "production assets exist");
  await page.setContent('<!doctype html><html><head><title>Screenplay smoke test</title></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: await readFile(resolve(root, css), "utf8") });
  // Substitute the virtual asset origin in this in-memory renderer smoke test.
  const javascript = (await readFile(resolve(root, script), "utf8")).replaceAll("import.meta.url", JSON.stringify("https://screenplay.test/assets/index.js"));
  await page.addScriptTag({ content: javascript, type: "module" });
  await page.waitForSelector(".editor-pm", { timeout: 8000 }).catch(async (e) => { console.error(await page.locator("body").innerText()); throw e; });
  const load = () => page.evaluate(() => {
    const a = window.__app;
    a.session.doc.load({ titlePage: [], paragraphs: [
      { id: "scene1", sceneId: "scene-1", type: "sceneHeading", runs: [{ text: "INT. EDIT SUITE - NIGHT" }] },
      { id: "action1", type: "action", runs: [{ text: "A clock blinks 2:14. Mara pulls the tape from an unmarked envelope." }] },
      { id: "mara", type: "character", runs: [{ text: "MARA" }] },
      { id: "speech", type: "dialogue", runs: [{ text: "Someone stayed to watch the credits." }] },
      { id: "rough", type: "action", runs: [{ text: "Mara says, We leave tonight. Eli says, Not without the tape." }] },
      { id: "scene2", sceneId: "scene-2", type: "sceneHeading", runs: [{ text: "EXT. PARKING GARAGE - LATER" }] },
      { id: "action2", type: "action", runs: [{ text: "Every space is empty except hers." }] },
    ] });
    a.session.name = "The Last Screening"; a.session.markDirty();
    a.editor.setSelection({ paragraphId: "rough", offset: 0 }); a.editor.focus();
  });
  const rows = () => page.evaluate(() => window.__app.session.script().paragraphs.map((p) => [p.type, p.runs.map((r) => r.text).join("")]));
  await load();
  assert.equal(await page.getByRole("button", { name: /Format Draft/ }).count(), 1); check("main-editor formatting button is visible");
  await page.getByRole("button", { name: /Format Draft/ }).click();
  await page.waitForFunction(() => window.__app.session.script().paragraphs.some((p) => p.type === "dialogue" && p.runs[0]?.text === "Not without the tape."));
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.evaluate(() => window.__requests[0].extractCommands), false); check("safe formatting replaces the draft in place without a sidebar");
  await page.keyboard.press("Meta+z");
  assert.ok((await rows()).some((r) => r[1].startsWith("Mara says,"))); check("one undo restores the raw dictated passage");
  await load();
  await page.keyboard.press("Meta+Shift+Enter");
  await page.waitForFunction(() => window.__requests.length === 2);
  await page.waitForFunction(() => window.__draftFormatter.snapshot().phase === "idle"); check("main-editor shortcut invokes formatting");
  await load();
  await page.evaluate(() => window.__reviewFormat = true);
  await page.getByRole("button", { name: /Format Draft/ }).click();
  await page.getByRole("dialog", { name: "Review draft formatting" }).waitFor();
  assert.ok((await rows()).some((r) => r[1].startsWith("Mara says,")));
  await page.getByRole("button", { name: "Keep original" }).click();
  assert.equal(await page.evaluate(() => window.__draftFormatter.snapshot().phase), "idle"); check("uncertain output opens review and Keep original is nondestructive");
  await page.evaluate(() => window.__reviewFormat = false);
  await load();
  await page.evaluate(() => { const a = window.__app; a.editor.setSelection({ paragraphId: "rough", offset: 0 }, { paragraphId: "scene2", offset: 0 }); a.editor.focus(); });
  await page.keyboard.press("Meta+5");
  assert.equal(await page.evaluate(() => window.__app.session.doc.paragraph("rough").type), "dialogue");
  assert.equal(await page.evaluate(() => window.__app.session.doc.paragraph("scene2").type), "sceneHeading"); check("element shortcut excludes unselected paragraph at end boundary");
  await load();
  await page.keyboard.press("Meta+f"); await page.getByRole("textbox", { name: "Find", exact: true }).fill("Mara");
  await page.keyboard.press("Meta+3");
  assert.equal(await page.evaluate(() => window.__app.session.doc.paragraph("rough").type), "action");
  await page.keyboard.press("Escape"); check("element shortcuts do not change the script while typing in Find");
  await page.evaluate(() => { window.__app.editor.setSelection({ paragraphId: "speech", offset: 7 }); window.__app.editor.focus(); });
  await page.getByRole("button", { name: "Plan", exact: false }).click();
  await page.getByRole("menuitemradio", { name: /Cards/ }).click();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__app.editor.getSelection().head), { paragraphId: "speech", offset: 7 }); check("view switches preserve the writing position");
  await page.getByRole("button", { name: "Focus", exact: true }).click();
  assert.equal(await page.locator(".sidepanel-left").isVisible(), false);
  await page.locator(".editor-pm").click(); await page.keyboard.press("Escape");
  assert.equal(await page.locator(".sidepanel-left").isVisible(), true); check("focus mode and Escape restore navigation");
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }); await shortcuts.waitFor();
  await page.getByRole("textbox", { name: "Search shortcuts" }).fill("dialogue");
  assert.ok(await shortcuts.locator("tr").filter({ hasText: "Dialogue" }).count());
  await shortcuts.getByRole("button", { name: "Close" }).focus(); await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
  await page.keyboard.press("Escape"); check("searchable shortcut reference traps keyboard focus");
  await page.getByRole("button", { name: /^Commands/ }).click();
  assert.ok(await page.getByRole("option").count() > 40);
  for (let i = 0; i < 45; i++) await page.keyboard.press("ArrowDown");
  const selected = page.locator('.palette [role="option"][aria-selected="true"]');
  assert.equal(await selected.count(), 1); assert.equal(await selected.isVisible(), true);
  await page.keyboard.press("Escape"); check("all command-palette results are rendered and keyboard reachable");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Draft formatting", exact: true }).click();
  await page.getByRole("button", { name: "Configure local formatter…" }).click();
  assert.equal(await page.getByRole("button", { name: "Dictation", exact: true }).getAttribute("aria-current"), "page");
  await page.keyboard.press("Escape"); check("settings navigation and formatter setup deep-link work");

  // The reading UI calls the real player and browser Audio; model/network work alone is a fixture.
  await load();
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await page.getByLabel("Voice engine", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__downloads), []); check("opening Table Read never downloads weights automatically");
  await page.getByLabel("Reading range", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => window.__voiceRequests.length > 0);
  assert.equal(await page.evaluate(() => window.__voiceRequests[0].engine), "system");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  assert.equal(await page.locator(".table-read-speaking").count(), 0); check("reader submits source text and Stop clears highlighting");
  await page.getByLabel("Voice engine", { exact: true }).selectOption("phonon");
  assert.equal(await page.getByRole("button", { name: "Play", exact: true }).isDisabled(), true);
  const installAndLoad = async (engine) => {
    const before = await page.evaluate(() => window.__downloads.length);
    await page.getByRole("button", { name: "Set up voice packs…", exact: true }).click();
    const pack = page.getByRole("region", { name: `${engine} fixture`, exact: true });
    await pack.getByRole("button", { name: "Install…", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__downloads.length), before, "opening setup and reviewing a pack never downloads it");
    await pack.getByRole("button", { name: "Confirm download", exact: true }).click();
    await page.waitForFunction((id) => window.__downloads.includes(id), engine);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Load voice engine", exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  };
  await installAndLoad("phonon");
  await page.getByRole("button", { name: "Assign distinct voices" }).click();
  await page.getByLabel("Voice for MARA", { exact: true }).selectOption("UK_George");
  await expect(page.getByLabel("Voice for MARA", { exact: true })).toHaveValue("UK_George");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => window.__voiceRequests.some((request) => request.engine === "phonon" && request.voice === "UK_George"));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  assert.equal(await page.getByLabel("Lock MARA").isChecked(), true); check("Fast mode is consent-gated and manual casting locks the voice");
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: join(output, "table-read-fast.png") }); }
  await page.getByLabel("Voice engine", { exact: true }).selectOption("ming");
  assert.equal(await page.getByRole("button", { name: "Play", exact: true }).isDisabled(), true);
  assert.ok((await page.locator(".table-reader").innerText()).includes("Three documented English presets"));
  await installAndLoad("ming");
  check("Premium local has a separate readiness state and honest voice-count limitation");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByRole("tab", { name: "Dialogue", exact: true }).click();
  await page.getByLabel("Dialogue character").selectOption("MARA");
  assert.ok((await page.getByRole("dialog", { name: "Reports", exact: true }).innerText()).includes("Someone stayed to watch the credits."));
  await page.getByRole("button", { name: "Print / PDF…", exact: true }).click();
  await page.waitForFunction(() => window.__print?.html.includes("Someone stayed to watch the credits."));
  assert.ok(await page.getByRole("tab", { name: "Tags by scene", exact: true }).count());
  assert.ok(await page.getByRole("tab", { name: "Tags by tag", exact: true }).count());
  if (output) await page.screenshot({ path: join(output, "dialogue-report.png") });
  await page.keyboard.press("Escape"); check("detailed dialogue, tag report navigation and printable report output are wired");
  await page.getByRole("separator", { name: "Resize right sidebar" }).focus();
  const oldWidth = Number(await page.getByRole("separator", { name: "Resize right sidebar" }).getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await page.getByRole("separator", { name: "Resize right sidebar" }).getAttribute("aria-valuenow"))).toBe(oldWidth + 12);
  check("sidebar widths are keyboard adjustable and saved");
  await page.evaluate(() => { window.__app.togglePanel("tableRead", false); });
  await load();
  await page.evaluate(() => { window.__app.ui.toasts = []; window.__app.emit(); });
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, "editor-light.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: join(output, "editor-dark.png") });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.screenshot({ path: join(output, "editor-compact.png") });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); check("compact layout has no page-level horizontal overflow");
  if (process.env.SCREENPLAY_HARDENING === "1") {
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    await load();
    await page.evaluate(() => window.__app.runCommand("phone.open"));
    await page.getByLabel("Phone connection protection", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Phone connection protection", { exact: true }).inputValue(), "https");
    assert.equal(await page.getByRole("button", { name: "Start phone pairing…", exact: true }).isDisabled(), true);
    await page.getByLabel("Phone connection protection", { exact: true }).selectOption("http");
    await expect(page.getByRole("button", { name: "Start phone pairing…", exact: true })).toBeEnabled();
    await page.getByLabel("Phone connection protection", { exact: true }).selectOption("https");
    assert.equal(await page.getByRole("button", { name: "Start phone pairing…", exact: true }).isDisabled(), true);
    check("phone sharing defaults to HTTPS and never silently falls back to HTTP");
    if (output) await page.screenshot({ path: join(output, "phone-https-setup.png") });
    await page.evaluate(() => window.__app.togglePanel("phone", false));

    const original = await rows();
    await page.evaluate(() => {
      const a = window.__app;
      a.session.edit(() => { a.session.doc.setField("scene1", "sceneNumber", "12A"); a.session.doc.setField("scene2", "sceneNumber", "12A"); });
      a.session.undo.stopCapturing();
    });
    const exportsBefore = await page.evaluate(() => window.__exports.length);
    await page.evaluate(() => window.__app.runCommand("print.exportPdf"));
    await page.waitForFunction(() => window.__app.ui.toasts.some(t => t.message?.includes("Duplicate scene numbers")));
    assert.equal(await page.evaluate(() => window.__exports.length), exportsBefore);
    await page.evaluate(() => window.__app.runCommand("revisions.numberConflicts"));
    await page.getByRole("dialog", { name: "Review scene number conflicts", exact: true }).waitFor();
    if (output) await page.screenshot({ path: join(output, "scene-number-review.png") });
    await page.getByRole("textbox", { name: "New number for EXT. PARKING GARAGE - LATER", exact: true }).fill("12B");
    await page.getByRole("button", { name: "Apply this number", exact: true }).last().click();
    await page.getByRole("status").filter({ hasText: "Every assigned scene number is unique." }).waitFor();
    assert.deepEqual(await rows(), original);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.evaluate(() => window.__app.session.undo.undo());
    assert.equal(await page.evaluate(() => window.__app.session.doc.paragraph("scene2").sceneNumber), "12A");
    check("duplicate production numbers block delivery; explicit resolution preserves all words and supports Undo");
    await page.evaluate(() => window.__app.session.edit(() => window.__app.session.doc.setField("scene2", "sceneNumber", "12B")));
    const beforeSides = await page.evaluate(() => JSON.stringify(window.__app.session.script()));
    await page.evaluate(() => window.__app.runCommand("delivery.open"));
    await page.getByLabel("Delivery type", { exact: true }).selectOption("sides");
    await page.getByLabel("Sides character", { exact: true }).selectOption("MARA");
    await page.getByRole("checkbox", { name: "Compact actor booklet (repaginate selected scenes)", exact: true }).check();
    const frame = page.frameLocator('iframe[title="Delivery page preview"]');
    await expect.poll(() => frame.locator("svg text").allTextContents()).toContain("Someone stayed to watch the");
    assert((await frame.locator("svg text").allTextContents()).join(" ").includes("Someone stayed to watch the credits."));
    assert.equal(await frame.getByText("Every space is empty except hers.", { exact: true }).count(), 0);
    assert.equal(await frame.locator("section").count(), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__app.session.script())), beforeSides);
    if (output) await page.screenshot({ path: join(output, "compact-actor-booklet.png") });
    await page.keyboard.press("Escape");
    check("compact actor preview includes selected scenes, excludes other words, and never changes the master");

    await load();
    await page.evaluate(() => {
      const a = window.__app;
      a.editor.setSelection({ paragraphId: "rough", offset: 2 }); a.editor.focus();
      a.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "3", code: "Digit3", metaKey: true, isComposing: true, bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.__app.session.doc.paragraph("rough").type), "action");
    check("input-method composition cannot trigger an element-change shortcut");
    await page.evaluate(async () => {
      await window.__app.setSetting("appearance.uiSize", "large");
      await window.__app.setSetting("appearance.density", "comfortable");
      await window.__app.setSetting("appearance.highContrast", true);
    });
    await page.setViewportSize({ width: 900, height: 700 });
    const client = await context.newCDPSession(page);
    const ax = await client.send("Accessibility.getFullAXTree");
    const controls = ax.nodes.filter(node => !node.ignored && ["button", "textbox", "combobox", "checkbox"].includes(node.role?.value));
    const unnamed = controls.filter(node => !String(node.name?.value ?? "").trim()).map(node => ({ role: node.role.value, id: node.backendDOMNodeId }));
    assert.deepEqual(unnamed, [], "Exposed controls should have an accessible name");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (output) {
      await page.screenshot({ path: join(output, "large-text-high-contrast.png") });
      await (await import("node:fs/promises")).writeFile(join(output, "accessibility-tree.json"), JSON.stringify({ scope: "Chromium accessibility names; not a VoiceOver or WCAG conformance audit", controls: controls.map(node => ({ role: node.role.value, name: node.name?.value })) }, null, 2));
    }
    check("large-text high-contrast writing fits a compact window and exposes named controls");
  }

  assert.deepEqual(errors, []); check("no renderer exceptions");
  console.log(`${checks.length} production-renderer smoke checks passed.`);
} finally {
  await browser?.close();
}
