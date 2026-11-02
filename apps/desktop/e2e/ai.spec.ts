// Proofreading and the assistant, driven through the app object with the editor absent. A small local HTTP
// server stands in for Ollama, so no model and no network are involved.
import { type ElectronApplication, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launch } from "./helpers.ts";

/** The tests edit the script, and a dirty document makes closing ask about saving in a window nobody sees. */
async function closeApp(app: ElectronApplication, page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__app.session.dirty = false; });
  await app.close();
}

interface Row { id: string; type: string; text: string }

const KITCHEN: Row[] = [
  { id: "h1", type: "sceneHeading", text: "INT. KITCHEN - DAY" },
  { id: "a1", type: "action", text: "MAYA pours coffee." },
  { id: "c1", type: "character", text: "MAYA" }, { id: "d1", type: "dialogue", text: "Morning." },
  { id: "c2", type: "character", text: "MAYA" }, { id: "d2", type: "dialogue", text: "Anyone?" },
  { id: "c3", type: "character", text: "MAYA" }, { id: "d3", type: "dialogue", text: "Fine." },
  { id: "c4", type: "character", text: "MYA" }, { id: "d4", type: "dialogue", text: "Hello." },
  { id: "a2", type: "action", text: "She sits." },
  { id: "d5", type: "dialogue", text: "Where did everyone go?" },
  { id: "h2", type: "sceneHeading", text: "EXT. YARD - NIGHT" },
  { id: "a3", type: "action", text: "Rain falls on the car." },
];

async function loadScript(page: Page, rows: Row[]): Promise<void> {
  await page.evaluate((list) => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: list.map((r) => ({ id: r.id, type: r.type, runs: r.text ? [{ text: r.text }] : [] })) }));
  }, rows);
  // With the editor on this branch the caret decides "this scene"; start in the first paragraph, as without an editor.
  const first = rows[0]?.id;
  if (first && (await page.evaluate(() => !!(window as any).__app.editor))) {
    await expect.poll(() => page.evaluate((id) => {
      const editor = (window as any).__app.editor;
      editor.setSelection({ paragraphId: id, offset: 0 });
      return editor.currentParagraphId();
    }, first)).toBe(first);
  }
}

const textOf = (page: Page, id: string) =>
  page.evaluate((paragraphId) => {
    const p = (window as any).__app.session.script().paragraphs.find((x: any) => x.id === paragraphId);
    return p ? p.runs.map((r: any) => r.text).join("") : null;
  }, id);

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

test("proofreading lists findings, accept fixes them, ignore persists in the document", async () => {
  const { electronApp, page } = await launch();
  await loadScript(page, KITCHEN);
  await openPanel(page, "proofread");

  const items = page.locator(".proofread-item");
  await expect(items).toHaveCount(2);
  await expect(page.locator(".proofread-list h3")).toHaveText([/Character names/, /Script structure/]);
  const cueItem = items.filter({ hasText: "This cue reads MYA" });
  const orphan = items.filter({ hasText: "no character cue" });
  await expect(cueItem).toHaveCount(1);
  await expect(orphan).toHaveCount(1);
  await expect(page.locator(".statusbar")).toContainText("2 to proofread");

  // Accept rewrites the cue without an editor, as one undoable edit.
  await cueItem.getByRole("button", { name: /Accept/ }).click();
  await expect(items).toHaveCount(1);
  expect(await textOf(page, "c4")).toBe("MAYA");
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await textOf(page, "c4")).toBe("MYA");
  await expect(items).toHaveCount(2);
  await page.evaluate(() => (window as any).__app.session.undo.redo());
  await expect(items).toHaveCount(1);

  // Ignore hides the finding, stores its ID in the document and survives edits and a save round trip.
  await orphan.getByRole("button", { name: "Ignore" }).click();
  await expect(items).toHaveCount(0);
  await expect(page.locator(".proofread-summary")).toContainText("1 ignored");
  const ignored = await page.evaluate(() => (window as any).__app.session.doc.meta.get("proofread.ignored"));
  expect(ignored).toHaveLength(1);
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.insertText("a3", 0, "Heavy "));
  });
  await page.waitForTimeout(800);
  await expect(items).toHaveCount(0);
  const reloaded = await page.evaluate(() => {
    const doc = (window as any).__app.session.doc;
    return doc.constructor.fromUpdate(doc.encodeState()).meta.get("proofread.ignored");
  });
  expect(reloaded).toEqual(ignored);
  await page.getByRole("button", { name: /1 ignored/ }).click();
  await expect(items).toHaveCount(1);
  await closeApp(electronApp, page);
});

