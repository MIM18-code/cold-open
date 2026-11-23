// Settings a page can write must never reach the main-owned ones (files.*, grants.*), including through the
// object's prototype: "__proto__" is an ordinary-looking key that would otherwise make every lookup inherit it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHANNELS } from "../src/shared/api.ts";
import { AI_SETTINGS } from "../src/shared/channels/ai.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { register as registerSettings } from "../src/main/services/settings.ts";
import { Settings } from "../src/main/settings-store.ts";

function page(settings: Settings) {
  const handlers = new Map<string, Handler>();
  registerSettings({ handle: (channel: string, handler: Handler) => void handlers.set(channel, handler), settings } as unknown as ServiceContext);
  return (key: unknown, value: unknown) => handlers.get(CHANNELS.settingsSet)!({} as never, key, value);
}

test("a page cannot reach main-owned settings through __proto__", () => {
  const settings = new Settings(join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json"));
  const set = page(settings);
  const forged = { [AI_SETTINGS.backlotPath]: "/Users/someone/Other Film/project.json", "files.recent": ["/etc/hosts"] };
  for (const key of ["__proto__", "constructor", "prototype"]) {
    try {
      set(key, forged);
    } catch {
      // Refusing the key is fine too; what matters is what the main process reads afterwards.
    }
  }
  assert.equal(settings.get(AI_SETTINGS.backlotPath), undefined);
  assert.equal(settings.get("files.recent"), undefined);
  assert.equal(settings.get("toString"), undefined);
  // The store holds even if a caller forgets to check the key.
  settings.set("__proto__", forged);
  assert.equal(settings.get(AI_SETTINGS.backlotPath), undefined);
  assert.equal(settings.get("files.recent"), undefined);
});

test("a settings file with odd keys loads as plain values", () => {
  const file = join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json");
  writeFileSync(file, JSON.stringify({ "editor.zoom": 1.2, ["__proto__"]: { "grants.speechHelper": "/tmp/x" } }));
  const settings = new Settings(file);
  assert.equal(settings.get("editor.zoom"), 1.2);
  assert.equal(settings.get("grants.speechHelper"), undefined);
  settings.set("editor.zoom", 1.5);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))["editor.zoom"], 1.5);
});

test("settings:set refuses keys that are not strings, and main-owned prefixes", () => {
  const settings = new Settings(join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json"));
  const set = page(settings);
  assert.throws(() => set(42, "x"));
  assert.throws(() => set("grants.speechHelper", "/tmp/x"), /managed by the app/);
  assert.throws(() => set("files.recent", ["/etc/hosts"]), /managed by the app/);
  assert.throws(() => set("phone.port", 8080), /managed by the app/);
  set("editor.zoom", 2);
  assert.equal(settings.get("editor.zoom"), 2);
});

test("a value that cannot be saved changes nothing and does not block later settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  const settings = new Settings(join(dir, "settings.json"));
  const heard: string[] = [];
  settings.onChange((key) => heard.push(key));
  settings.set("a", 1);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  // Structured clone carries both of these over IPC; JSON holds neither.
  assert.throws(() => settings.set("ai.x", 10n));
  assert.throws(() => settings.set("c", cycle));
  assert.equal(settings.get("ai.x"), undefined);
  settings.set("b", 2);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { a: 1, b: 2 });
  assert.deepEqual(heard, ["a", "b"]);

  // A write that fails leaves memory as it was on disk.
  writeFileSync(join(dir, "blocker"), "");
  const unwritable = new Settings(join(dir, "blocker", "settings.json"));
  assert.throws(() => unwritable.set("a", 1));
  assert.equal(unwritable.get("a"), undefined);
});
