// Navigator, index cards and outline, driven through window.__app and the real UI in a hidden window.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { ScreenplayDoc, moveScene, moveSection } from "@screenplay/engine";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeNative } from "../src/renderer/core/fileformat.ts";
import { close, launch, runCommand } from "./helpers.ts";

/**
 * Launch the app, run the test body, and always close it. The document counts as saved first: a changed
 * document would make the window ask whether to save, and that native dialog would block the close.
 */
async function withApp(run: (page: Page) => Promise<void>): Promise<void> {
  const { electronApp, page } = await launch();
  try {
    await run(page);
  } finally {
    await page.evaluate(() => { (window as any).__app.session.dirty = false; }).catch(() => undefined);
    await electronApp.close().catch(() => undefined);
  }
}

interface Spec {
  id: string;
  type: string;
  text: string;
  depth?: number;
}

/** A small script: a cold open, Act One (with a sequence) and Act Two. */
function smallScript(): Spec[] {
  return [
    { id: "s1", type: "sceneHeading", text: "INT. COLD OPEN - NIGHT" },
    { id: "a1", type: "action", text: "Wind." },
    { id: "act1", type: "section", text: "ACT ONE", depth: 1 },
    { id: "s2", type: "sceneHeading", text: "INT. OFFICE - DAY" },
    { id: "c2", type: "character", text: "NELL" },
    { id: "d2", type: "dialogue", text: "Well?" },
    { id: "s3", type: "sceneHeading", text: "EXT. YARD - NIGHT" },
    { id: "a3", type: "action", text: "Rain on the sedans." },
    { id: "act2", type: "section", text: "ACT TWO", depth: 1 },
    { id: "s4", type: "sceneHeading", text: "INT. DINER - DAY" },
    { id: "a4", type: "action", text: "Coffee." },
    { id: "s5", type: "sceneHeading", text: "EXT. ROAD - CONTINUOUS" },
    { id: "a5", type: "action", text: "Dust." },
  ];
}

async function loadScript(page: Page, specs: Spec[]): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    const paragraphs = list.map((p: Spec) => ({
      id: p.id, type: p.type, runs: p.text ? [{ text: p.text }] : [],
      ...(p.type === "sceneHeading" ? { sceneId: p.id } : {}),
      ...(p.depth ? { depth: p.depth } : {}),
    }));
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs }));
    app.session.undo.clear();
  }, specs);
}

/** The script as rows of "type:text", read from the page's document. */
const rows = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as any).__app.session.doc.toScript().paragraphs.map((p: any) => `${p.type}:${p.runs.map((r: any) => r.text).join("")}`));

const headings = async (page: Page) => (await rows(page)).filter((r) => r.startsWith("sceneHeading:")).map((r) => r.slice("sceneHeading:".length));

/** A peer applies the engine's moveScene to its replica; the page receives the result as a remote update. */
async function peerEdit(page: Page, edit: (doc: ScreenplayDoc) => void): Promise<void> {
  const state: number[] = await page.evaluate(() => Array.from((window as any).__app.session.doc.encodeState()));
  const peer = ScreenplayDoc.fromUpdate(new Uint8Array(state));
  edit(peer);
  await page.evaluate((update) => (window as any).__app.session.doc.applyUpdate(new Uint8Array(update), "remote"), Array.from(peer.encodeState()));
}

const OPEN = "INT. COLD OPEN - NIGHT", OFFICE = "INT. OFFICE - DAY", YARD = "EXT. YARD - NIGHT", DINER = "INT. DINER - DAY", ROAD = "EXT. ROAD - CONTINUOUS";