test("each kind of check can be switched off in Settings", async () => {
  const { electronApp, page } = await launch();
  await loadScript(page, [
    { id: "h", type: "sceneHeading", text: "INT. ROOM - DAY" },
    { id: "a", type: "action", text: "She went to the the door.  Then left." },
  ]);
  await openPanel(page, "proofread");
  await expect(page.locator(".proofread-item")).toHaveCount(2);

  await page.evaluate(() => (window as any).__app.openModal("workspace.settings"));
  await page.locator(".workspace-settings nav .list-row", { hasText: "AI" }).click();
  await expect(page.getByLabel("Provider")).toHaveValue("ollama");
  await page.getByLabel("Repeated words").uncheck();
  await expect(page.locator(".proofread-item")).toHaveCount(1);
  await expect(page.locator(".proofread-item")).toContainText("Two spaces");
  await page.getByLabel("Spacing").uncheck();
  await expect(page.locator(".proofread-item")).toHaveCount(0);
  await page.getByLabel("Spacing").check();
  await expect(page.locator(".proofread-item")).toHaveCount(1);
  await closeApp(electronApp, page);
});

test("spelling uses the macOS checker, skips names, and Learn remembers a word in the document", async () => {
  const { electronApp, page } = await launch();
  const works = await page.evaluate(() => (window as any).desktop.spelling.isMisspelled("recieve"));
  test.skip(!works, "The spell checker has no dictionary in this environment.");
  await loadScript(page, [
    { id: "h", type: "sceneHeading", text: "INT. ROOM - DAY" },
    { id: "a", type: "action", text: "Zorblax will recieve the letter, teh end." },
    { id: "c", type: "character", text: "ZORBLAX" }, { id: "d", type: "dialogue", text: "Thanks." },
  ]);
  await openPanel(page, "proofread");
  const items = page.locator(".proofread-item");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('"recieve" may be misspelled');
  await expect(items.nth(1)).toContainText('"teh" may be misspelled');
  await items.first().getByRole("button", { name: /Accept: receive/ }).click();
  await items.first().getByRole("button", { name: /Accept: the/ }).click();
  expect(await textOf(page, "a")).toBe("Zorblax will receive the letter, the end.");
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.insertText("a", 0, "definately "));
  });
  await expect(items).toHaveCount(1);
  await items.getByRole("button", { name: "Learn" }).click();
  await expect(items).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__app.session.doc.meta.get("proofread.learned"))).toEqual(["definately"]);
  await closeApp(electronApp, page);
});

