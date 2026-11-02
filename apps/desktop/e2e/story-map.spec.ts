// The story map: the page timeline, a structure point placed and pinned to a scene, and the point coming back
// when the saved file is opened again in a fresh window.
import { expect, test, type Page } from "@playwright/test";
import { ScreenplayDoc, addStructurePoint, formatPointPage, lockPages, paginate, pointPage, structurePoints } from "@screenplay/engine";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeNative, encodeNative } from "../src/renderer/core/fileformat.ts";
import { close, launch, runCommand } from "./helpers.ts";

interface Spec {
  id: string;
  type: string;
  text: string;
}

/** Five scenes of wrapped action, enough to fill several pages. */
function longScript(): Spec[] {
  const paragraphs: Spec[] = [];
  for (let scene = 1; scene <= 5; scene++) {
    paragraphs.push({ id: `s${scene}`, type: "sceneHeading", text: scene % 2 ? `INT. ROOM ${scene} - DAY` : `EXT. YARD ${scene} - NIGHT` });
    for (let line = 0; line < 24; line++) {
      paragraphs.push({
        id: `a${scene}-${line}`, type: "action",
        text: `Action line ${line} in scene ${scene}, long enough to wrap onto another line on the page and take up room.`,
      });
    }
  }
  return paragraphs;
}

async function loadScript(page: Page, specs: Spec[]): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    const paragraphs = list.map((p: Spec) => ({
      id: p.id, type: p.type, runs: p.text ? [{ text: p.text }] : [],
      ...(p.type === "sceneHeading" ? { sceneId: p.id } : {}),
    }));
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs }));
    app.session.undo.clear();
  }, specs);
}

const pointKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as any).__app.session.doc.meta.keys()]
    .filter((key: string) => key.startsWith("structurePoint.") && key.endsWith(".name"))
    .map((key: string) => key.slice(0, -".name".length)));

test("a structure point can be placed, pinned to a scene, dragged, and survives reopening the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-story-map-"));
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const native = join(dir, "Story Map.screenplay");
  let position = 0;
  try {
    await loadScript(page, longScript());

    // The script view's caret is the scene the map opens with; the playhead marks it.
    await page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a2-0", offset: 0 }));
    await page.evaluate(() => (window as any).__app.setView("storyMap"));
    await expect(page.locator(".story-map-block")).toHaveCount(5);
    expect(Number(await page.locator(".story-map").getAttribute("data-pages"))).toBeGreaterThan(2);
    await expect(page.locator(".story-map-block.on")).toHaveAttribute("data-scene-id", "s2");
    await expect(page.locator(".story-map-playhead")).toHaveCount(1);

    // Add a point. The name field has focus; Enter writes it.
    await page.getByRole("button", { name: "Add point" }).click();
    const name = page.getByLabel("Name of New point");
    await expect(name).toBeFocused();
    await name.fill("Midpoint");
    await name.press("Enter");
    await expect(page.locator(".story-map-marker-name")).toHaveText("Midpoint");
    expect(await pointKeys(page)).toHaveLength(1);

    // A target can be typed as a share of the script or as a page. 50% shows its page beside it.
    const target = page.getByLabel("Target page for Midpoint");
    await target.fill("50%");
    await target.press("Enter");
    await expect(page.locator(".story-map-share")).toHaveText("50%");

    // Pinning it to a scene compares the target with where the scene actually starts.
    await page.getByLabel("Scene for Midpoint").selectOption("s3");
    await expect(page.locator(".story-map-actual")).toContainText("Scene starts p.");
    await expect(page.locator(".story-map-actual")).toContainText(/(On target|\d+(\.\d+)? pages? (late|early))/);
    await expect(page.locator(".story-map-marker-delta")).toBeVisible();

    // Drag the marker along the timeline: the target moves and the change is one document edit.
    const key = (await pointKeys(page))[0]!;
    position = (await pointRecord(page, key)).position;
    const marker = await page.locator(".story-map-marker-label").first().boundingBox();
    expect(marker).not.toBeNull();
    await page.mouse.move(marker!.x + marker!.width / 2, marker!.y + marker!.height / 2);
    await page.mouse.down();
    await page.mouse.move(marker!.x + marker!.width / 2 + 90, marker!.y + marker!.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await pointRecord(page, key)).position)
      .toBeGreaterThan(position);
    position = (await pointRecord(page, key)).position;
    await expect(page.locator(".story-map-share")).toHaveText(`${Math.round(position * 100)}%`);

    // Save: the point is in the native file, with the scene and the dragged position.
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    }, native);
    await runCommand(page, "file.saveAs");
    await expect.poll(() => existsSync(native)).toBe(true);
    const saved = decodeNative(new Uint8Array(readFileSync(native))).doc;
    const [savedPoint] = structurePoints(saved);
    expect(savedPoint?.name).toBe("Midpoint");
    expect(savedPoint?.sceneId).toBe("s3");
    expect(savedPoint?.position).toBeCloseTo(position, 6);
    expect(errors).toEqual([]);
  } finally {
    await close(electronApp, page);
  }

  // Open the file in a fresh window: the map, the point, its target and its scene are all there.
  const second = await launch([native]);
  try {
    const page = second.page;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(() => (window as any).__app.setView("storyMap"));
    await expect(page.locator(".story-map-block")).toHaveCount(5);
    await expect(page.locator(".story-map-point")).toHaveCount(1);
    await expect(page.getByLabel("Name of Midpoint")).toHaveValue("Midpoint");
    await expect(page.getByLabel("Scene for Midpoint")).toHaveValue("s3");
    const pages = Number(await page.locator(".story-map").getAttribute("data-pages"));
    await expect(page.getByLabel("Target page for Midpoint")).toHaveValue(formatPointPage(pointPage(position, pages, Array.from({ length: pages }, (_, i) => String(i + 1)))));
    await expect(page.locator(".story-map-share")).toHaveText(`${Math.round(position * 100)}%`);
    await expect(page.locator(".story-map-marker")).toHaveCount(1);
    await expect(page.locator(".story-map-marker-delta")).toBeVisible();

    // A scene block jumps to that scene in the script.
    await page.locator('.story-map-block[data-scene-id="s3"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__app.ui.view)).toBe("script");
    await expect.poll(() => page.evaluate(() => (window as any).__app.editor?.getSelection()?.head.paragraphId)).toBe("s3");
    expect(errors).toEqual([]);
  } finally {
    await close(second.electronApp, second.page);
  }
});


