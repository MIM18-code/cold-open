import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFdx } from "@screenplay/engine";
import { test, expect } from "@playwright/test";
import { close, confirmNextPrompt, launch, runCommand } from "./helpers.ts";

test("production panel navigates scenes and advances only the successfully captured handoff", async () => {
  const { electronApp, page } = await launch();
  try {
    // Fake Backlot's transport boundary; the real panel, capture, document and editor run in Electron.
    await electronApp.evaluate(({ ipcMain }) => {
      for (const channel of ["backlot:choose", "backlot:preview", "backlot:apply", "backlot:production-state"]) ipcMain.removeHandler(channel);
      let captured: any;
      (globalThis as any).handoffOutcome = "cancel";
      ipcMain.handle("backlot:choose", () => ({ title: "Film", project: "/project.json", projectId: "project" }));
      ipcMain.handle("backlot:production-state", () => ({ projectId: "project", scenes: [
        { sceneId: "production-a", headingId: "h1", scheduled: true, issuedCallSheet: true },
      ] }));
      ipcMain.handle("backlot:preview", (_event, _xml, _options, source) => {
        captured = source.current;
        return { id: "plan", revision: 1, plan: { unresolved: [] }, unresolved: [], addedElements: 0, removedElements: 0 };
      });
      ipcMain.handle("backlot:apply", () => {
        if ((globalThis as any).handoffOutcome === "cancel") return null;
        if ((globalThis as any).handoffOutcome === "fail") throw new Error("Backlot changed since preview");
        return { revision: 2, project: "Film", baseline: { ...captured, sentAt: "2026-11-01T00:00:00Z", projectId: "project", revision: 2 } };
      });
    });
    await page.evaluate(() => {
      const a = (window as any).__app;
      a.session.edit(() => a.session.doc.load({ titlePage: [], paragraphs: [
        { id: "h1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
        { id: "a1", type: "action", runs: [{ text: "A car waits." }] },
        { id: "h2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "EXT. ROAD - NIGHT" }] },
      ] }));
      a.togglePanel("backlot.productionChanges", true);
    });
    const panel = page.locator(".production-changes");
    await expect(panel.getByText("Not sent to Backlot yet, so every scene is new.")).toBeVisible();
    await expect(panel.getByText("Needs Backlot review · issued call sheet")).toBeVisible();
    await panel.getByRole("button", { name: /EXT. ROAD/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__app.editor.getSelection()?.head.paragraphId)).toBe("h2");
    await runCommand(page, "backlot.handoff");
    await page.getByRole("button", { name: "Choose open Backlot project…" }).click();
    await page.getByRole("button", { name: "Preview captured draft" }).click();
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Apply reviewed import…" }).click();
    expect(await page.evaluate(() => [...(window as any).__app.session.doc.meta.keys()].some(key => key.startsWith("backlot.handoffBaseline")))).toBe(false);
    await electronApp.evaluate(() => { (globalThis as any).handoffOutcome = "fail"; });
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Apply reviewed import…" }).click();
    await expect(page.getByRole("alert")).toContainText("Backlot changed since preview");
    expect(await page.evaluate(() => [...(window as any).__app.session.doc.meta.keys()].some(key => key.startsWith("backlot.handoffBaseline")))).toBe(false);
    // Continue writing after capture. Success must retain these later changes in the panel.
    await page.evaluate(() => { const s = (window as any).__app.session; s.edit(() => s.doc.replaceText("h1", 0, 15, "INT. KITCHEN - NIGHT")); });
    await electronApp.evaluate(() => { (globalThis as any).handoffOutcome = "success"; });
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Apply reviewed import…" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Applied to Film" })).toBeVisible();
    await page.locator(".modal-actions").getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel.getByText("Heading: INT. ROOM - DAY → INT. KITCHEN - NIGHT")).toBeVisible();
    await expect(panel.getByRole("button", { name: /EXT. ROAD/ })).toHaveCount(0);
    await page.screenshot({ path: "/tmp/cold-open-production-changes.png" });
    // The successful baseline is production state. Script Undo must not erase it.
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    await expect(panel.getByText("Changes since you last sent this script to Backlot.")).toBeVisible();
  } finally { await close(electronApp, page); }
});