test("Check with AI keeps only findings whose quote is in the script and never applies them by itself", async () => {
  const mock = await mockOllama();
  const { electronApp, page } = await launch();
  await useMock(page, mock);
  await loadScript(page, KITCHEN);
  await page.evaluate(() => (window as any).__app.session.doc.setField("c4", "type", "character"));
  mock.reply = JSON.stringify({ findings: [
    { paragraph: 2, quote: "pours coffee", kind: "typo", message: "Coffee is spelled pours in the next line.", replacement: "pours the coffee" },
    { paragraph: 2, quote: "she drank tea", kind: "continuity", message: "Invented quote." },
    { paragraph: 12, quote: "Where did everyone go?", kind: "continuity", message: "Nobody else was in the scene." },
  ] });
  await openPanel(page, "proofread");
  await page.locator(".proofread-item").first().waitFor();
  const before = await textOf(page, "a1");

  await page.getByRole("button", { name: "Check with AI" }).click();
  await expect(page.locator(".proofread-ai-status")).toContainText("2 found");
  const chat = mock.chats.at(-1);
  expect(chat.model).toBe("qwen3.5:4b");
  expect(chat.stream).toBe(true);
  expect(chat.think).toBe(false);
  expect(chat.format).toBe("json");
  expect(chat.messages[0].content).toContain("Do not comment on story");
  expect(chat.messages[1].content).toContain("P2 [action] MAYA pours coffee.");
  expect(chat.messages[1].content).not.toContain("Rain falls");

  const aiGroup = page.locator(".proofread-list section", { has: page.getByRole("heading", { name: /AI check/ }) });
  await expect(aiGroup.locator(".proofread-item")).toHaveCount(2);
  expect(await textOf(page, "a1")).toBe(before);
  await aiGroup.locator(".proofread-item", { hasText: "Coffee is spelled" }).getByRole("button", { name: /Accept/ }).click();
  expect(await textOf(page, "a1")).toBe("MAYA pours the coffee.");
  await expect(aiGroup.locator(".proofread-item")).toHaveCount(1);
  await closeApp(electronApp, page);
  await mock.close();
});