async function addMidpoint(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add point" }).click();
  await page.getByLabel("Name of New point").fill("Midpoint");
  await page.getByLabel("Name of New point").press("Enter");
}

const pointRecord = (page: Page, key: string): Promise<{ position: number; sceneId?: string }> =>
  page.evaluate((id) => {
    const meta = (window as any).__app.session.doc.meta;
    return { position: meta.get(`${id}.position`), sceneId: meta.get(`${id}.sceneId`) };
  }, key);

test("undoing an unpin keeps the preceding drag, then undoing the drag restores its target", async () => {
  const { electronApp, page } = await launch();
  try {
    await loadScript(page, longScript());
    await page.evaluate(() => (window as any).__app.setView("storyMap"));
    await expect(page.locator(".story-map-block")).toHaveCount(5);
    await addMidpoint(page);
    await page.getByLabel("Scene for Midpoint").selectOption("s3");
    const key = (await pointKeys(page))[0]!;
    const before = (await pointRecord(page, key)).position;
    await page.evaluate(() => (window as any).__app.session.undo.clear());
    const marker = await page.locator(".story-map-marker-label").boundingBox();
    await page.mouse.move(marker!.x + 8, marker!.y + 8);
    await page.mouse.down();
    await page.mouse.move(marker!.x + 88, marker!.y + 8);
    await page.mouse.up();
    // Finish the next edit immediately, within Yjs's capture window.
    await page.getByLabel("Scene for Midpoint").selectOption("");
    const dragged = await pointRecord(page, key);
    expect(dragged.position).toBeGreaterThan(before);
    expect(dragged.sceneId).toBeUndefined();
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await pointRecord(page, key)).toMatchObject({ position: dragged.position, sceneId: "s3" });
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await pointRecord(page, key)).toMatchObject({ position: before, sceneId: "s3" });
  } finally {
    await close(electronApp, page);
  }
});