test("the navigator lists scenes, follows engine moves, numbers scenes and reorders by drag", async () => {
  await withApp(async (page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loadScript(page, smallScript());

    const list = page.locator(".navigator-row .navigator-heading");
    await expect(list).toHaveText([OPEN, OFFICE, YARD, DINER, ROAD]);
    await expect(page.locator(".navigator-section")).toHaveText(["ACT ONE", "ACT TWO"]);

    // Number Scenes and Remove Scene Numbers, from the Script menu commands.
    await runCommand(page, "structure.numberScenes");
    expect(await page.evaluate(() => (window as any).__app.session.doc.scenes().map((s: any) => s.number))).toEqual(["1", "2", "3", "4", "5"]);
    await runCommand(page, "structure.removeSceneNumbers");
    expect(await page.evaluate(() => (window as any).__app.session.doc.scenes().map((s: any) => s.number))).toEqual([undefined, undefined, undefined, undefined, undefined]);

    // A peer moves a scene with the engine; the panel updates live and the IDs survive.
    await peerEdit(page, (doc) => moveScene(doc, "s2", "s5"));
    await expect(list).toHaveText([OPEN, YARD, DINER, OFFICE, ROAD]);
    expect(await page.evaluate(() => (window as any).__app.session.doc.validate())).toEqual([]);
    expect(await page.evaluate(() => (window as any).__app.session.doc.paragraph("d2").runs[0].text)).toBe("Well?");

    // The filter narrows the list by heading, number, character or synopsis; dragging is off while it is on.
    await page.getByLabel("Filter scenes").fill("diner");
    await expect(list).toHaveText([DINER]);
    await page.getByLabel("Filter scenes").fill("nell");
    await expect(list).toHaveText([OFFICE]);
    await page.getByLabel("Filter scenes").fill("");

    // Drag the last scene above the first.
    await page.locator(`.navigator-row[data-scene-id="s5"]`).dragTo(page.locator(`.navigator-row[data-scene-id="s1"]`), { targetPosition: { x: 40, y: 3 } });
    await expect.poll(() => headings(page)).toEqual([ROAD, OPEN, YARD, DINER, OFFICE]);
    await expect(list).toHaveText([ROAD, OPEN, YARD, DINER, OFFICE]);

    // Undo takes the drag back in one step.
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    await expect.poll(() => headings(page)).toEqual([OPEN, YARD, DINER, OFFICE, ROAD]);

    // The Go to Scene dialog lists scenes and filters them.
    await runCommand(page, "structure.goToScene");
    await expect(page.getByRole("dialog", { name: "Go to Scene" })).toBeVisible();
    await page.getByLabel("Scene", { exact: true }).fill("yard");
    await expect(page.locator(".navigator-goto li")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Go to Scene" })).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

test("the index cards edit synopses and colors, resize, and reorder by drag", async () => {
  await withApp(async (page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("cards"));

    const cards = page.locator(".cards-card");
    await expect(cards).toHaveCount(5);
    await expect(page.locator(".cards-divider input")).toHaveCount(2);
    await expect(page.locator(".cards-divider input").first()).toHaveValue("ACT ONE");

    // Edit a synopsis on the card: it becomes the synopsis paragraph right after the heading.
    const synopsis = page.locator(`.cards-card[data-scene-id="s2"] textarea`);
    await synopsis.fill("Nell waits for the call.");
    await synopsis.blur();
    await expect.poll(() => rows(page)).toContain("synopsis:Nell waits for the call.");
    const after = await rows(page);
    expect(after[after.indexOf(`sceneHeading:${OFFICE}`) + 1]).toBe("synopsis:Nell waits for the call.");
    // The card reads it back from the document, and a second edit changes the same paragraph.
    await expect(synopsis).toHaveValue("Nell waits for the call.");
    await synopsis.fill("Nell waits.");
    await synopsis.blur();
    await expect.poll(() => rows(page)).toContain("synopsis:Nell waits.");
    expect((await rows(page)).filter((r) => r.startsWith("synopsis:"))).toHaveLength(1);
    // Clearing it removes the paragraph.
    await synopsis.fill("");
    await synopsis.blur();
    await expect.poll(async () => (await rows(page)).filter((r) => r.startsWith("synopsis:")).length).toBe(0);

    // Pick a color. It is stored the way Final Draft keeps it, in the heading's SceneProperties.
    await page.getByLabel("Color of scene 3").click();
    await page.getByRole("menuitem", { name: "Blue" }).click();
    await expect.poll(() => page.evaluate(() => {
      const heading = (window as any).__app.session.doc.paragraph("s3");
      return heading.fdx?.before?.[0]?.attrs?.find(([name]: string[]) => name === "Color")?.[1];
    })).toBe("#3E3E6363DDDD");
    await expect(page.locator(`.cards-card[data-scene-id="s3"] .cards-stripe`)).toHaveCSS("background-color", "rgb(62, 99, 221)");

    // Card size.
    await page.getByRole("button", { name: "Large" }).click();
    await expect(page.locator(".cards")).toHaveAttribute("data-size", "large");
    await page.getByRole("button", { name: "Small" }).click();
    await expect(page.locator(".cards")).toHaveAttribute("data-size", "small");

    // Drag the Diner card to the left half of the Yard card: it lands before it, inside Act One.
    const box = (await page.locator(`.cards-card[data-scene-id="s3"]`).boundingBox())!;
    await page.locator(`.cards-card[data-scene-id="s4"]`).dragTo(page.locator(`.cards-card[data-scene-id="s3"]`), { targetPosition: { x: 8, y: box.height / 2 } });
    await expect.poll(() => headings(page)).toEqual([OPEN, OFFICE, DINER, YARD, ROAD]);
    const order = await rows(page);
    expect(order.indexOf(`sceneHeading:${DINER}`)).toBeLessThan(order.indexOf("section:ACT TWO"));

    // A peer drags the whole of Act Two above Act One; the cards follow.
    await peerEdit(page, (doc) => moveSection(doc, "act2", "act1"));
    await expect(page.locator(".cards-divider input").first()).toHaveValue("ACT TWO");

    // A section title edits in place.
    const title = page.locator(".cards-divider input").first();
    await title.fill("ACT TWO: THE BARGAIN");
    await title.blur();
    await expect.poll(() => rows(page)).toContain("section:ACT TWO: THE BARGAIN");

    // Double-click on a card asks the editor to reveal the scene. Here there is no editor, so it only must not fail.
    await page.locator(`.cards-card[data-scene-id="s1"] h3`).dblclick();
    expect(errors).toEqual([]);
  });
});

test("the outline edits section titles and synopses, adds sections, collapses and reorders", async () => {
  await withApp(async (page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("outline"));

    const sceneRows = page.locator(".outline-scene .outline-heading");
    await expect(sceneRows).toHaveText([OPEN, OFFICE, YARD, DINER, ROAD]);
    await expect(page.locator(".outline-section")).toHaveCount(2);

    const title = page.locator(`.outline-section[data-section-id="act1"] input`);
    await title.fill("ACT I");
    await title.press("Enter");
    await expect.poll(() => rows(page)).toContain("section:ACT I");

    // Scene synopses inline.
    const synopsis = page.locator(`.outline-scene[data-scene-id="s4"] textarea`);
    await synopsis.fill("Nell makes her offer.");
    await synopsis.blur();
    await expect.poll(() => rows(page)).toContain("synopsis:Nell makes her offer.");

    // Collapse Act II: its scenes leave the tree.
    await page.locator(`.outline-section[data-section-id="act2"]`).getByLabel("Collapse section").click();
    await expect(sceneRows).toHaveText([OPEN, OFFICE, YARD]);
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(sceneRows).toHaveText([OPEN, OFFICE, YARD, DINER, ROAD]);

    // Add a section at the end, then a subsection inside Act II.
    await page.getByRole("button", { name: "Add section" }).click();
    const added = page.locator(".outline-section input").last();
    await expect(added).toBeFocused();
    await added.fill("ACT THREE");
    await added.press("Enter");
    await expect.poll(async () => (await rows(page)).at(-1)).toBe("section:ACT THREE");
    await page.locator(`.outline-section[data-section-id="act2"]`).hover();
    await page.locator(`.outline-section[data-section-id="act2"]`).getByLabel("Add subsection").click();
    const sub = page.locator(".outline-section input").nth(2);
    await expect(sub).toBeFocused();
    await sub.fill("THE ROAD");
    await sub.press("Enter");
    await expect.poll(async () => (await rows(page)).includes("section:THE ROAD")).toBe(true);
    const all = await rows(page);
    expect(all.indexOf("section:ACT TWO")).toBeLessThan(all.indexOf("section:THE ROAD"));
    expect(all.indexOf("section:THE ROAD")).toBeLessThan(all.indexOf("section:ACT THREE"));
    expect(await page.evaluate(() => (window as any).__app.session.doc.paragraph("act2").depth)).toBe(1);

    // Drag the Road scene up above the Office scene.
    await page.locator(`.outline-scene[data-scene-id="s5"]`).dragTo(page.locator(`.outline-scene[data-scene-id="s2"]`), { targetPosition: { x: 60, y: 3 } });
    await expect.poll(() => headings(page)).toEqual([OPEN, ROAD, OFFICE, YARD, DINER]);

    // Removing a section keeps its scenes.
    await page.locator(`.outline-section[data-section-id="act2"]`).hover();
    await page.locator(`.outline-section[data-section-id="act2"]`).getByLabel("Remove section").click();
    await expect.poll(async () => (await rows(page)).includes("section:ACT TWO")).toBe(false);
    expect(await headings(page)).toEqual([OPEN, ROAD, OFFICE, YARD, DINER]);

    expect(errors).toEqual([]);
  });
});

test("the views stay responsive on a 3,000-paragraph script", async () => {
  await withApp(async (page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const specs: Spec[] = [];
    for (let scene = 1; scene <= 300; scene++) {
      if (scene % 50 === 1) specs.push({ id: `act${scene}`, type: "section", text: `ACT ${Math.ceil(scene / 50)}`, depth: 1 });
      specs.push({ id: `sc${scene}`, type: "sceneHeading", text: `INT. LOCATION ${scene} - DAY` });
      specs.push({ id: `sy${scene}`, type: "synopsis", text: `Synopsis of scene ${scene}.` });
      for (let k = 0; k < 3; k++) {
        specs.push({ id: `a${scene}-${k}`, type: "action", text: `Action line ${k} in scene ${scene} with several words so that it wraps onto a second line.` });
        specs.push({ id: `c${scene}-${k}`, type: "character", text: `CHAR${k}` });
        specs.push({ id: `d${scene}-${k}`, type: "dialogue", text: `Line ${k} of dialogue.` });
      }
    }
    expect(specs.length).toBeGreaterThanOrEqual(3000);
    await loadScript(page, specs);

    const timed = async (label: string, action: () => Promise<unknown>, ready: () => Promise<unknown>) => {
      const start = Date.now();
      await action();
      await ready();
      const ms = Date.now() - start;
      console.log(`  ${label}: ${ms} ms`);
      return ms;
    };

    const navigator = await timed("navigator, 300 scenes", async () => undefined, () => expect(page.locator(".navigator-row")).toHaveCount(300));
    const cards = await timed("cards, 300 cards", () => page.evaluate(() => (window as any).__app.setView("cards")), () => expect(page.locator(".cards-card")).toHaveCount(300));
    const outline = await timed("outline, 300 scenes", () => page.evaluate(() => (window as any).__app.setView("outline")), () => expect(page.locator(".outline-scene")).toHaveCount(300));
    const storyMap = await timed("story map, 300 scenes", () => page.evaluate(() => (window as any).__app.setView("storyMap")), () => expect(page.locator(".story-map-block")).toHaveCount(300));

    // A move through the UI path on a big script, then the views catch up.
    await page.evaluate(() => (window as any).__app.setView("cards"));
    await expect(page.locator(".cards-card")).toHaveCount(300);
    await page.locator(`.cards-card[data-scene-id="sc300"]`).scrollIntoViewIfNeeded();
    const move = await timed("drag a card up four places", () =>
      page.locator(`.cards-card[data-scene-id="sc300"]`).dragTo(page.locator(`.cards-card[data-scene-id="sc296"]`), { targetPosition: { x: 8, y: 20 } }),
    () => expect.poll(() => headings(page).then((h) => h.indexOf("INT. LOCATION 300 - DAY"))).toBe(295));

    // Editing one synopsis on a big script reaches the document quickly.
    const edit = await timed("synopsis edit committed", async () => {
      const field = page.locator(`.cards-card[data-scene-id="sc7"] textarea`);
      await field.fill("A new synopsis.");
      await field.blur();
    }, () => expect.poll(() => rows(page).then((r) => r.includes("synopsis:A new synopsis."))).toBe(true));

    expect(Math.max(navigator, cards, outline, storyMap, move, edit)).toBeLessThan(5000);
    expect(errors).toEqual([]);
  });
});

test("cards show the characters and length of each scene", async () => {
  await withApp(async (page) => {
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("cards"));
    const office = page.locator(`.cards-card[data-scene-id="s2"]`);
    await expect(office.locator(".cards-characters")).toHaveText("NELL");
    await expect(office.locator(".structure-length")).toContainText(/\d/);
  });
});

test("opening another document with a draft pending does not blank the window", async () => {
  await withApp(async (page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("cards"));
    // A synopsis being typed, then the window swaps in another document before the draft is written.
    await page.locator(`.cards-card[data-scene-id="s2"] textarea`).fill("typed just before the swap");
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.setSession(app.session.constructor.untitled());
    });
    await page.waitForTimeout(900);
    expect(errors).toEqual([]);
    await expect(page.locator(".shell")).toHaveCount(1);
    await expect(page.locator(".cards-card")).toHaveCount(1);
    expect((await rows(page)).filter((r) => r.startsWith("synopsis:"))).toEqual([]);
  });
});

