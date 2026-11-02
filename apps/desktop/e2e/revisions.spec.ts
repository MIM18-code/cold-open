// Production revisions in the built app, window hidden: Revision Mode marks what is typed, revision sets,
// clearing marks, locked pages and A-pages, locked scene numbers, and revised pages in print preview.
import { expect, test, type Page } from "@playwright/test";

import { close, launch, runCommand } from "./helpers.ts";

const sentences = (count: number, word = "Sentence") => Array.from({ length: count }, (_, i) => `${word} ${i} is right here.`).join(" ");

function paragraphs(scenes: number) {
  const out: unknown[] = [];
  for (let scene = 1; scene <= scenes; scene++) {
    out.push({ id: `h${scene}`, type: "sceneHeading", sceneId: `s${scene}`, sceneNumber: String(scene), runs: [{ text: `INT. ROOM ${scene} - DAY` }] });
    out.push({ id: `a${scene}`, type: "action", runs: [{ text: sentences(6) }] });
    out.push({ id: `c${scene}`, type: "character", runs: [{ text: "ANNA" }] });
    out.push({ id: `d${scene}`, type: "dialogue", runs: [{ text: sentences(8) }] });
  }
  return out;
}

async function load(page: Page, scenes: number): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    app.session.doc.load({ titlePage: [], paragraphs: list });
    app.session.undo.clear();
  }, paragraphs(scenes));
}

const revisedRuns = (page: Page, id: string) => page.evaluate((paragraphId) => (window as any).__app.session.doc.paragraph(paragraphId).runs
  .filter((run: any) => run.fdx?.RevisionID && run.fdx.RevisionID !== "0").map((run: any) => [run.text, run.fdx.RevisionID]), id);

async function typeAt(page: Page, paragraphId: string, offset: number, text: string): Promise<void> {
  await page.evaluate(({ paragraphId, offset }) => {
    const editor = (window as any).__app.editor;
    editor.focus();
    editor.setSelection({ paragraphId, offset });
  }, { paragraphId, offset });
  await page.keyboard.type(text);
}

