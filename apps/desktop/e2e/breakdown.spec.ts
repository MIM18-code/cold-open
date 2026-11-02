import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
import { parseFdx, tagDefinitions, writeFdx, type Script } from "@screenplay/engine";
import { launch, close, runCommand } from "./helpers.ts";

interface Row { id: string; type: string; text: string }

async function loadScript(page: Page, rows: Row[]): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: list.map((r) => ({ id: r.id, type: r.type, runs: r.text ? [{ text: r.text }] : [] })) }));
  }, rows);
  // The caret must wait until the editor receives the loaded paragraphs.
  const first = rows[0]?.id;
  if (first && (await page.evaluate(() => !!(window as any).__app.editor))) {
    await expect.poll(() => page.evaluate((id) => {
      const editor = (window as any).__app.editor;
      editor.setSelection({ paragraphId: id, offset: 0 });
      return editor.currentParagraphId();
    }, first)).toBe(first);
  }
}

interface Mock {
  url: string;
  chats: any[];
  /** Set to change what /api/chat sends back. A string is streamed in pieces; a function controls the response itself. */
  reply: string | ((res: http.ServerResponse) => void);
  close(): Promise<void>;
}

async function mockOllama(): Promise<Mock> {
  const mock: Mock = { url: "", chats: [], reply: "OK", close: async () => undefined };
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "gemma4:e4b", size: 9.6e9 }, { name: "qwen3.5:4b", size: 3.3e9 }] }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      mock.chats.push(JSON.parse(body));
      if (typeof mock.reply === "function") return mock.reply(res);
      const text = mock.reply;
      const pieces = text.match(/[\s\S]{1,24}/g) ?? [];
      for (const piece of pieces) res.write(JSON.stringify({ message: { content: piece }, done: false }) + "\n");
      res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mock.close = () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  return mock;
}

async function useMock(page: Page, mock: Mock): Promise<void> {
  await page.evaluate((url) => (window as any).__app.setSetting("ai.ollama.endpoint", url), mock.url);
}

const openPanel = (page: Page, id: string) => page.evaluate((panel) => (window as any).__app.togglePanel(panel, true), id);

test("review scene suggestions, tag checked elements together, undo, and export real FDX definitions", async () => {
  const mock = await mockOllama();
  const { electronApp, page } = await launch();
  try {
    await useMock(page, mock);
    await loadScript(page, [
      { id: "h1", type: "sceneHeading", text: "INT. ROOM - DAY" },
      { id: "a1", type: "action", text: "Maya holds a revolver beside a car." },
      { id: "c1", type: "character", text: "MAYA (V.O.)" },
      { id: "d1", type: "dialogue", text: "Go." },
      { id: "h2", type: "sceneHeading", text: "EXT. ROAD - NIGHT" },
      { id: "a2", type: "action", text: "A dog waits." },
    ]);
    mock.reply = JSON.stringify({ elements: [
      { category: "Props", label: "Revolver", text: "revolver" },
      { category: "Vehicles", label: "Car", text: "car" },
    ] });
    await openPanel(page, "breakdown");
    const panel = page.getByRole("tabpanel", { name: "Breakdown", exact: true });
    await expect(panel.getByLabel("Tag MAYA", { exact: true })).toBeChecked();
    expect(mock.chats).toHaveLength(0);
    await expect(panel.getByRole("button", { name: "Suggest for every scene", exact: true })).toBeDisabled();
    await expect(panel.locator(".assistant-needs")).toHaveText("Needs ChatGPT or an API key");
    await expect(panel).toContainText("Suggestions from the local model");
    await panel.getByRole("button", { name: "Suggest for this scene", exact: true }).click();
    await expect(panel.getByLabel("Tag Revolver", { exact: true })).toBeChecked();
    await expect(panel.getByLabel("Tag Car", { exact: true })).toBeChecked();
    expect(mock.chats).toHaveLength(1);
    expect(JSON.stringify(mock.chats[0].messages)).not.toContain("A dog waits");
    await panel.getByLabel("Tag Car", { exact: true }).uncheck();
    await panel.getByLabel("Element name for revolver", { exact: true }).fill("Service revolver");
    // A small model sometimes picks the wrong category; the writer moves the row instead of dropping it.
    await panel.getByLabel("Category for Service revolver", { exact: true }).selectOption("Miscellaneous");
    await expect(panel.locator("section", { has: page.getByRole("heading", { name: "Miscellaneous" }) })).toContainText("revolver");
    await panel.getByRole("button", { name: "Tag selected (2)", exact: true }).click();
    await expect(panel).toContainText("Tagged 2.");
    await expect(panel).not.toContainText("Skipped");
    const script: Script = await page.evaluate(() => (window as any).__app.session.script());
    const tagged = script.paragraphs.flatMap(p => p.runs.filter(r => r.fdx?.TagNumber));
    expect(tagged.map(r => r.text).sort()).toEqual(["Maya", "revolver"]);
    const xml = writeFdx(script);
    expect(xml).toContain("<TagDefinitions>");
    expect(tagDefinitions(parseFdx(xml)).map(d => `${d.category}: ${d.label}`).sort()).toEqual(["Cast Members: MAYA", "Miscellaneous: Service revolver"]);
    expect(xml).not.toContain('Label="Car"');
    await expect(page.locator(".editor-pm .breakdown-tag")).toHaveCount(2);
    await runCommand(page, "breakdown.showTags");
    await expect(page.locator(".editor-pm .breakdown-tag")).toHaveCount(0);
    await page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await page.evaluate(() => (window as any).__app.session.script().paragraphs.flatMap((p: any) => p.runs.filter((r: any) => r.fdx?.TagNumber)).length)).toBe(0);
    // Undo brings the untagged cast back, and a cue added in this scene joins the cast without leaving it.
    await expect(panel.getByLabel("Tag MAYA", { exact: true })).toBeChecked();
    await page.evaluate(() => {
      const app = (window as any).__app, doc = app.session.doc;
      app.session.edit(() => { doc.insertParagraph(4, { id: "c2", type: "character", runs: [{ text: "ELI" }] }); doc.insertParagraph(5, { id: "d2", type: "dialogue", runs: [{ text: "Wait." }] }); });
    });
    await expect(panel.getByLabel("Tag ELI", { exact: true })).toBeChecked();
    await panel.getByRole("button", { name: "Next scene", exact: true }).click();
    await expect(panel.locator(".breakdown-scene")).toContainText("EXT. ROAD - NIGHT");
    await expect(panel.locator(".breakdown-row")).toHaveCount(0);
  } finally { await close(electronApp, page); await mock.close(); }
});