test("a field that commits after its scene is gone reports it instead of throwing", async () => {
  await withApp(async (page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("cards"));
    const field = page.locator(`.cards-card[data-scene-id="s4"] textarea`);
    await field.fill("typing");
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.session.edit(() => app.session.doc.deleteParagraph("s4"));
    });
    await field.blur().catch(() => undefined);
    await expect(page.getByText("no longer in the script")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("dragging inside a focused title field selects text; an unfocused one still drags its row", async () => {
  await withApp(async (page) => {
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("outline"));
    const before = await rows(page);
    const input = page.locator(`.outline-section[data-section-id="act1"] input`);
    const box = (await input.boundingBox())!;
    await input.click();
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2 + 1, { steps: 10 });
    await page.mouse.up();
    const selection = await page.evaluate(() => {
      const field = document.activeElement as HTMLInputElement;
      return [field.tagName, field.selectionEnd! - field.selectionStart!];
    });
    expect(selection[0]).toBe("INPUT");
    expect(selection[1]).toBeGreaterThan(0);
    expect(await rows(page)).toEqual(before);
    // The row is draggable again afterwards.
    await expect(page.locator(`.outline-section[data-section-id="act1"]`)).toHaveAttribute("draggable", "true");
  });
});

test("scenes reveal in the editor through the script view, with the editor already registered or mounting late", async () => {
  await withApp(async (page) => {
    await loadScript(page, smallScript());
    const caret = () => page.evaluate(() => {
      const app = (window as any).__app;
      return [app.ui.view, app.editor?.getSelection()?.head.paragraphId ?? null];
    });
    // The real editor is mounted in the script view. The caret scene is highlighted in the navigator and follows the selection.
    await expect.poll(() => page.evaluate(() => !!(window as any).__app.editor)).toBe(true);
    await page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "c2", offset: 0 }));
    await expect(page.locator(".navigator-row.on")).toHaveAttribute("data-scene-id", "s2");
    await page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a3", offset: 2 }));
    await expect(page.locator(".navigator-row.on")).toHaveAttribute("data-scene-id", "s3");

    // From the cards view: the view switches back to the script and the caret lands on the heading.
    await page.evaluate(() => (window as any).__app.setView("cards"));
    await page.locator(`.cards-card[data-scene-id="s1"] h3`).dblclick();
    await expect.poll(caret).toEqual(["script", "s1"]);
    await expect(page.locator(".navigator-row.on")).toHaveAttribute("data-scene-id", "s1");

    // From the outline: the script view mounts a new editor after the switch, and the reveal waits for it.
    await page.evaluate(() => (window as any).__app.setView("outline"));
    await expect.poll(() => page.evaluate(() => (window as any).__app.editor)).toBe(null);
    await page.locator(`.outline-scene[data-scene-id="s4"] .outline-heading`).click();
    await expect.poll(caret).toEqual(["script", "s4"]);
    await expect(page.locator('.editor-p[data-id="s4"]')).toBeInViewport();
  });
});

