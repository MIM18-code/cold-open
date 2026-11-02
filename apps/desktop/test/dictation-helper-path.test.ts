// The main process runs the speech helper, so only the main process may choose it: the writer picks it in a native
// dialog (kept under grants.*, which pages cannot set), or the app finds its own build. A page cannot point it anywhere.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHANNELS } from "../src/shared/api.ts";
import { SETTING_KEYS } from "../src/shared/channels/dictation.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { helperPathProblem, readConfig } from "../src/main/dictation/config.ts";
import { DictationRuntime } from "../src/main/dictation/runtime.ts";
import { register as registerSettings } from "../src/main/services/settings.ts";

function program(folder: string, name: string, mode = 0o755): string {
  const path = join(folder, name);
  writeFileSync(path, "#!/bin/sh\necho '{\"engines\":[]}'\n");
  chmodSync(path, mode);
  return path;
}

test("a page cannot set the speech helper: the key is managed by the main process", async () => {
  const handlers = new Map<string, Handler>();
  const values: Record<string, unknown> = {};
  const ctx = {
    handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
    settings: { set: (key: string, value: unknown) => void (values[key] = value), all: () => values },
  } as unknown as ServiceContext;
  registerSettings(ctx);
  const set = (key: string, value: unknown) => handlers.get(CHANNELS.settingsSet)!({} as never, key, value);
  assert.match(SETTING_KEYS.helperPath, /^grants\./);
  assert.throws(() => set(SETTING_KEYS.helperPath, "/tmp/evil/speech-helper"), /managed by the app/);
  assert.throws(() => set("grants.anything", "x"), /managed by the app/);
  assert.equal(values[SETTING_KEYS.helperPath], undefined);
  set("dictation.engine", "apple");
  assert.equal(values["dictation.engine"], "apple");
});

test("the old page-writable helper setting is ignored; the app's own build is used instead", () => {
  const folder = mkdtempSync(join(tmpdir(), "helper-old-"));
  const evil = program(folder, "speech-helper");
  const built = join(folder, "repo", "native/speech-helper/.build/release/speech-helper");
  const config = readConfig({ "dictation.helperPath": evil }, { repoRoot: join(folder, "repo"), exists: (path) => path === built });
  assert.equal(config.helperPath, built);
  assert.equal(config.helperGranted, false);
});

test("a granted helper must still be a full path to an executable file", () => {
  const folder = mkdtempSync(join(tmpdir(), "helper-path-"));
  const any = program(folder, "rm-everything");
  assert.equal(helperPathProblem(any), null, "a file picked in Choose may have any name");
  assert.match(helperPathProblem("speech-helper")!, /full path/);
  assert.match(helperPathProblem(program(folder, "speech-helper-copy", 0o644))!, /not executable/);
  mkdirSync(join(folder, "dir"));
  assert.match(helperPathProblem(join(folder, "dir"))!, /not a file/);
  // A missing file is not refused here; the caller reports it as not found.
  assert.equal(helperPathProblem(join(folder, "missing", "speech-helper")), null);
});

test("the runtime uses the granted helper and runs nothing a page named", async () => {
  const folder = mkdtempSync(join(tmpdir(), "helper-runtime-"));
  const chosen = program(folder, "my-helper");
  const lookup = { repoRoot: folder };
  const granted = new DictationRuntime({ settings: () => ({ [SETTING_KEYS.helperPath]: chosen, "dictation.endpoint": "http://127.0.0.1:9" }), lookup });
  assert.equal((await granted.check()).helper.ok, true);
  const typed = new DictationRuntime({ settings: () => ({ "dictation.helperPath": chosen, "dictation.endpoint": "http://127.0.0.1:9" }), lookup });
  const result = await typed.check();
  assert.equal(result.helper.ok, false);
  assert.notEqual(result.helper.path, chosen);
});