test("the assistant answers from the script and Backlot data, streams, applies suggestions and stops on request", async () => {
  const mock = await mockOllama();
  const folder = mkdtempSync(join(tmpdir(), "screenplay-backlot-"));
  const project = join(folder, "project.json");
  writeFileSync(project, JSON.stringify({
    meta: { title: "Test Film" },
    script: {
      characters: [{ id: "c1", name: "MAYA" }], sets: [],
      scenes: [
        { id: "s1", number: "1", heading: "INT. KITCHEN - DAY", characterIds: ["c1"], elements: [] },
        { id: "s2", number: "2", heading: "EXT. YARD - NIGHT", characterIds: ["c1"], elements: [{ id: "e", category: "Stunts", text: "car flip" }] },
      ],
    },
    schedule: { items: [{ kind: "strip", id: "i1", sceneId: "s2" }, { kind: "dayBreak", id: "d1", label: "Yard" }, { kind: "strip", id: "i2", sceneId: "s1" }] },
  }));
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await useMock(page, mock);
  // The project is chosen in the main process's dialog; a page cannot name one through settings.
  const refused = await page.evaluate((path) => (window as any).__app.setSetting("grants.backlotProject", path).then(() => "set", (e: Error) => e.message), project);
  expect(refused).toContain("managed by the app");
  const stored = () => page.evaluate(async () => ((await (window as any).desktop.invoke("settings:get")) as Record<string, unknown>)["grants.backlotProject"]);
  expect(await stored()).toBeUndefined();
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog;
  }, project);
  await page.evaluate(() => (window as any).desktop.invoke("ai:pick-backlot"));
  expect(await stored()).toBe(project);
  // The single request with the trimmed script: what the assistant does with agent mode off, and its fallback.
  await page.evaluate(() => (window as any).__app.setSetting("ai.assistant.wholeScript", false));
  await loadScript(page, KITCHEN);
  await openPanel(page, "assistant");

  // Nothing is sent until the writer asks.
  await page.waitForTimeout(500);
  expect(mock.chats).toHaveLength(0);

  mock.reply = [
    "Scene 2 (EXT. YARD - NIGHT) needs the stunt coordinator: car flip.",
    "```suggestion",
    '{"scene":"2","find":"Rain falls on the car.","replace":"Rain hammers the car.","why":"Matches the stunt."}',
    "```",
  ].join("\n");
  await page.getByLabel("Ask about the script").fill("Which scenes need the stunt coordinator?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".assistant-reply .assistant-text")).toContainText("Scene 2 (EXT. YARD - NIGHT) needs the stunt coordinator");
  const request = mock.chats[0];
  expect(request.messages[0].role).toBe("system");
  expect(request.messages[0].content).toContain("No flattery");
  expect(request.messages[0].content).toContain("INT. KITCHEN - DAY");
  expect(request.messages[0].content).toContain("Rain falls on the car.");
  expect(request.messages[0].content).toContain('Backlot project "Test Film"');
  expect(request.messages[0].content).toContain("stunts: car flip");
  expect(request.messages[0].content).toContain("scheduled day 1 Yard");
  expect(request.messages.at(-1)).toEqual({ role: "user", content: "Which scenes need the stunt coordinator?" });
  await expect(page.locator(".assistant-note")).toContainText("qwen3.5:4b");

  // A change is a suggestion with an Apply button; nothing changed until it is pressed.
  expect(await textOf(page, "a3")).toBe("Rain falls on the car.");
  await page.getByRole("button", { name: "Apply" }).click();
  expect(await textOf(page, "a3")).toBe("Rain hammers the car.");
  await expect(page.getByRole("button", { name: "Applied" })).toBeDisabled();

  // Quick actions send a fixed question.
  mock.reply = "Two sentences about the scene.";
  await page.getByRole("button", { name: "Summarize scene" }).click();
  await expect(page.locator(".assistant-reply").last()).toContainText("Two sentences about the scene.");
  expect(mock.chats.at(-1).messages.at(-1).content).toMatch(/^Summarize Scene 1 \(INT\. KITCHEN - DAY\) in two or three sentences/);
  expect(mock.chats.at(-1).messages).toHaveLength(4);

  // Stop ends a running answer.
  mock.reply = (res) => res.write(JSON.stringify({ message: { content: "Starting to answer" }, done: false }) + "\n");
  await page.getByLabel("Ask about the script").fill("A long one");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".assistant-reply").last()).toContainText("Starting to answer");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".assistant-reply").last().locator(".assistant-note")).toContainText("Stopped");
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeVisible();

  // A provider problem is shown as an error, not hidden.
  await page.evaluate(() => (window as any).__app.setSetting("ai.provider", "anthropic"));
  await page.getByLabel("Ask about the script").fill("Hello?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".assistant-error").last()).toContainText("No API key is set for anthropic");
  expect(errors).toEqual([]);
  await closeApp(electronApp, page);
  await mock.close();
});

test("API keys are write-only: the renderer learns only whether one is set", async () => {
  const { electronApp, page } = await launch();
  const result = await page.evaluate(async () => {
    const desktop = (window as any).desktop;
    const before = await desktop.invoke("ai:status");
    await desktop.invoke("ai:set-key", "anthropic", "sk-ant-e2e-secret-key");
    const after = await desktop.invoke("ai:status");
    const settings = await desktop.invoke("settings:get");
    const rejected = await desktop.invoke("ai:set-key", "ollama", "x").then(() => "accepted", (e: Error) => e.message);
    await desktop.invoke("ai:clear-key", "anthropic");
    const cleared = await desktop.invoke("ai:status");
    return { before, after, settings, rejected, cleared };
  });
  const keySet = (status: any) => status.providers.find((p: any) => p.provider === "anthropic").keySet;
  expect([keySet(result.before), keySet(result.after), keySet(result.cleared)]).toEqual([false, true, false]);
  expect(JSON.stringify(result)).not.toContain("sk-ant-e2e-secret-key");
  expect(result.rejected).toMatch(/does not use a key/);
  await closeApp(electronApp, page);
});