test("a Final Draft file warns that synopses and sections are not saved in it", async () => {
  await withApp(async (page) => {
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("cards"));
    await expect(page.locator(".structure-notice")).toHaveCount(0);
    await page.evaluate(() => { (window as any).__app.session.format = "fdx"; (window as any).__app.emit(); (window as any).__app.session.markDirty(); });
    await expect(page.locator(".structure-notice")).toContainText("Final Draft files keep a scene's synopsis (as its index card summary) but not sections");
    await page.evaluate(() => (window as any).__app.setView("outline"));
    await expect(page.locator(".structure-notice")).toHaveCount(1);
  });
});

/** Answer the save dialog with this path. */
async function saveTo(electronApp: ElectronApplication, path: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog;
  }, path);
}

/** The paragraphs of a saved .screenplay file, as "type:text" rows. */
function savedRows(path: string): string[] {
  if (!existsSync(path)) return [];
  return decodeNative(new Uint8Array(readFileSync(path))).doc.toScript().paragraphs.map((p) => `${p.type}:${p.runs.map((r) => r.text).join("")}`);
}

test("Save, Export and closing write a section title or synopsis that is still being typed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-structure-"));
  const { electronApp, page } = await launch();
  try {
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("outline"));
    const native = join(dir, "Draft.screenplay");
    await saveTo(electronApp, native);
    await runCommand(page, "file.saveAs");
    await expect.poll(() => savedRows(native)).toContain("section:ACT ONE");

    // A section title typed with the field still focused: Save writes it and leaves the window clean.
    const title = page.locator(`.outline-section[data-section-id="act1"] input`);
    await title.fill("ACT I");
    await expect(title).toBeFocused();
    await runCommand(page, "file.save");
    await expect.poll(() => savedRows(native)).toContain("section:ACT I");
    expect(await page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);

    // A synopsis inside its pause: Export writes it.
    const fountain = join(dir, "Draft.fountain");
    await saveTo(electronApp, fountain);
    await page.locator(`.outline-scene[data-scene-id="s4"] textarea`).fill("Nell makes her offer.");
    await runCommand(page, "file.exportFountain");
    await expect.poll(() => existsSync(fountain) && readFileSync(fountain, "utf8")).toContain("= Nell makes her offer.");

    // Closing with a title being typed asks to save instead of dropping it. Cancel keeps the window.
    await runCommand(page, "file.save");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    await title.fill("THE FIRST ACT");
    await electronApp.evaluate(() => {
      (globalThis as any).asked = 0;
      (globalThis as any).e2eMessageBox = () => ((globalThis as any).asked++, 2);
    });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => electronApp.evaluate(() => (globalThis as any).asked)).toBe(1);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await rows(page)).toContain("section:THE FIRST ACT");
  } finally {
    await close(electronApp, page);
  }
});

