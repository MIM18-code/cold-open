// Quick note capture (⌘⇧M) and the "Since last time" tray, in the built app. The tray is proved across two real
// launches that share one user-data folder, the way a writer's next day works. Screenshots of the box and the tray
// are taken when SCREENPLAY_SCREENSHOTS names a folder.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeNative, encodeNative } from "../src/renderer/core/fileformat.ts";
import { createRecord, putRecord } from "../src/renderer/features/rewrite/records.ts";
import { fakeSpeechHelper } from "./fakes.ts";
import { close, launch, runCommand } from "./helpers.ts";

const OUT = process.env.SCREENPLAY_SCREENSHOTS;
const SPOKEN = "Maya should hesitate before she opens the door.";
const FAKE_MIC = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const KEY = "ControlOrMeta";

async function seed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h", sceneId: "scene-one", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
      { id: "a", type: "action", runs: [{ text: "Maya waits beside the door." }] },
      { id: "m", type: "character", runs: [{ text: "MAYA" }] },
      { id: "d", type: "dialogue", runs: [{ text: "Open the door." }] },
    ] }));
    app.session.undo.clear();
    app.editor.setSelection({ paragraphId: "d", offset: 4 });
    app.editor.focus();
  });
}

const notes = (page: Page) => page.evaluate(() => {
  const meta = (window as any).__app.session.doc.meta as Map<string, any>;
  return [...meta.entries()].filter(([k]) => k.startsWith("workbench.record.")).map(([, v]) => v)
    .map((r) => ({ id: r.id, text: r.text, author: r.author, resolved: !!r.resolved, anchor: r.anchor?.paragraphId, parentId: r.parentId }));
});
const box = (page: Page) => page.getByRole("dialog", { name: "Quick note" });
const tray = (page: Page) => page.getByRole("complementary", { name: "Since last time" });

async function shot(page: Page, name: string): Promise<void> {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

async function chooseHelper(electronApp: ElectronApplication, page: Page, path: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
  }, path);
  await page.evaluate(() => (window as any).desktop.invoke("dictation:choose-helper"));
}

test("⌘⇧M opens a small box that saves as you type, with no Save button and one undo step", async () => {
  const run = await launch();
  try {
    await seed(run.page);
    const { page } = run;
    await page.keyboard.press(`${KEY}+Shift+M`);
    await expect(box(page)).toBeVisible();
    await expect(box(page).getByRole("textbox", { name: "Quick note text" })).toBeFocused();
    await expect(box(page).getByRole("button", { name: /save/i })).toHaveCount(0);
    await expect(box(page)).toContainText("Attached to “Open the door.”");
    await page.keyboard.type("Make this quieter");
    // Saved while the box is still open: nothing waits for a close or a Save.
    await expect.poll(async () => (await notes(page)).map((n) => n.text)).toEqual(["Make this quieter"]);
    await shot(page, "quick-note-light");
    await page.keyboard.press(`${KEY}+Enter`);
    await expect(box(page)).toHaveCount(0);
    await expect(page.locator(".editor-pm")).toBeFocused();
    expect(await notes(page)).toMatchObject([{ text: "Make this quieter", author: "Writer", anchor: "d" }]);
    await runCommand(page, "rewrite.open");
    await expect(page.locator(".rewrite-item").filter({ hasText: "Make this quieter" })).toBeVisible();
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await notes(page)).toEqual([]);
  } finally { await close(run.electronApp, run.page); }
});

