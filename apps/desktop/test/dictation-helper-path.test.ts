// The main process runs the speech helper, so only the main process may choose it: the writer picks it in a native
// dialog (kept under grants.*, which pages cannot set), or the app finds its own build. A page cannot point it anywhere.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHANNELS } from "../src/shared/api.ts";
import { SETTING_KEYS } from "../src/shared/channels/dictation.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { helperPathProblem, readConfig, resolveHelperPath } from "../src/main/dictation/config.ts";
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

test("closing the runtime also waits for a helper that was just replaced", async () => {
  const folder = mkdtempSync(join(tmpdir(), "helper-replaced-"));
  // Answers every call, and after its input closes takes a moment to exit, leaving a mark when it does.
  const helper = (name: string, linger: string) => {
    const path = join(folder, name);
    writeFileSync(path, `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed 's/.*"id":\\([0-9]*\\).*/\\1/')
  printf '{"id":%s,"ok":true}\\n' "$id"
done
sleep ${linger}
touch "${path}.exited"
`);
    chmodSync(path, 0o755);
    return path;
  };
  const first = helper("first-helper", "1"), second = helper("second-helper", "0");
  let chosen = first;
  const runtime = new DictationRuntime({ settings: () => ({ [SETTING_KEYS.helperPath]: chosen, "dictation.endpoint": "http://127.0.0.1:9" }), lookup: { repoRoot: folder } });
  await runtime.prepare();
  chosen = second;
  await runtime.prepare();
  await runtime.close();
  assert.equal(existsSync(`${first}.exited`), true, "quit did not wait for the replaced helper");
  assert.equal(existsSync(`${second}.exited`), true);
});

test("a packaged app ignores SCREENPLAY_SPEECH_HELPER, so the launching program cannot pick what it runs", () => {
  const env = { SCREENPLAY_SPEECH_HELPER: "/tmp/evil/speech-helper" };
  const shipped = "/App/Resources/speech-helper";
  const exists = (path: string) => path === env.SCREENPLAY_SPEECH_HELPER || path === shipped;
  assert.equal(resolveHelperPath("", { repoRoot: "/App", resourcesPath: "/App/Resources", env, exists, packaged: true }), shipped);
  assert.equal(resolveHelperPath("", { repoRoot: "/App", resourcesPath: "/App/Resources", env, exists }), env.SCREENPLAY_SPEECH_HELPER);
  // Nor does a development build path win, inside the bundle or in the main checkout of a worktree.
  const worktree = "/Users/me/App/.claude/worktrees/w1/release/Cold Open.app/Contents";
  const lookup = { repoRoot: worktree, resourcesPath: `${worktree}/Resources`, packaged: true, exists: () => true };
  assert.equal(resolveHelperPath("", lookup), `${worktree}/Resources/speech-helper`);
  assert.equal(resolveHelperPath("", { ...lookup, exists: () => false }), `${worktree}/Resources/speech-helper`);
});