test("cards and outline fields keep writing to the script after Revert to Saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "screenplay-structure-"));
  const { electronApp, page } = await launch();
  try {
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.setView("cards"));
    await saveTo(electronApp, join(dir, "Draft.screenplay"));
    await runCommand(page, "file.saveAs");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    // Change something, then revert: the reopened document has the same scene IDs, so the cards stay mounted.
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.session.edit(() => app.session.doc.insertText("a1", 0, "Cold. "));
    });
    const before = await page.evaluate(() => (window as any).__app.session.id);
    await electronApp.evaluate(() => {
      (globalThis as any).e2eMessageBox = () => 0;
    });
    await runCommand(page, "file.revert");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.id)).not.toBe(before);
    expect(await rows(page)).toContain("action:Wind.");

    const synopsis = page.locator(`.cards-card[data-scene-id="s2"] textarea`);
    await synopsis.fill("After the revert.");
    await synopsis.blur();
    await expect.poll(() => rows(page)).toContain("synopsis:After the revert.");
    const title = page.locator(".cards-divider input").first();
    await title.fill("ACT I");
    await title.press("Enter");
    await expect.poll(() => rows(page)).toContain("section:ACT I");
  } finally {
    await close(electronApp, page);
  }
});

test("a read-only script shows the cards, outline and title page disabled", async () => {
  await withApp(async (page) => {
    await loadScript(page, smallScript());
    await page.evaluate(() => (window as any).__app.session.setReadOnly(true));

    await page.evaluate(() => (window as any).__app.setView("cards"));
    await expect(page.locator(".structure-readonly")).toBeVisible();
    const card = page.locator(`.cards-card[data-scene-id="s2"]`);
    await expect(card.locator("textarea")).toBeDisabled();
    await expect(card.locator(".structure-swatch")).toBeDisabled();
    await expect(card).not.toHaveAttribute("draggable", "true");
    await expect(page.locator(".cards-divider input").first()).toBeDisabled();
    await expect(page.locator(`.navigator-row[data-scene-id="s2"]`)).not.toHaveAttribute("draggable", "true");

    await page.evaluate(() => (window as any).__app.setView("outline"));
    await expect(page.locator(`.outline-section[data-section-id="act1"] input`)).toBeDisabled();
    await expect(page.locator(`.outline-scene[data-scene-id="s4"] textarea`)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add section" })).toBeDisabled();
    await expect(page.locator(`.outline-section[data-section-id="act1"]`).getByLabel("Remove section")).toBeDisabled();

    await runCommand(page, "title-page.edit");
    await expect(page.locator('.title-page-form input[name="Title"]')).toBeDisabled();
    await expect(page.locator(".title-page-form button[type=submit]")).toBeDisabled();
    await expect(page.locator(".title-page-note")).toHaveText("This script is read-only, so the title page can't be changed.");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => (window as any).__app.commands.find((c: any) => c.id === "structure.numberScenes").enabled((window as any).__app))).toBe(false);

    // Leaving read-only turns them back on.
    await page.evaluate(() => (window as any).__app.session.setReadOnly(false));
    await expect(page.locator(`.outline-scene[data-scene-id="s4"] textarea`)).toBeEnabled();
    await expect(page.locator(".structure-readonly")).toHaveCount(0);
  });
});