test("an empty box leaves nothing behind, and Escape right after typing still keeps the words", async () => {
  const run = await launch();
  try {
    await seed(run.page);
    const { page } = run;
    await page.keyboard.press(`${KEY}+Shift+M`);
    await expect(box(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveCount(0);
    expect(await notes(page)).toEqual([]);
    await page.keyboard.press(`${KEY}+Shift+M`);
    await page.keyboard.type("Typed then gone");
    await page.keyboard.press(`${KEY}+A`);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveCount(0);
    await expect.poll(() => notes(page)).toEqual([]);
    // Escape before the typing pause has run: closing writes the note.
    await page.keyboard.press(`${KEY}+Shift+M`);
    await page.keyboard.type("Quick one");
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveCount(0);
    expect(await notes(page)).toMatchObject([{ text: "Quick one" }]);
  } finally { await close(run.electronApp, run.page); }
});

test("a script too full to take another note keeps the box open with the reason, so nothing typed is lost", async () => {
  const run = await launch();
  try {
    await seed(run.page);
    const { page } = run;
    await page.evaluate(() => {
      const s = (window as any).__app.session, now = new Date().toISOString();
      s.edit(() => { for (let i = 0; i < 400; i++) {
        const id = `full-script-note-${String(i).padStart(4, "0")}`;
        s.doc.meta.set(`workbench.record.${id}`, { id, revision: "r", kind: "note", title: "", text: "x", created: now, updated: now });
      } });
    });
    await page.keyboard.press(`${KEY}+Shift+M`);
    const text = box(page).getByRole("textbox", { name: "Quick note text" });
    await text.fill("One more idea");
    await page.keyboard.press("Escape");
    await expect(box(page)).toBeVisible();
    await expect(box(page)).toContainText("400 project items");
    await expect(text).toHaveValue("One more idea");
  } finally { await close(run.electronApp, run.page); }
});

test("it works with the caret outside the script, and not at all in a read-only script", async () => {
  const run = await launch();
  try {
    await seed(run.page);
    const { page } = run;
    await page.evaluate(() => (window as any).__app.setView("cards"));
    await page.keyboard.press(`${KEY}+Shift+M`);
    await expect(box(page)).toBeVisible();
    await expect(box(page)).toContainText(/Not attached|Attached to/);
    await page.keyboard.type("Planning idea");
    await page.keyboard.press("Escape");
    expect(await notes(page)).toMatchObject([{ text: "Planning idea" }]);
    await page.evaluate(() => (window as any).__app.setView("script"));
    await page.evaluate(() => (window as any).__app.session.setReadOnly(true));
    await page.keyboard.press(`${KEY}+Shift+M`);
    await expect(box(page)).toHaveCount(0);
    await runCommand(page, "rewrite.open");
    await expect(page.getByRole("button", { name: "New note", exact: true })).toBeDisabled();
  } finally { await close(run.electronApp, run.page); }
});

test("the microphone writes what was said into the note, not into the script", async () => {
  const folder = mkdtempSync(join(tmpdir(), "quick-note-mic-"));
  // No formatting model is running, so this also proves the note box never asks for one.
  const run = await launch(FAKE_MIC);
  try {
    await chooseHelper(run.electronApp, run.page, fakeSpeechHelper(folder, SPOKEN));
    await seed(run.page);
    const { page } = run;
    const before = await page.evaluate(() => (window as any).__app.session.script().paragraphs.length);
    await page.keyboard.press(`${KEY}+Shift+M`);
    const text = box(page).getByRole("textbox", { name: "Quick note text" });
    await text.fill("Remember:");
    const mic = box(page).locator(".quick-note-mic");
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await expect(mic).toContainText("Stop");
    await page.waitForTimeout(1300);
    await shot(page, "quick-note-recording-light");
    await mic.click();
    await expect(text).toHaveValue(`Remember: ${SPOKEN}`, { timeout: 20_000 });
    await expect.poll(async () => (await notes(page)).map((n) => n.text)).toEqual([`Remember: ${SPOKEN}`]);
    expect(await page.evaluate(() => (window as any).__app.session.script().paragraphs.length)).toBe(before);
    await expect(page.locator(".dictation")).toHaveCount(0);

    // Done while the words are still being written down (a slow helper): the box goes at once, the words join that
    // note when they arrive, and a note opened meanwhile is kept.
    await page.keyboard.press("Escape");
    await expect(box(page)).toHaveCount(0);
    await chooseHelper(run.electronApp, page, fakeSpeechHelper(mkdtempSync(join(tmpdir(), "quick-note-slow-")), SPOKEN, 4000));
    await page.keyboard.press(`${KEY}+Shift+M`);
    await text.fill("Second take:");
    await mic.click();
    await expect(mic).toContainText("Stop");
    await page.waitForTimeout(1300);
    await box(page).getByRole("button", { name: "Done" }).click();
    await expect(box(page)).toHaveCount(0, { timeout: 1000 });
    await page.keyboard.press(`${KEY}+Shift+M`);
    await text.fill("Opened while it was transcribing");
    await expect.poll(async () => (await notes(page)).map((n) => n.text).sort(), { timeout: 20_000 })
      .toEqual(["Opened while it was transcribing", `Remember: ${SPOKEN}`, `Second take: ${SPOKEN}`]);
    await expect(text).toHaveValue("Opened while it was transcribing");

    // A voice-only note whose script closes before its words arrive shows them instead of writing them nowhere.
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${KEY}+Shift+M`);
    await mic.click();
    await expect(mic).toContainText("Stop");
    await page.waitForTimeout(1300);
    await box(page).getByRole("button", { name: "Done" }).click();
    await page.evaluate(() => { const a = (window as any).__app; a.setSession(a.session.constructor.untitled()); });
    await expect(page.getByText(`The script closed before your words joined the note: “${SPOKEN}”`)).toBeVisible({ timeout: 20_000 });
  } finally { await close(run.electronApp, run.page); }
});

test("without a working speech helper the box says what to do and still takes typing", async () => {
  const folder = mkdtempSync(join(tmpdir(), "quick-note-nomic-"));
  const broken = join(folder, "speech-helper");
  writeFileSync(broken, "#!/bin/sh\nexit 1\n");
  chmodSync(broken, 0o755);
  const run = await launch(FAKE_MIC);
  try {
    await chooseHelper(run.electronApp, run.page, broken);
    await seed(run.page);
    const { page } = run;
    await page.keyboard.press(`${KEY}+Shift+M`);
    const mic = box(page).locator(".quick-note-mic");
    await mic.click();
    await page.waitForTimeout(1200);
    await mic.click();
    await expect(box(page).getByRole("status")).toContainText("Dictation isn't set up", { timeout: 20_000 });
    await expect(box(page).getByRole("status")).toContainText("Settings > Dictation");
    await shot(page, "quick-note-unavailable-light");
    await page.keyboard.type("Typing still works");
    await page.keyboard.press("Escape");
    expect(await notes(page)).toMatchObject([{ text: "Typing still works" }]);
  } finally { await close(run.electronApp, run.page); }
});

test("Since last time lists what arrived while the writer was away, and lets them act on it", async () => {
  test.setTimeout(120_000);
  const first = await launch();
  const { userData } = first;
  const path = join(userData, "story.screenplay");
  try {
    await seed(first.page);
    await first.electronApp.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as any;
    }, path);
    await runCommand(first.page, "file.saveAs");
    await expect.poll(() => first.page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    // A script this Mac has not seen before shows nothing, and starts remembering it.
    await expect(tray(first.page)).toHaveCount(0);
    await expect.poll(() => first.page.evaluate(() => Object.keys((window as any).__app.settings).filter((k) => k.startsWith("notes.since.")).length)).toBe(1);
    // A note that arrives during that first visit, such as one filed from the phone, still shows.
    await first.page.evaluate(() => {
      const s = (window as any).__app.session, now = new Date().toISOString();
      s.edit(() => s.doc.meta.set("workbench.record.first-visit-note-0001", { id: "first-visit-note-0001", revision: "r1", kind: "note",
        title: "Phone note", text: "Arrived on the first visit", author: "Phone", created: now, updated: now }));
    });
    await expect(tray(first.page)).toContainText("Arrived on the first visit");
  } finally { await close(first.electronApp, first.page); }
  const settingsFile = join(userData, "settings.json");
  await expect.poll(() => existsSync(settingsFile) && /notes\.since\./.test(readFileSync(settingsFile, "utf8"))).toBe(true);

  // While the writer is away the phone and a co-writer leave notes, and an older note and a reply sit in the file.
  // (The first window wrote its last-seen time as it closed; everything below is later than that.)
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const doc = decodeNative(readFileSync(path)).doc;
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const phone = { ...createRecord("note", "Phone note", "Ask Mara about the key", { author: "Phone" }), created: at(400) };
  const dana = { ...createRecord("note", "", "Trim the last line of the scene", { author: "Dana" }), created: at(300) };
  const old = { ...createRecord("note", "", "An older note", { author: "Dana" }), created: at(86_400_000) };
  const done = { ...createRecord("note", "", "Already handled", { author: "Dana", resolved: true }), created: at(200) };
  const reply = { ...createRecord("note", "", "A reply", { author: "Dana", parentId: phone.id }), created: at(100) };
  for (const record of [phone, dana, old, done, reply]) putRecord(doc, record);
  writeFileSync(path, encodeNative(doc));

  const second = await launch([path], userData);
  try {
    const { page, electronApp } = second;
    await expect(tray(page)).toBeVisible();
    const items = tray(page).locator(".since-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Dana");
    await expect(items.nth(1)).toContainText("Ask Mara about the key");
    await expect(items.nth(1).locator(".since-author")).toHaveText("Phone");
    await expect(tray(page).getByRole("button", { name: "New note" })).toBeEnabled();
    await shot(page, "since-last-time-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "since-last-time-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // Pin to passage anchors the note where the caret is.
    await page.evaluate(() => { const a = (window as any).__app; a.editor.setSelection({ paragraphId: "d", offset: 2 }); });
    await items.nth(1).getByRole("button", { name: "Pin to passage" }).click();
    await expect.poll(async () => (await notes(page)).find((n) => n.id === phone.id)?.anchor).toBe("d");

    // Resolve changes the document; Dismiss does not.
    await items.nth(0).getByRole("button", { name: "Resolve" }).click();
    await expect(items).toHaveCount(1);
    expect((await notes(page)).find((n) => n.id === dana.id)?.resolved).toBe(true);
    await items.nth(0).getByRole("button", { name: "Dismiss" }).click();
    await expect(items).toHaveCount(0);
    await expect(tray(page)).toContainText("Nothing new since you last worked on this script.");
    expect((await notes(page)).find((n) => n.id === phone.id)?.resolved).toBe(false);
    const remembered = await page.evaluate(() => {
      const s = (window as any).__app.settings as Record<string, any>;
      return Object.entries(s).filter(([k]) => k.startsWith("notes.since.")).map(([, v]) => v.dismissed);
    });
    expect(remembered).toEqual([[phone.id]]);

    // A note the writer makes now is theirs and does not appear in the tray.
    await page.keyboard.press(`${KEY}+Shift+M`);
    await page.keyboard.type("My own thought");
    await page.keyboard.press(`${KEY}+Enter`);
    await expect.poll(async () => (await notes(page)).some((n) => n.text === "My own thought")).toBe(true);
    await expect(items).toHaveCount(0);

    // After the tray is closed it stays closed; a phone note arriving mid-session shows in the status bar instead.
    await tray(page).getByRole("button", { name: "Close Since last time" }).click();
    await expect(tray(page)).toHaveCount(0);
    await page.evaluate(() => {
      const s = (window as any).__app.session, now = new Date().toISOString();
      s.edit(() => s.doc.meta.set("workbench.record.live-phone-note-0001", {
        id: "live-phone-note-0001", revision: "r1", kind: "note", title: "Phone note", text: "Live from the phone", created: now, updated: now, author: "Phone",
      }));
    });
    await expect(tray(page)).toHaveCount(0);
    const status = page.locator(".statusbar").getByRole("button", { name: "1 new note" });
    await expect(status).toBeVisible();
    await status.click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Live from the phone");
    await expect(page.locator(".statusbar").getByRole("button", { name: /new note/ })).toHaveCount(0);

    // Quick note while the tray is up (picture of both together).
    await page.evaluate(() => (window as any).__app.togglePanel("rewrite", true));
    await page.keyboard.press(`${KEY}+Shift+M`);
    await page.keyboard.type("Both on screen at once");
    await shot(page, "box-and-tray-light");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await shot(page, "box-and-tray-dark");
    await page.keyboard.press("Escape");
    void electronApp;
  } finally { await close(second.electronApp, second.page); }
});