test("Revision Mode marks typed text in the current set, shows it, and undo takes text and mark together", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 4);

  await runCommand(page, "revisions.mode");
  await expect(page.locator(".revisions-status")).toContainText(/^Blue Rev\. \d\d\/\d\d\/\d\d$/);
  await typeAt(page, "a1", 0, "Quietly. ");
  expect(await revisedRuns(page, "a1")).toEqual([["Quietly. ", "1"]]);
  // The editor tints the revised text and draws the paragraph's mark.
  await expect(page.locator('.editor-p[data-id="a1"].rev-para .rev-text.rev-set-1')).toHaveText("Quietly. ");
  const mark = await page.locator('.editor-p[data-id="a1"] .rev-text').evaluate((node) => getComputedStyle(node, "::after").content);
  expect(mark).toBe('"*"');

  // Deleting text leaves a deletion mark on that paragraph.
  await page.evaluate(() => {
    const editor = (window as any).__app.editor;
    editor.setSelection({ paragraphId: "d2", offset: 0 }, { paragraphId: "d2", offset: 9 });
  });
  await page.keyboard.press("Backspace");
  await expect(page.locator('.editor-p[data-id="d2"] .rev-del')).toHaveCount(1);

  // Undo removes the deletion mark with the deletion, then the typing with its mark.
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  await expect(page.locator('.editor-p[data-id="d2"] .rev-del')).toHaveCount(0);
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await revisedRuns(page, "a1")).toEqual([]);
  await expect(page.locator(".rev-text")).toHaveCount(0);

  // Show Revision Marks hides and shows them.
  await typeAt(page, "a3", 0, "Later. ");
  await expect(page.locator(".rev-text")).toHaveCount(1);
  await runCommand(page, "revisions.showMarks");
  await expect(page.locator(".rev-text")).toHaveCount(0);
  await runCommand(page, "revisions.showMarks");
  await expect(page.locator(".rev-text")).toHaveCount(1);

  // Revision Mode off: typing is not marked.
  await runCommand(page, "revisions.mode");
  await expect(page.locator(".revisions-status")).toHaveCount(0);
  await typeAt(page, "a4", 0, "Plain. ");
  expect(await revisedRuns(page, "a4")).toEqual([]);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("revision sets: a new set, switching sets, clearing one set's marks, and the FDX it writes", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 4);

  // New Revision Set… with no sets: Blue is suggested; create it, then Pink.
  await runCommand(page, "revisions.newSet");
  await expect(page.locator('.revisions-new input[name="name"]')).toHaveValue("Blue Rev.");
  await page.locator('.revisions-new input[name="date"]').fill("10/30/26");
  await page.getByRole("button", { name: "Create revision set" }).click();
  await expect(page.locator(".revisions-row")).toHaveCount(1);
  await page.getByRole("button", { name: "New revision set…" }).click();
  await expect(page.locator('.revisions-new input[name="name"]')).toHaveValue("Pink Rev.");
  await page.locator('.revisions-new input[name="date"]').fill("11/02/26");
  await page.getByRole("button", { name: "Create revision set" }).click();
  await expect(page.locator(".revisions-row")).toHaveCount(2);
  await expect(page.locator(".revisions-row.current")).toContainText("Pink Rev. 11/02/26");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".revisions-status")).toHaveText("Pink Rev. 11/02/26");

  await typeAt(page, "a1", 0, "Pink text. ");
  await runCommand(page, "revisions.current");
  await page.getByRole("radio", { name: "Use Blue Rev." }).check();
  await page.getByRole("button", { name: "Done" }).click();
  await typeAt(page, "a2", 0, "Blue text. ");
  expect(await revisedRuns(page, "a1")).toEqual([["Pink text. ", "2"]]);
  expect(await revisedRuns(page, "a2")).toEqual([["Blue text. ", "1"]]);

  // The script as exported carries Final Draft's Revisions element.
  const revisions = await page.evaluate(() => {
    const fdx = (window as any).__app.session.script().fdx;
    const node = fdx.after.find((n: any) => n.name === "Revisions");
    return [Object.fromEntries(node.attrs).ActiveSet, Object.fromEntries(node.attrs).RevisionMode, node.children.map((c: any) => Object.fromEntries(c.attrs).Name)];
  });
  expect(revisions).toEqual(["1", "Yes", ["Blue Rev. (10/30/26)", "Pink Rev. (11/02/26)"]]);

  // Clear one set's marks, then all.
  await runCommand(page, "revisions.clear");
  await page.locator('.revisions-row[data-set="2"]').getByRole("button", { name: "Clear marks" }).click();
  expect(await revisedRuns(page, "a1")).toEqual([]);
  expect(await revisedRuns(page, "a2")).toEqual([["Blue text. ", "1"]]);
  await page.getByRole("button", { name: "Clear all marks" }).click();
  expect(await revisedRuns(page, "a2")).toEqual([]);
  await page.getByRole("button", { name: "Done" }).click();

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("locked pages: added text makes A-pages in the editor and print preview; revised pages print with their header and marks", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 12);
  const numbers = () => page.locator(".editor-pagebreak-number").allTextContents();
  await expect.poll(async () => (await numbers()).length).toBeGreaterThan(2);
  const before = await numbers();

  await runCommand(page, "revisions.lockPages");
  await expect(page.locator(".revisions-status")).toHaveText("Pages locked");
  await runCommand(page, "revisions.mode");
  // A long passage on page 2 makes page 2A; page 3 stays page 3.
  await page.evaluate((text) => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.insertText("a5", 0, text));
  }, `${sentences(40, "Added")} `);
  await expect.poll(numbers).toContain("2A.");
  const after = await numbers();
  expect(after.filter((n) => !/A\.$/.test(n))).toEqual(before);

  // Print preview: the revised pages carry the set's name and date in the header and marks in the margin.
  await runCommand(page, "print.print");
  const page2a = page.locator('.print-page[data-page="2A"]');
  await expect(page2a.locator("text", { hasText: /^Blue Rev\. \d\d\/\d\d\/\d\d$/ })).toHaveCount(1);
  expect(await page.locator('.print-page[data-page="2"] text', { hasText: /^\*$/ }).count()).toBeGreaterThan(10);
  // Revised pages only.
  const all = await page.locator(".print-page").count();
  await page.locator(".print-toolbar .print-check input").check();
  await expect(page.locator(".print-count")).toHaveText(/^\d+ revised pages?$/);
  const revised = await page.locator(".print-page").count();
  expect(revised).toBeLessThan(all);
  expect(revised).toBeGreaterThan(0);
  await page.locator(".print-toolbar .print-check input").uncheck();
  await page.keyboard.press("Escape");

  // Unlocking renumbers the pages 1 to N.
  await runCommand(page, "revisions.unlockPages");
  await expect.poll(numbers).not.toContain("2A.");

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("a page locked inside a paragraph keeps its first sentence when text is added above it", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await page.evaluate((text) => {
    const app = (window as any).__app;
    app.session.doc.load({ titlePage: [], paragraphs: [
      { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
      { id: "a", type: "action", runs: [{ text }] },
    ] });
    app.session.undo.clear();
  }, Array.from({ length: 300 }, (_, i) => `Sentence ${i + 1} is right here.`).join(" "));
  const numbers = () => page.locator(".editor-pagebreak-number").allTextContents();
  await expect.poll(numbers).toEqual(["2.", "3."]);
  /** The first script line printed on a page of the print preview. */
  const firstLine = async (number: string) => {
    await runCommand(page, "print.print");
    const line = await page.locator(`.print-page[data-page="${number}"] text`, { hasText: /^Sentence \d+ / }).first().textContent();
    await page.keyboard.press("Escape");
    return line?.split(" ").slice(0, 2).join(" ");
  };
  const page2 = await firstLine("2");
  expect(page2).toMatch(/^Sentence \d+$/);

  await runCommand(page, "revisions.lockPages");
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.insertText("a", 0, "Inserted sentence. ".repeat(20)));
  });
  // The added text runs onto 1A; page 2 still starts with the sentence it started with.
  await expect.poll(numbers).toEqual(["1A.", "2.", "3."]);
  expect(await firstLine("2")).toBe(page2);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("Omit Scene leaves the act title in place, and Restore Omitted Scene brings the scene back whole", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  const original = [
    { id: "h1", type: "sceneHeading", sceneId: "s1", sceneNumber: "1", runs: [{ text: "INT. KITCHEN - DAY" }] },
    { id: "y1", type: "synopsis", runs: [{ text: "card text" }] },
    { id: "a1", type: "action", runs: [{ text: "Nell pours " }, { text: "check this", note: true }, { text: " coffee." }] },
    { id: "act", type: "section", depth: 1, runs: [{ text: "ACT TWO" }] },
    { id: "h2", type: "sceneHeading", sceneId: "s2", sceneNumber: "2", runs: [{ text: "EXT. YARD - DAY" }] },
    { id: "a2", type: "action", runs: [{ text: "The dog barks." }] },
  ];
  await page.evaluate((list) => {
    const app = (window as any).__app;
    app.session.doc.load({ titlePage: [], paragraphs: list });
    app.session.undo.clear();
  }, original);
  const outline = () => page.evaluate(() => (window as any).__app.session.doc.paragraphs()
    .map((p: any) => `${p.type} ${p.runs.map((r: any) => r.text).join("")}`));
  const before = await outline();

  await typeAt(page, "a1", 2, "");
  await runCommand(page, "revisions.omitScene");
  expect(await outline()).toEqual(["sceneHeading OMITTED", "section ACT TWO", "sceneHeading EXT. YARD - DAY", "action The dog barks."]);
  await expect(page.locator(".toast", { hasText: "Scene 1 is omitted." })).toHaveCount(1);

  const omitted = await page.evaluate(() => {
    const app = (window as any).__app;
    // A writer's next command comes later than the undo manager's capture timeout.
    app.session.undo.stopCapturing();
    return app.session.doc.paragraphs()[0].id;
  });
  await typeAt(page, omitted, 0, "");
  await runCommand(page, "revisions.restoreScene");
  expect(await outline()).toEqual(before);
  expect(await page.evaluate(() => (window as any).__app.session.doc.paragraphs().slice(0, 3).map((p: any) => p.id))).toEqual(["h1", "y1", "a1"]);

  // Undo takes the restore back, then the omission.
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect((await outline())[0]).toBe("sceneHeading OMITTED");
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await outline()).toEqual(before);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("locked scene numbers: a deleted scene leaves OMITTED, a new scene gets an A-number", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 4);
  const headings = () => page.evaluate(() => (window as any).__app.session.script().paragraphs
    .filter((p: any) => p.type === "sceneHeading").map((p: any) => `${p.sceneNumber} ${p.runs.map((r: any) => r.text).join("")}`));

  await runCommand(page, "revisions.lockScenes");
  await page.evaluate(() => {
    const app = (window as any).__app;
    const doc = app.session.doc;
    // Cutting scene 2 from the navigator or index cards removes its paragraphs whole.
    app.session.edit(() => ["h2", "a2", "c2", "d2"].forEach((id) => doc.deleteParagraph(id)));
  });
  expect(await headings()).toEqual(["1 INT. ROOM 1 - DAY", "2 OMITTED", "3 INT. ROOM 3 - DAY", "4 INT. ROOM 4 - DAY"]);
  await expect(page.locator(".editor-p.editor-t-sceneHeading", { hasText: "OMITTED" })).toHaveAttribute("data-scene-number", "2");

  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.insertParagraph(app.session.doc.indexOf("h4"), { type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] }));
  });
  expect(await headings()).toEqual(["1 INT. ROOM 1 - DAY", "2 OMITTED", "3 INT. ROOM 3 - DAY", "3A INT. HALL - DAY", "4 INT. ROOM 4 - DAY"]);

  // Remove Scene Numbers refuses while locked; unlocking lets Number Scenes renumber.
  await runCommand(page, "structure.removeSceneNumbers");
  await expect(page.locator(".toast", { hasText: "Scene numbers are locked. Unlock them first." })).toHaveCount(1);
  await runCommand(page, "revisions.lockScenes");
  await runCommand(page, "structure.numberScenes");
  expect((await headings()).map((h: string) => h.split(" ")[0])).toEqual(["1", "2", "3", "4", "5"]);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("locked scene numbers in the editor: a line passing through Scene Heading takes no number, and a heading retyped and back keeps its own", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 3);
  const headings = () => page.evaluate(() => (window as any).__app.session.doc.paragraphs()
    .filter((p: any) => p.type === "sceneHeading").map((p: any) => `${p.sceneNumber ?? "-"} ${p.runs.map((r: any) => r.text).join("")}`));
  await runCommand(page, "revisions.lockScenes");

  // Return at the end of an action line, make the new line a heading, change your mind.
  await typeAt(page, "d1", (await page.evaluate(() => (window as any).__app.session.doc.paragraph("d1").runs[0].text.length)), "");
  await page.keyboard.press("Enter");
  await page.evaluate(() => (window as any).__app.editor.setElementType("sceneHeading"));
  await expect.poll(headings).toEqual(["1 INT. ROOM 1 - DAY", "- ", "2 INT. ROOM 2 - DAY", "3 INT. ROOM 3 - DAY"]);
  await page.keyboard.press("Backspace");
  await expect.poll(headings).toEqual(["1 INT. ROOM 1 - DAY", "2 INT. ROOM 2 - DAY", "3 INT. ROOM 3 - DAY"]);

  // A heading made action leaves OMITTED; made a heading again, the placeholder goes.
  await typeAt(page, "h2", 3, "");
  await page.evaluate(() => (window as any).__app.editor.setElementType("action"));
  await expect.poll(headings).toEqual(["1 INT. ROOM 1 - DAY", "2 OMITTED", "3 INT. ROOM 3 - DAY"]);
  await page.evaluate(() => (window as any).__app.editor.setElementType("sceneHeading"));
  await expect.poll(headings).toEqual(["1 INT. ROOM 1 - DAY", "2 INT. ROOM 2 - DAY", "3 INT. ROOM 3 - DAY"]);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("Revision Mode follows the open document: a document opened in its place is tracked, and its own state shows", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 2);
  await runCommand(page, "revisions.mode");
  await expect(page.locator(".revisions-status")).toHaveCount(1);

  // Open another script into the window: it has no revision state of its own, so nothing is tracked.
  await page.evaluate((list) => {
    const app = (window as any).__app;
    const next = app.session.constructor.untitled();
    next.doc.load({ titlePage: [], paragraphs: list });
    next.undo.clear();
    app.setSession(next);
  }, paragraphs(2));
  await expect(page.locator(".revisions-status")).toHaveCount(0);
  await typeAt(page, "a1", 0, "Plain. ");
  expect(await revisedRuns(page, "a1")).toEqual([]);
  // Revision Mode on in the new document marks its typing.
  await runCommand(page, "revisions.mode");
  await typeAt(page, "a2", 0, "Marked. ");
  expect(await revisedRuns(page, "a2")).toEqual([["Marked. ", "1"]]);
  await expect(page.locator('.editor-p[data-id="a2"] .rev-text')).toHaveText("Marked. ");

  expect(errors).toEqual([]);
  await close(electronApp, page);
});

