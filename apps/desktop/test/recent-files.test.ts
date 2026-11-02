// The recent-files list grants access to files across restarts, so a page must not be able to put a file on it
// that the writer never chose, and a launch must not re-open access to anything that is not a screenplay file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { CHANNELS } from "../src/shared/api.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { RECENT_KEY, registerRecentFiles } from "../src/main/recent-files.ts";
import { Settings } from "../src/main/settings-store.ts";

const temp = mkdtempSync(join(tmpdir(), "screenplay-recent-"));
after(() => rmSync(temp, { recursive: true, force: true }));

/** One run of the app: a fresh allow list over the same settings file, as after a restart. */
function launch(settingsFile: string) {
  const handlers = new Map<string, Handler>();
  const allowed = new Set<string>();
  const documents: string[] = [];
  const settings = new Settings(settingsFile);
  const ctx = {
    handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
    settings,
    allowPath: (path: string) => void allowed.add(resolve(path)),
    isAllowedPath: (path: string) => typeof path === "string" && !!path && allowed.has(resolve(path)),
  } as unknown as ServiceContext;
  registerRecentFiles(ctx, (path) => void documents.push(path));
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as never, ...args);
  return { ctx, settings, documents, addRecent: (path: unknown) => call(CHANNELS.addRecent, path), recent: () => call(CHANNELS.recentFiles) as string[] };
}

function file(name: string, text = "INT. ROOM - DAY\n"): string {
  const path = join(temp, name);
  writeFileSync(path, text);
  return path;
}

test("a page cannot add a file it was never given to the recent list, so a restart does not grant it", () => {
  const settingsFile = join(mkdtempSync(join(temp, "run-")), "settings.json");
  const secret = file("private-notes.txt", "not chosen by the writer");
  const first = launch(settingsFile);
  assert.throws(() => first.addRecent(secret), /not opened through the app/);
  assert.throws(() => first.addRecent(42));
  assert.deepEqual(first.settings.get(RECENT_KEY), undefined);
  assert.deepEqual(first.documents, []);
  const second = launch(settingsFile);
  assert.equal(second.ctx.isAllowedPath(secret), false);
  assert.deepEqual(second.recent(), []);
});

test("a chosen script stays reachable after a restart, and only while it is still a screenplay file", () => {
  const settingsFile = join(mkdtempSync(join(temp, "run-")), "settings.json");
  const script = file("Pilot.fdx", "<FinalDraft/>");
  const fountain = file("Notes.fountain");
  const first = launch(settingsFile);
  first.ctx.allowPath(script);
  first.ctx.allowPath(fountain);
  first.addRecent(fountain);
  first.addRecent(script);
  assert.deepEqual(first.documents, [fountain, script]);
  assert.deepEqual(first.recent(), [script, fountain]);

  const second = launch(settingsFile);
  assert.equal(second.ctx.isAllowedPath(script), true);
  assert.deepEqual(second.recent(), [script, fountain]);

  // The script is deleted and a folder takes its name: no longer a file, so not granted or offered.
  rmSync(script);
  mkdirSync(script);
  const third = launch(settingsFile);
  assert.equal(third.ctx.isAllowedPath(script), false);
  assert.deepEqual(third.recent(), [fountain]);
});

test("entries already in the settings file that are not screenplay files are not granted at launch", () => {
  const settingsFile = join(mkdtempSync(join(temp, "run-")), "settings.json");
  const key = file("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----");
  const config = file("config.json", "{}");
  const script = file("Draft.screenplay", "x");
  writeFileSync(settingsFile, JSON.stringify({ [RECENT_KEY]: [key, config, "relative/Draft.fdx", join(temp, "missing.fdx"), 7, script] }));
  const run = launch(settingsFile);
  assert.equal(run.ctx.isAllowedPath(key), false);
  assert.equal(run.ctx.isAllowedPath(config), false);
  assert.equal(run.ctx.isAllowedPath(join(temp, "missing.fdx")), false);
  assert.equal(run.ctx.isAllowedPath(script), true);
  assert.deepEqual(run.recent(), [script]);
});

test("a granted file of another type is opened but not kept as a recent file", () => {
  const settingsFile = join(mkdtempSync(join(temp, "run-")), "settings.json");
  const pdf = file("Pilot.pdf", "%PDF-1.7");
  const run = launch(settingsFile);
  run.ctx.allowPath(pdf);
  run.addRecent(pdf);
  assert.deepEqual(run.recent(), []);
  assert.deepEqual(run.documents, []);
});