test("concurrent scene typing has a session notice and keeps the typist's Undo", async () => {
  await withApp(async page => {
    await loadScript(page, smallScript());
    const state = await page.evaluate(() => Array.from((window as any).__app.session.doc.encodeState()) as number[]);
    const peer = ScreenplayDoc.fromUpdate(new Uint8Array(state));
    try {
      moveScene(peer, "s2", null);
      await page.evaluate(() => {
        const session = (window as any).__app.session;
        session.edit(() => session.doc.insertText("d2", 0, "LEFT BEHIND "));
      });
      await page.evaluate(update => (window as any).__app.session.doc.applyUpdate(new Uint8Array(update), "remote"), Array.from(peer.encodeState()));
      const notice = page.getByRole("button", { name: "Your typing was left behind by a co-writer's move · Review" });
      await expect(notice).toBeVisible();
      await notice.click();
      await expect(page.getByRole("textbox", { name: `Text left behind from ${OFFICE}` })).toHaveValue("LEFT BEHIND ");
      await page.getByRole("button", { name: "Show the scene" }).click();
      await expect(page.locator('.editor-p[data-id="s2"]')).toBeVisible();
      await expect(notice).toBeVisible();
      await page.evaluate(() => (window as any).__app.session.undo.undo());
      await expect(notice).toHaveCount(0);
      await page.evaluate(() => (window as any).__app.session.undo.redo());
      await expect(notice).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__app.session.doc.body.toString())).toContain("LEFT BEHIND ");
    } finally { peer.ydoc.destroy(); }
  });
});

