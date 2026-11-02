// Dictation end to end, with no real microphone, speech helper or model: a fake helper script speaks the
// helper's JSON protocol and a local HTTP server answers like Ollama. The app is the real built app.
import { expect, test, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeWav } from "../src/renderer/features/dictation/wav.ts";
import { launch } from "./helpers.ts";

type Launched = Awaited<ReturnType<typeof launch>>;

const SPOKEN = "Interior kitchen night. Maya stands at the sink. Maya says, I can't do this anymore.";
const PROPOSAL = {
  elements: [
    { type: "scene_heading", text: "INT. KITCHEN - NIGHT", source_quote: "Interior kitchen night.", uncertainty: "" },
    { type: "action", text: "Maya stands at the sink.", source_quote: "Maya stands at the sink.", uncertainty: "" },
    { type: "character", text: "MAYA", source_quote: "Maya says, I can't do this anymore.", uncertainty: "" },
    { type: "dialogue", text: "I can't do this anymore.", source_quote: "I can't do this anymore.", uncertainty: "" },
  ],
  omissions: [],
  warnings: [],
};

let folder: string;
let helper: string;
let log: string;
let server: Server;
let endpoint: string;
const chatBodies: string[] = [];

test.beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "dictation-e2e-"));
  log = join(folder, "helper.log");
  // Named like the real helper: a path typed into Settings must end in speech-helper or whisper-cli to run.
  helper = join(folder, "speech-helper");
  // Speaks `speech-helper serve`: one JSON request per line in, one reply per line out. For each take it logs
  // the WAV header it was given.
  writeFileSync(helper, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv[2] === "engines") {
  reply({ engines: ["parakeet", "apple", "whisper"] });
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "prepare") return reply({ id: request.id, ok: true, loadMs: 4 });
  if (request.op === "transcribe") {
    const bytes = readFileSync(request.path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({
      riff: bytes.subarray(0, 4).toString(), wave: bytes.subarray(8, 12).toString(), channels: view.getUint16(22, true),
      rate: view.getUint32(24, true), bits: view.getUint16(34, true), bytes: bytes.length, engine: request.engine,
    }) + "\\n");
    return reply({ id: request.id, ok: true, result: { engine: "fake", text: ${JSON.stringify(SPOKEN)}, words: [], audioSeconds: 1, transcribeMs: 3 } });
  }
  reply({ id: request.id, ok: false, error: "unknown op" });
});
`);
  chmodSync(helper, 0o755);
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] }));
      if (request.url === "/api/chat") {
        chatBodies.push(body);
        return response.end(JSON.stringify({ message: { content: JSON.stringify(PROPOSAL) }, done: true, done_reason: "stop" }));
      }
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => server.close());

/** Mark the script saved so quitting does not stop to ask about unsaved changes, then quit. */
async function finish(electronApp: Launched["electronApp"], page: Page): Promise<void> {
  await page.evaluate(() => void ((window as any).__app.session.dirty = false));
  await electronApp.close();
}

/** Pick a helper the way the writer does: Choose in Settings, answered here by a stubbed open dialog. */
async function chooseHelper(electronApp: Launched["electronApp"], page: Page, path: string): Promise<unknown> {
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
  }, path);
  return page.evaluate(() => (window as any).desktop.invoke("dictation:choose-helper").catch((e: Error) => e.message));
}

async function configure(electronApp: Launched["electronApp"], page: Page): Promise<void> {
  await chooseHelper(electronApp, page, helper);
  await page.evaluate(async (url) => (window as any).__app.setSetting("dictation.endpoint", url), endpoint);
}

const paragraphs = (page: Page) => page.evaluate(() =>
  (window as any).__app.session.script().paragraphs.map((p: any) => ({ type: p.type, text: p.runs.map((r: any) => r.text).join("") })));

async function writeLine(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const { session } = (window as any).__app;
    const first = session.script().paragraphs[0];
    session.edit(() => session.doc.insertText(first.id, 0, line));
  }, text);
}

test("a recording goes through the helper and the model, is shown, and inserts only on Insert", async () => {
  const { electronApp, page } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await configure(electronApp, page);
  await writeLine(page, "INT. HALL - DAY");

  const wav = Array.from(encodeWav([new Float32Array(16000).fill(0.2)]));
  await page.evaluate((bytes) => (window as any).__dictation.processAudio(new Uint8Array(bytes)), wav);

  await expect(page.locator(".sidepanel-right .sidepanel-tabs, .sidepanel-right .sidepanel-title")).toContainText(/Dictate/);
  await expect(page.locator(".dictation-transcript")).toHaveText(SPOKEN);
  await expect(page.locator(".dictation-el")).toHaveCount(4);
  await expect(page.locator(".dictation-el-sceneHeading")).toHaveText("INT. KITCHEN - NIGHT");
  await expect(page.locator(".dictation-el-character")).toHaveText("MAYA");
  await expect(page.locator(".dictation-hint", { hasText: "transcribed in" })).toBeVisible();

  // Nothing is applied until the writer says so.
  expect(await paragraphs(page)).toHaveLength(1);

  await page.getByRole("button", { name: "Insert 4 elements" }).click();
  const after = await paragraphs(page);
  expect(after.map((p: any) => p.type)).toEqual(["sceneHeading", "sceneHeading", "action", "character", "dialogue"]);
  expect(after[1].text).toBe("INT. KITCHEN - NIGHT");
  expect(after[4].text).toBe("I can't do this anymore.");
  await expect(page.locator(".dictation-el")).toHaveCount(0);

  // The helper got a real WAV file: 16 kHz, mono, 16-bit.
  const [heard] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(heard).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 1, rate: 16000, bits: 16, bytes: 44 + 32000, engine: "parakeet" });

  // The model was shown the script around the caret.
  const sent = JSON.parse(JSON.parse(chatBodies.at(-1)!).messages[1].content);
  expect(sent.current_transcript).toBe(SPOKEN);
  expect(sent.context.current_heading).toBe("INT. HALL - DAY");

  // One undo takes the whole take back out.
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect(await paragraphs(page)).toHaveLength(1);
  expect(errors).toEqual([]);
  await finish(electronApp, page);
});

test("a typed transcript is formatted, and Discard drops it without touching the script", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await page.evaluate(() => (window as any).__app.togglePanel("dictation", true));
  await page.getByLabel("Transcript to format").fill(SPOKEN);
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await expect(page.locator(".dictation-el")).toHaveCount(4);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".dictation-el")).toHaveCount(0);
  expect(await paragraphs(page)).toEqual([{ type: "sceneHeading", text: "" }]);
  await finish(electronApp, page);
});

test("an empty script's heading is filled by the take instead of being left behind", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await page.evaluate((text) => (window as any).__dictation.formatText(text), SPOKEN);
  await page.getByRole("button", { name: "Insert 4 elements" }).click();
  expect((await paragraphs(page)).map((p: any) => p.type)).toEqual(["sceneHeading", "action", "character", "dialogue"]);
  await finish(electronApp, page);
});

test("a spoken edit command is a suggestion with a preview, applied only on Accept", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await writeLine(page, "Bob waits. Bobby does not. Bob's coat is wet.");
  const before = chatBodies.length;
  await page.evaluate(() => (window as any).__app.togglePanel("dictation", true));
  await page.getByLabel("Transcript to format").fill("Change Bob to Robert everywhere.");
  await page.getByRole("button", { name: "Format", exact: true }).click();
  const card = page.locator(".dictation-suggestion");
  await expect(card).toContainText("Change “Bob” to “Robert”");
  await expect(card).toContainText("2 matches");
  await expect(card.locator("del")).toHaveText(["Bob", "Bob"]);
  await expect(card.locator("ins")).toHaveText(["Robert", "Robert"]);
  expect(chatBodies.length, "the model is not asked about a command").toBe(before);
  expect((await paragraphs(page))[0].text).toBe("Bob waits. Bobby does not. Bob's coat is wet.");

  await card.getByRole("button", { name: "Accept" }).click();
  expect((await paragraphs(page))[0].text).toBe("Robert waits. Bobby does not. Robert's coat is wet.");
  await page.evaluate(() => (window as any).__app.session.undo.undo());
  expect((await paragraphs(page))[0].text).toBe("Bob waits. Bobby does not. Bob's coat is wet.");
  await finish(electronApp, page);
});

test("Ignore leaves the script alone", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await writeLine(page, "Bob waits.");
  await page.evaluate(() => (window as any).__dictation.formatText("Replace Bob with Robert."));
  await page.locator(".dictation-suggestion").getByRole("button", { name: "Ignore" }).click();
  expect((await paragraphs(page))[0].text).toBe("Bob waits.");
  await finish(electronApp, page);
});

test("editing the transcript formats the corrected text", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await page.evaluate((text) => (window as any).__dictation.formatText(text), SPOKEN);
  await page.getByRole("button", { name: "Edit transcript" }).click();
  await page.getByLabel("Transcript", { exact: true }).fill(SPOKEN);
  const before = chatBodies.length;
  await page.getByRole("button", { name: "Re-format" }).click();
  await expect(page.locator(".dictation-el")).toHaveCount(4);
  expect(chatBodies.length).toBe(before + 1);
  await finish(electronApp, page);
});

test("a missing helper and a missing model server are explained", async () => {
  const { electronApp, page } = await launch();
  // A helper the writer chose that has since been deleted.
  const gone = join(mkdtempSync(join(tmpdir(), "dictation-gone-")), "speech-helper");
  writeFileSync(gone, "#!/bin/sh\n");
  chmodSync(gone, 0o755);
  await chooseHelper(electronApp, page, gone);
  rmSync(gone);
  await page.evaluate(async () => (window as any).__app.setSetting("dictation.endpoint", "http://127.0.0.1:9"));
  const wav = Array.from(encodeWav([new Float32Array(16000).fill(0.2)]));
  await page.evaluate((bytes) => (window as any).__dictation.processAudio(new Uint8Array(bytes)), wav);
  await expect(page.locator(".dictation-error")).toContainText(`The speech helper was not found at ${gone}`);
  await expect(page.locator(".dictation-error")).toContainText("swift build -c release");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.evaluate((text) => (window as any).__dictation.formatText(text), SPOKEN);
  await expect(page.locator(".dictation-error")).toContainText("Start Ollama");
  await expect(page.locator(".dictation-transcript")).toHaveText(SPOKEN);

  const check = await page.evaluate(() => (window as any).desktop.invoke("dictation:check"));
  expect(check.helper.ok).toBe(false);
  expect(check.server.ok).toBe(false);
  expect(check.server.message).toContain("Start Ollama");
  await finish(electronApp, page);
});

test("Settings > Dictation prepares the engine and checks the model server", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await page.evaluate(() => (window as any).__app.openModal("workspace.settings"));
  await page.locator(".workspace-settings nav").getByText("Dictation").click();
  await page.getByRole("button", { name: "Prepare engine" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Speech engine ready" })).toBeVisible();
  await page.getByRole("button", { name: "Check model server" }).click();
  await expect(page.getByText("Model server answered. qwen3.5:4b is installed.")).toBeVisible();
  await expect(page.getByText(/Speech helper found/)).toBeVisible();
  await finish(electronApp, page);
});

test("the microphone records, meters and sends a 16 kHz mono WAV (fake device)", async () => {
  const { electronApp, page } = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  await configure(electronApp, page);
  await writeLine(page, "INT. HALL - DAY");
  await page.evaluate(() => (window as any).__app.togglePanel("dictation", true));
  const mic = page.locator(".dictation-mic");
  // The fake microphone beeps; remember the loudest the meter showed.
  await page.evaluate(() => {
    const w = window as any;
    w.__maxLevel = 0;
    setInterval(() => (w.__maxLevel = Math.max(w.__maxLevel, w.__dictation.store.state.level)), 20);
  });
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(mic).toContainText("Stop");
  const tap = await page.evaluate(() => (window as any).__dictation.tapKind());
  console.log(`audio tap: ${tap}`);
  expect(tap, "the audio worklet loads under the CSP").toBe("worklet");
  await page.waitForTimeout(2500);
  const seconds = await page.evaluate(() => (window as any).__dictation.store.state.seconds);
  expect(seconds).toBeGreaterThan(1.5);
  expect(await page.evaluate(() => (window as any).__maxLevel)).toBeGreaterThan(0.2);
  await mic.click();
  await expect(page.locator(".dictation-el")).toHaveCount(4, { timeout: 20_000 });
  const heard = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  expect(heard).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 1, rate: 16000, bits: 16 });
  const audioSeconds = (heard.bytes - 44) / 32000;
  expect(audioSeconds).toBeGreaterThan(2);
  expect(audioSeconds).toBeLessThan(4.5);
  await finish(electronApp, page);
});

test("the toggle command starts and stops recording", async () => {
  const { electronApp, page } = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  await configure(electronApp, page);
  await page.evaluate(() => (window as any).__app.runCommand("dictation.toggle"));
  await expect.poll(() => page.evaluate(() => (window as any).__dictation.store.state.phase)).toBe("recording");
  await page.waitForTimeout(1200);
  await page.evaluate(() => (window as any).__app.runCommand("dictation.toggle"));
  await expect.poll(() => page.evaluate(() => (window as any).__dictation.store.state.phase), { timeout: 20_000 }).toBe("review");
  await finish(electronApp, page);
});

test("the app's own page gets the microphone through its permission handler, and nothing else gets anything", async () => {
  // No fake-UI flag, so Chromium asks the main process instead of approving by itself.
  const { electronApp, page } = await launch(["--use-fake-device-for-media-stream"]);
  const result = await page.evaluate(async () => {
    const attempt = async (constraints: MediaStreamConstraints) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
        return "granted";
      } catch (error) {
        return (error as Error).name;
      }
    };
    return {
      audio: await attempt({ audio: true }),
      camera: await attempt({ video: true }),
      geolocation: (await navigator.permissions.query({ name: "geolocation" })).state,
    };
  });
  expect(result.audio).toBe("granted");
  expect(result.camera).not.toBe("granted");
  expect(result.geolocation).toBe("denied");
  await finish(electronApp, page);
});

test("opening another document drops a take made for the old one, and a take still in flight is ignored", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  await writeLine(page, "INT. HALL - DAY");
  await page.evaluate((text) => (window as any).__dictation.formatText(text), SPOKEN);
  await expect(page.locator(".dictation-el")).toHaveCount(4);

  const swap = () => {
    const app = (window as any).__app;
    app.setSession(app.session.constructor.untitled());
  };
  await page.evaluate(swap);
  await expect(page.locator(".dictation-el")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__dictation.store.state.take)).toBeNull();

  // The document changes while the model is still answering: the answer is not shown.
  await page.evaluate(async ([text, code]) => {
    const d = (window as any).__dictation;
    const pending = d.formatText(text);
    new Function(`(${code})()`)();
    await pending;
  }, [SPOKEN, swap.toString()] as const);
  expect(await page.evaluate(() => (window as any).__dictation.store.state.phase)).toBe("idle");
  await expect(page.locator(".dictation-el")).toHaveCount(0);
  await finish(electronApp, page);
});

test("pressing the toggle twice while the microphone opens ends with no recording", async () => {
  const { electronApp, page } = await launch(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  await configure(electronApp, page);
  await page.evaluate(async () => {
    const d = (window as any).__dictation;
    await Promise.all([d.toggleRecording(), d.toggleRecording()]);
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__dictation.store.state.phase)).toBe("idle");
  await finish(electronApp, page);
});

test("the service refuses a request that is not audio or text before it allocates anything", async () => {
  const { electronApp, page } = await launch();
  await configure(electronApp, page);
  const context = { characters: [], locations: [], currentHeading: "", referenceText: "", previousElements: [], introduced: [] };
  const messages = await page.evaluate(async (ctx) => {
    const invoke = (channel: string, request: unknown) =>
      (window as any).desktop.invoke(channel, request).then(() => "accepted", (error: Error) => error.message);
    return [
      await invoke("dictation:process", { takeId: 1, audio: 4_000_000_000, context: ctx }),
      await invoke("dictation:process", { takeId: 1, audio: new Uint8Array(100), context: ctx }),
      await invoke("dictation:format", { takeId: 1, text: 12, context: ctx }),
    ];
  }, context);
  expect(messages[0]).toMatch(/not audio data/);
  expect(messages[1]).toMatch(/not a WAV file/);
  expect(messages[2]).toMatch(/no text to format/);
  await finish(electronApp, page);
});

test("only the writer's pick in the Choose dialog sets the speech helper; a page cannot", async () => {
  const { electronApp, page, userData } = await launch();
  // A program a compromised page might try to have the main process run.
  const other = join(folder, "other-program");
  const ran = join(folder, "other.log");
  writeFileSync(other, `#!/bin/sh\necho ran > ${JSON.stringify(ran)}\necho '{"engines":[]}'\n`);
  chmodSync(other, 0o755);
  const check = () => page.evaluate(() => (window as any).desktop.invoke("dictation:check"));
  const stored = () => page.evaluate(async () => ((await (window as any).desktop.invoke("settings:get")) as Record<string, unknown>)["grants.speechHelper"]);
  const refused = await page.evaluate((path) => (window as any).__app.setSetting("grants.speechHelper", path).then(() => "set", (e: Error) => e.message), other);
  expect(refused).toContain("managed by the app");
  expect(await stored()).toBeUndefined();
  // The setting pages could write before is ignored.
  await page.evaluate(async (path) => (window as any).__app.setSetting("dictation.helperPath", path), other);
  expect((await check()).helper.path).not.toBe(other);
  // Nor can the page write the settings file itself.
  const forged = await page.evaluate(([path, json]) => (window as any).desktop.invoke("files:write", path, json).then(() => "written", (e: Error) => e.message),
    [join(userData, "settings.json"), JSON.stringify({ "grants.speechHelper": other })] as const);
  expect(forged).toContain("Save dialog");
  expect(existsSync(ran)).toBe(false);

  // Picking the file in the Choose dialog is the writer's own decision: it may run from then on, whatever its name.
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog;
  }, other);
  await page.evaluate(() => (window as any).__app.openModal("workspace.settings"));
  await page.locator(".workspace-settings nav").getByText("Dictation").click();
  await page.locator(".dictation-helper").getByRole("button", { name: "Choose…" }).click();
  await expect.poll(stored).toBe(other);
  await expect(page.locator(".dictation-helper-path")).toHaveText(other);
  const accepted = await check();
  expect(accepted.helper.path).toBe(other);
  expect(accepted.helper.ok).toBe(true);
  await page.locator(".dictation-helper").getByRole("button", { name: "Find Automatically" }).click();
  await expect.poll(stored).toBeUndefined();
  await finish(electronApp, page);
});

test("the permission handlers decide the microphone and still let the page use the clipboard", async () => {
  const { electronApp, page } = await launch();
  const result = await page.evaluate(async () => {
    const state = async (name: string) => (await navigator.permissions.query({ name: name as PermissionName })).state;
    let wrote = "no";
    try {
      await navigator.clipboard.writeText("invite text");
      wrote = "yes";
    } catch (error) {
      wrote = (error as Error).name;
    }
    return { write: await state("clipboard-write"), wrote, geolocation: await state("geolocation") };
  });
  expect(result.write).toBe("granted");
  expect(result.geolocation).toBe("denied");
  // writeText also needs a focused document, which a hidden test window may lack; what matters is the handler's answer above.
  expect(["yes", "NotAllowedError"]).toContain(result.wrote);
  await finish(electronApp, page);
});