test("a pinned point's connector and dot align with its scene at each zoom", async () => {
  const { electronApp, page } = await launch();
  try {
    await loadScript(page, longScript());
    await page.evaluate(() => (window as any).__app.setView("storyMap"));
    await expect(page.locator(".story-map-block")).toHaveCount(5);
    await addMidpoint(page);
    await page.getByLabel("Scene for Midpoint").selectOption("s3");
    for (const zoom of ["Fit", "Zoom in", "Zoom out"]) {
      await page.getByRole("button", { name: zoom, exact: true }).click();
      const geometry = await page.evaluate(() => {
        const left = (selector: string) => parseFloat((document.querySelector(selector) as HTMLElement).style.left);
        const marker = left(".story-map-marker");
        const connector = document.querySelector(".story-map-connector") as HTMLElement;
        return {
          scene: left('.story-map-block[data-scene-id="s3"]'), marker,
          dot: marker + left(".story-map-actual-dot"),
          from: marker + parseFloat(connector.style.left), width: parseFloat(connector.style.width),
        };
      });
      expect(geometry.dot).toBeCloseTo(geometry.scene, 4);
      expect(geometry.from).toBeCloseTo(Math.min(geometry.marker, geometry.scene), 4);
      expect(geometry.width).toBeCloseTo(Math.abs(geometry.scene - geometry.marker), 4);
    }
  } finally {
    await close(electronApp, page);
  }
});

test("a missing scene stays selected until the writer clears its pin, even with no scenes left", async () => {
  const { electronApp, page } = await launch();
  try {
    await loadScript(page, [{ id: "s1", type: "sceneHeading", text: "INT. ROOM - DAY" }]);
    await page.evaluate(() => (window as any).__app.setView("storyMap"));
    await expect(page.locator(".story-map-block")).toHaveCount(1);
    await addMidpoint(page);
    await page.getByLabel("Scene for Midpoint").selectOption("s1");
    await page.evaluate(() => {
      const session = (window as any).__app.session;
      session.edit(() => session.doc.deleteParagraph("s1"));
    });
    await expect(page.locator(".story-map-block")).toHaveCount(0);
    await expect(page.getByLabel("Scene for Midpoint")).toHaveValue("s1");
    await page.getByLabel("Scene for Midpoint").selectOption("");
    expect((await pointRecord(page, (await pointKeys(page))[0]!)).sceneId).toBeUndefined();
    await expect(page.locator(".story-map-actual")).toHaveCount(0);
  } finally {
    await close(electronApp, page);
  }
});

test("locked printed labels appear on scenes, ruler and targets, and 2A is a target", async () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [1, 2, 3, 4].map((n) => ({
    id: `s${n}`, sceneId: `s${n}`, type: "sceneHeading", startsNewPage: true,
    runs: [{ text: `INT. ROOM ${n} - DAY` }],
  })) });
  const pagination = paginate(doc.toScript());
  const labels = ["1", "2", "2A", "3"];
  pagination.pages.forEach((page, i) => { page.number = labels[i]!; });
  lockPages(doc, pagination);
  addStructurePoint(doc, { name: "Midpoint", position: 0.5, sceneId: "s3" });
  const path = join(mkdtempSync(join(tmpdir(), "screenplay-story-map-labels-")), "Locked.screenplay");
  writeFileSync(path, encodeNative(doc));
  const { electronApp, page } = await launch([path]);
  try {
    await page.evaluate(() => (window as any).__app.setView("storyMap"));
    await expect(page.locator('.story-map-block[data-scene-id="s3"]')).toHaveAttribute("title", /p\. 2A$/);
    await expect(page.locator('.story-map-block[data-scene-id="s4"]')).toHaveAccessibleName(/page 3\b/);
    await expect(page.locator(".story-map-tick > span")).toHaveText(labels);
    await expect(page.locator(".story-map-actual")).toContainText("Scene starts p. 2A");
    const target = page.getByLabel("Target page for Midpoint");
    await expect(target).toHaveValue("p. 2A");
    await target.fill("3");
    await target.press("Enter");
    await expect(page.locator(".story-map-share")).toHaveText("75%");
    await target.fill("2A");
    await target.press("Enter");
    await expect(page.locator(".story-map-share")).toHaveText("50%");
    await expect(target).toHaveValue("p. 2A");
    await expect(page.locator(".story-map-marker-label")).toHaveAttribute("aria-label", /target p\. 2A, scene at p\. 2A/);
  } finally {
    await close(electronApp, page);
  }
});