test("with the script editor: marks are drawn, Accept is undone by the editor's undo, a swapped document starts clean", async () => {
  const { electronApp, page } = await launch();
  const hasEditor = await page.evaluate(() => (window as any).__app.features.some((f: any) => f.id === "editor"));
  test.skip(!hasEditor, "The editor feature is not on this branch.");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".editor-pm");
  await openPanel(page, "proofread");
  await page.evaluate(() => (window as any).__app.editor.focus());
  await page.keyboard.type("int. kitchen - day");
  await page.keyboard.press("Enter");
  await page.keyboard.type("MAYA pours the the coffee.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".proofread-item")).toHaveCount(1);
  await expect(page.locator(".proofread-mark")).toHaveText(["the the"]);

  await page.locator(".proofread-item").getByRole("button", { name: /Accept/ }).click();
  await expect(page.locator(".proofread-item")).toHaveCount(0);
  await expect(page.locator(".proofread-mark")).toHaveCount(0);
  await page.evaluate(() => (window as any).__app.editor.focus());
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".proofread-item")).toHaveCount(1);

  // Opening another document replaces the findings and the ignored list with that document's own.
  await page.evaluate(() => {
    const app = (window as any).__app;
    const doc = new app.session.doc.constructor();
    doc.load({ titlePage: [], paragraphs: [{ id: "z1", type: "sceneHeading", runs: [{ text: "INT. B - DAY" }] }, { id: "z2", type: "action", runs: [{ text: "Fine." }] }] });
    app.setSession(new app.session.constructor(doc));
  });
  await expect(page.locator(".proofread-item")).toHaveCount(0);
  await expect(page.locator(".proofread-mark")).toHaveCount(0);
  expect(errors).toEqual([]);
  await closeApp(electronApp, page);
});

test("a whole-speech cut: proposed through tools, applied, undone in one step; answers render Markdown; continuity needs a capable model", async () => {
  const mock = await mockOllama();
  const { electronApp, page } = await launch();
  await useMock(page, mock);
  await loadScript(page, KITCHEN);
  await openPanel(page, "assistant");
  // The local model may not check continuity across the script.
  await expect(page.getByRole("button", { name: /Check continuity across the script/ })).toBeDisabled();
  await expect(page.locator(".assistant-needs")).toHaveText("Needs ChatGPT or an API key");

  const turn = (message: Record<string, unknown>) => (res: http.ServerResponse) => res.end(JSON.stringify({ message: { role: "assistant", content: "", ...message }, done: true }));
  mock.reply = (res) => {
    const tools = mock.chats.at(-1).messages.filter((m: { role: string }) => m.role === "tool").length;
    const next = tools === 0 ? turn({ tool_calls: [{ function: { name: "read_scene", arguments: { scene: "1" } } }] })
      : tools === 1 ? turn({ tool_calls: [{ function: { name: "propose_edit", arguments: { scene: "1", find: "Anyone?", replace: "", why: "Says nothing new." } } }] })
      : turn({ content: "**Proposed** a cut:\n\n- MAYA's *Anyone?*" });
    next(res);
  };
  await page.getByLabel("Ask about the script").fill("Trim scene 1.");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".assistant-suggestion-label")).toHaveText("Cut speech, scene 1");
  await expect(page.locator(".assistant-text strong")).toHaveText("Proposed");
  await expect(page.locator(".assistant-text li em")).toHaveText("Anyone?");
  await expect(page.locator(".assistant-note").last()).toContainText("Read 1 of 2 scenes");
  expect(mock.chats[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("propose_edit");
  expect(mock.chats[0].think).toBe(true);

  const ids = () => page.evaluate(() => (window as any).__app.session.script().paragraphs.map((p: { id: string }) => p.id));
  expect(await ids()).toContain("c2");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "Applied" })).toBeDisabled();
  expect(await ids()).not.toContain("c2");
  expect(await ids()).not.toContain("d2");
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await ids()).toEqual(expect.arrayContaining(["c2", "d2"]));
  expect(await textOf(page, "d2")).toBe("Anyone?");
  await closeApp(electronApp, page);
  await mock.close();
});