test("a number a merge duplicated is renumbered, and the writer can open the notice", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await load(page, 3);
  const numbers = () => page.evaluate(() => (window as any).__app.session.doc.paragraphs()
    .filter((p: any) => p.type === "sceneHeading").map((p: any) => p.sceneNumber));
  await runCommand(page, "revisions.lockScenes");

  await page.evaluate(() => {
    const app = (window as any).__app;
    const doc = app.session.doc;
    // This window adds a scene between 2 and 3 while numbers are locked: 2A.
    app.session.edit(() => doc.insertParagraph(doc.indexOf("h3"), { type: "sceneHeading", sceneNumber: "2A", runs: [{ text: "INT. HALL - DAY" }] }));
    // A co-writer's scene, arriving later in a remote update, took 2A in the same gap.
    doc.ydoc.transact(() => doc.insertParagraph(doc.indexOf("h3"), { type: "sceneHeading", sceneNumber: "2A", runs: [{ text: "INT. GARAGE - DAY" }] }), "net");
  });

  await expect.poll(numbers).toEqual(["1", "2", "2A", "2B", "3"]);
  await expect(page.locator(".recovery-health", { hasText: "Scene numbers adjusted" })).toHaveCount(1);
  await page.locator(".recovery-health", { hasText: "Scene numbers adjusted" }).click();
  await expect(page.locator(".roadmap-dialog")).toContainText("2A → 2B");
  await page.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(page.locator(".recovery-health", { hasText: "Scene numbers adjusted" })).toHaveCount(0);
  expect(await numbers()).toEqual(["1", "2", "2A", "2B", "3"]);

  expect(errors).toEqual([]);
  await close(electronApp, page);
});