test("a Finder-renamed FDX starts fresh in the production panel", async () => {
  const folder = await mkdtemp(join(tmpdir(), "production-rename-"));
  const original = join(folder, "Draft.fdx"), renamed = join(folder, "Renamed.fdx");
  await writeFile(original, writeFdx({ titlePage: [], paragraphs: [
    { id: "room-heading", sceneId: "room-scene", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "road-heading", sceneId: "road-scene", type: "sceneHeading", runs: [{ text: "EXT. ROAD - NIGHT" }] },
  ] }));
  let instance = await launch([original]);
  const userData = instance.userData;
  try {
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.path)).toBe(original);
    await instance.electronApp.evaluate(({ ipcMain }) => {
      for (const channel of ["backlot:choose", "backlot:preview", "backlot:apply"]) ipcMain.removeHandler(channel);
      let captured: any;
      ipcMain.handle("backlot:choose", () => ({ title: "Film", project: "/project.json", projectId: "project" }));
      ipcMain.handle("backlot:preview", (_event, _xml, _options, source) => {
        captured = source.current;
        return { id: "plan", revision: 1, plan: {}, unresolved: [], addedElements: 0, removedElements: 0 };
      });
      ipcMain.handle("backlot:apply", () => ({ revision: 2, project: "Film", baseline: {
        ...captured, sentAt: "2026-11-01T00:00:00Z", projectId: "project", revision: 2,
      } }));
    });
    await runCommand(instance.page, "backlot.handoff");
    await instance.page.getByRole("button", { name: "Choose open Backlot project…" }).click();
    await instance.page.getByRole("button", { name: "Preview captured draft" }).click();
    await confirmNextPrompt(instance.electronApp);
    await instance.page.getByRole("button", { name: "Apply reviewed import…" }).click();
    await expect(instance.page.getByRole("status").filter({ hasText: "Applied to Film" })).toBeVisible();
    await close(instance.electronApp, instance.page);
    await rename(original, renamed);
    instance = await launch([renamed], userData);
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.path)).toBe(renamed);
    await instance.page.evaluate(() => (window as any).__app.togglePanel("backlot.productionChanges", true));
    const panel = instance.page.locator(".production-changes");
    await expect(panel.getByText("Not sent to Backlot yet, so every scene is new.")).toBeVisible();
    await expect(panel.locator(".production-change")).toHaveCount(2);
    await expect(panel.getByText("Added", { exact: true })).toHaveCount(2);
  } finally {
    await close(instance.electronApp, instance.page);
    await rm(folder, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

for (const format of ["fdx", "fountain"] as const) test(`${format} handoff baseline survives quitting and reopening the saved script`, async () => {
  const folder = await mkdtemp(join(tmpdir(), "production-reopen-"));
  const path = join(folder, "Draft." + format);
  const heading = "d9a2a29c-b32c-4c14-b604-8e5209665623";
  await writeFile(path, format === "fountain" ? "INT. ROOM - DAY\n\nA car waits.\n" : writeFdx({ titlePage: [], paragraphs: [
    { id: heading, sceneId: heading, type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "beaeb76a-b8af-4ada-8b50-ac4d2bd590d7", type: "action", runs: [{ text: "A car waits." }] },
  ] }));
  let instance = await launch([path]);
  const userData = instance.userData;
  try {
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.path)).toBe(path);
    await instance.electronApp.evaluate(({ ipcMain }) => {
      for (const channel of ["backlot:choose", "backlot:preview", "backlot:apply"]) ipcMain.removeHandler(channel);
      let captured: any;
      ipcMain.handle("backlot:choose", () => ({ title: "Film", project: "/project.json", projectId: "project" }));
      ipcMain.handle("backlot:preview", (_event, _xml, _options, source) => {
        captured = source.current;
        return { id: "plan", revision: 1, plan: {}, unresolved: [], addedElements: 0, removedElements: 0 };
      });
      ipcMain.handle("backlot:apply", () => ({ revision: 2, project: "Film", baseline: {
        ...captured, sentAt: "2026-11-01T00:00:00Z", projectId: "project", revision: 2,
      } }));
    });
    await runCommand(instance.page, "backlot.handoff");
    await instance.page.getByRole("button", { name: "Choose open Backlot project…" }).click();
    await instance.page.getByRole("button", { name: "Preview captured draft" }).click();
    await confirmNextPrompt(instance.electronApp);
    await instance.page.getByRole("button", { name: "Apply reviewed import…" }).click();
    await expect(instance.page.getByRole("status").filter({ hasText: "Applied to Film" })).toBeVisible();
    await instance.page.locator(".modal-actions").getByRole("button", { name: "Close", exact: true }).click();
    await instance.page.evaluate(() => {
      const a = (window as any).__app, s = a.session;
      const id = s.script().paragraphs.find((p: any) => p.type === "sceneHeading").id;
      s.edit(() => s.doc.replaceText(id, 0, 15, "INT. KITCHEN - NIGHT"));
      a.togglePanel("backlot.productionChanges", true);
    });
    await runCommand(instance.page, "file.save");
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    await close(instance.electronApp, instance.page);
    instance = await launch([path], userData);
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.path)).toBe(path);
    await instance.page.evaluate(() => (window as any).__app.togglePanel("backlot.productionChanges", true));
    const panel = instance.page.locator(".production-changes");
    await expect(panel.getByText("Changes since you last sent this script to Backlot.")).toBeVisible();
    await expect(panel.getByText("Heading: INT. ROOM - DAY → INT. KITCHEN - NIGHT")).toBeVisible();
    await expect(panel.getByText("Added", { exact: true })).toHaveCount(0);
    await expect(panel.getByText(/Save as .screenplay/)).toHaveCount(0);
    expect(await instance.page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    const copy = join(folder, "Copy.screenplay");
    await instance.electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, copy);
    await runCommand(instance.page, "file.saveAs");
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.path)).toBe(copy);
    await close(instance.electronApp, instance.page);
    instance = await launch([copy], userData);
    await expect.poll(() => instance.page.evaluate(() => (window as any).__app.session.path)).toBe(copy);
    await instance.page.evaluate(() => (window as any).__app.togglePanel("backlot.productionChanges", true));
    await expect(instance.page.locator(".production-changes").getByText("Heading: INT. ROOM - DAY → INT. KITCHEN - NIGHT")).toBeVisible();
  } finally {
    await close(instance.electronApp, instance.page);
    await rm(folder, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