test("scene move review selects stranded text for manual cutting and dismisses only the notice", async () => {
  await withApp(async page => {
    await loadScript(page, smallScript());
    const state = await page.evaluate(() => Array.from((window as any).__app.session.doc.encodeState()) as number[]);
    const peer = ScreenplayDoc.fromUpdate(new Uint8Array(state));
    try {
      moveScene(peer, "s2", null);
      await page.evaluate(() => {
        const session = (window as any).__app.session;
        session.edit(() => session.doc.insertText("d2", 0, "LEFT BEHIND "));
      });
      await page.evaluate(update => (window as any).__app.session.doc.applyUpdate(new Uint8Array(update), "remote"), Array.from(peer.encodeState()));
      const notice = page.getByRole("button", { name: "Your typing was left behind by a co-writer's move · Review" });
      await notice.click();
      await expect(page.getByRole("button", { name: /^Move it into/ })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: `Text left behind from ${OFFICE}` })).toHaveAttribute("readonly", "");
      const before = await page.evaluate(() => Array.from((window as any).__app.session.doc.encodeState()));
      await page.getByRole("button", { name: "Show where it is now" }).click();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("LEFT BEHIND ");
      expect(await page.evaluate(() => Array.from((window as any).__app.session.doc.encodeState()))).toEqual(before);
      await notice.click();
      await page.getByRole("button", { name: "Leave it here", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "No typing left behind" })).toBeVisible();
      await expect(notice).toHaveCount(0);
      expect(await page.evaluate(() => Array.from((window as any).__app.session.doc.encodeState()))).toEqual(before);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.evaluate(() => (window as any).__app.session.undo.undo());
      await page.evaluate(() => (window as any).__app.session.undo.redo());
      await expect(notice).toHaveCount(0);
    } finally { peer.ydoc.destroy(); }
  });
});
