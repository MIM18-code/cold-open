// Saving a .screenplay that another Mac (through folder sync) or another window saved over since this one did.
import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainText } from "@screenplay/engine";

import { decodeNative, encodeNative } from "../src/renderer/core/fileformat.ts";
import { close, launch, runCommand } from "./helpers.ts";

test("Save merges a copy of the same script saved elsewhere instead of refusing", async () => {
  const { electronApp, page, userData } = await launch();
  try {
    const path = join(userData, "shared.screenplay");
    await page.evaluate(() => {
      const a = (window as any).__app;
      a.session.edit(() => a.session.doc.load({ titlePage: [], paragraphs: [
        { id: "h", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. KITCHEN - DAY" }] },
        { id: "a", type: "action", runs: [{ text: "A brass key rests on the table." }] },
      ] }));
    });
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any;
    }, path);
    await runCommand(page, "file.saveAs");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);

    // The other Mac opens the same file, adds a line and its save lands in the shared folder.
    const other = decodeNative(readFileSync(path)).doc;
    other.insertText("a", "A brass key rests on the table.".length, " Nobody touches it.");
    writeFileSync(path, encodeNative(other));

    // This window keeps writing and saves.
    await page.evaluate(() => {
      const s = (window as any).__app.session;
      s.edit(() => s.doc.insertText("h", "INT. KITCHEN - ".length, "LATE "));
    });
    await runCommand(page, "file.save");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    await expect(page.locator(".modal-backdrop, [role=alertdialog]")).toHaveCount(0);

    const saved = decodeNative(readFileSync(path)).doc.toScript().paragraphs.map((p) => plainText(p.runs));
    expect(saved).toEqual(["INT. KITCHEN - LATE DAY", "A brass key rests on the table. Nobody touches it."]);
    // This window's version from before the merge is in Draft History.
    const labels = await page.evaluate(async () => {
      const id = (window as any).__app.session.doc.meta.get("history.documentId");
      return ((await (window as any).desktop.invoke("history:list", id)) as { label: string }[]).map((e) => e.label);
    });
    expect(labels).toContain("Before merging another copy");
    const inWindow = await page.evaluate(() => (window as any).__app.session.doc.paragraph("a").runs.map((r: any) => r.text).join(""));
    expect(inWindow).toBe("A brass key rests on the table. Nobody touches it.");
  } finally {
    await close(electronApp, page);
  }
});
