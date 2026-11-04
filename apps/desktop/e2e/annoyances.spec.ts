// Everyday annoyances: where focus lands in a dialog, what closes a dialog, how long errors stay, and keyboard routes
// for actions that used to need the mouse.
import { expect, test, type Page } from "@playwright/test";
import { close, launch, runCommand } from "./helpers.ts";

async function loadScenes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "one", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. FIRST - DAY" }] },
      { id: "one-c", type: "character", runs: [{ text: "MARA" }] },
      { id: "one-d", type: "dialogue", runs: [{ text: "Hello." }] },
      { id: "two", sceneId: "s2", type: "sceneHeading", runs: [{ text: "INT. SECOND - NIGHT" }] },
      { id: "two-c", type: "character", runs: [{ text: "DEV" }] },
      { id: "two-d", type: "dialogue", runs: [{ text: "Hi." }] },
      { id: "three", sceneId: "s3", type: "sceneHeading", runs: [{ text: "EXT. THIRD - DAY" }] },
    ] }));
    app.session.undo.stopCapturing();
  });
}

const headings = (page: Page) => page.evaluate(() => (window as any).__app.session.doc.paragraphs()
  .filter((p: any) => p.type === "sceneHeading").map((p: any) => p.runs.map((r: any) => r.text).join("")));

test("dialogs open on their content, not the Close button, and a drag out of a field keeps them open", async () => {
  const run = await launch();
  try {
    await runCommand(run.page, "workspace.settings");
    const dialog = run.page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => run.page.evaluate(() => !!document.activeElement?.closest(".modal-body"))).toBe(true);
    await expect(dialog.getByRole("button", { name: "Close" })).not.toBeFocused();

    // Press inside the dialog, release on the backdrop: a text selection dragged too far.
    const box = (await dialog.boundingBox())!;
    await run.page.mouse.move(box.x + 40, box.y + 80);
    await run.page.mouse.down();
    await run.page.mouse.move(5, 5);
    await run.page.mouse.up();
    await expect(dialog).toBeVisible();

    // A real click on the backdrop still closes.
    await run.page.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});

test("error messages stay while hovered, can be dismissed, and interrupt the screen reader", async () => {
  const run = await launch();
  try {
    await run.page.evaluate(() => (window as any).__app.toast("The file could not be saved.", "error"));
    const toast = run.page.locator(".toast", { hasText: "The file could not be saved." });
    await expect(run.page.locator('[aria-live="assertive"] .toast', { hasText: "The file could not be saved." })).toBeVisible();
    await toast.hover();
    await run.page.waitForTimeout(10_500);
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Dismiss message" }).click();
    await expect(toast).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});

test("Rename Character works from the keyboard", async () => {
  const run = await launch();
  try {
    await loadScenes(run.page);
    await runCommand(run.page, "rename.open");
    const filter = run.page.getByRole("combobox", { name: "Filter characters" });
    await expect(filter).toBeFocused();
    await filter.fill("DE");
    await run.page.keyboard.press("Enter");
    await expect(run.page.getByRole("textbox", { name: "New name" })).toBeFocused();
    await expect(run.page.getByRole("option", { name: /DEV/ })).toHaveAttribute("aria-selected", "true");
    await run.page.keyboard.type("DEVON");
    await run.page.keyboard.press("Enter");
    await expect.poll(() => run.page.evaluate(() => (window as any).__app.session.doc.paragraphs()
      .filter((p: any) => p.type === "character").map((p: any) => p.runs.map((r: any) => r.text).join("")))).toEqual(["MARA", "DEVON"]);
  } finally { await close(run.electronApp, run.page); }
});

test("Go to Scene exposes its results as a listbox", async () => {
  const run = await launch();
  try {
    await loadScenes(run.page);
    await runCommand(run.page, "structure.goToScene");
    const input = run.page.getByRole("combobox", { name: "Scene" });
    await expect(input).toBeFocused();
    await expect(run.page.locator("#goto-scenes [role=option]")).toHaveCount(3);
    await run.page.keyboard.press("ArrowDown");
    await expect(input).toHaveAttribute("aria-activedescendant", "goto-scene-1");
    await expect(run.page.locator("#goto-scenes [role=option][aria-selected=true]")).toContainText("INT. SECOND - NIGHT");
  } finally { await close(run.electronApp, run.page); }
});

test("index cards and outline rows move with Option+arrow keys", async () => {
  const run = await launch();
  try {
    await loadScenes(run.page);
    await run.page.evaluate(() => (window as any).__app.setView("cards"));
    const first = run.page.locator(".cards-card", { hasText: "INT. FIRST - DAY" });
    await first.focus();
    await run.page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => headings(run.page)).toEqual(["INT. SECOND - NIGHT", "INT. FIRST - DAY", "EXT. THIRD - DAY"]);

    await run.page.evaluate(() => (window as any).__app.setView("outline"));
    await run.page.locator(".outline-heading", { hasText: "EXT. THIRD - DAY" }).focus();
    await run.page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => headings(run.page)).toEqual(["INT. SECOND - NIGHT", "EXT. THIRD - DAY", "INT. FIRST - DAY"]);

    // A synopsis field keeps Option+arrow for moving by word.
    await run.page.locator(".outline-synopsis").first().click();
    await run.page.keyboard.press("Alt+ArrowDown");
    await run.page.waitForTimeout(300);
    expect(await headings(run.page)).toEqual(["INT. SECOND - NIGHT", "EXT. THIRD - DAY", "INT. FIRST - DAY"]);
  } finally { await close(run.electronApp, run.page); }
});

test("the Revisions dialog opens on Done and New Revision Set on its name, which Return submits", async () => {
  const run = await launch();
  try {
    await runCommand(run.page, "revisions.newSet");
    const name = run.page.getByRole("textbox", { name: "Name" });
    await expect(name).toBeFocused();
    await name.fill("Blue Rev.");
    await run.page.keyboard.press("Enter");
    await expect.poll(() => run.page.locator(".revisions-row").count()).toBe(1);
    await run.page.evaluate(() => (window as any).__app.closeModal());
    await runCommand(run.page, "revisions.current");
    await expect(run.page.getByRole("button", { name: "Done" })).toBeFocused();
  } finally { await close(run.electronApp, run.page); }
});

test("the Plan menu opens on the view in use", async () => {
  const run = await launch();
  try {
    await run.page.evaluate(() => (window as any).__app.setView("outline"));
    await run.page.getByRole("button", { name: "Outline" }).click();
    await expect(run.page.getByRole("menuitemradio", { name: /Outline/ })).toBeFocused();
    await run.page.keyboard.press("Tab");
    await expect(run.page.getByRole("menu", { name: "Planning views" })).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});

test("unsaved SmartType list edits survive closing Settings", async () => {
  const run = await launch();
  try {
    const open = async () => {
      await runCommand(run.page, "workspace.settings");
      await run.page.locator(".workspace-settings nav .list-row", { hasText: "SmartType lists" }).click();
    };
    await open();
    await run.page.getByRole("textbox", { name: "SmartType names" }).fill("MARA\nDEV");
    await expect(run.page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    await run.page.keyboard.press("Escape");
    await expect(run.page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await open();
    await expect(run.page.getByRole("textbox", { name: "SmartType names" })).toHaveValue("MARA\nDEV");
    await run.page.getByRole("button", { name: "Save project lists" }).click();
    await expect(run.page.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});
