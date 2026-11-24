import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SpeechHelper } from "../src/speech.ts";

test("a missing helper binary rejects the call instead of crashing", async () => {
  const helper = new SpeechHelper("/nonexistent/speech-helper");
  await assert.rejects(helper.engine("parakeet").prepare(), /could not start/);
});

test("closing a helper whose binary is missing settles, so quitting does not wait forever", { timeout: 10_000 }, async () => {
  const helper = new SpeechHelper("/nonexistent/speech-helper");
  const waiting = helper.engine("parakeet").prepare();
  await helper.close();
  await assert.rejects(waiting, /closed|could not start/);
});

/** A stand-in for the native helper: a Node script run as `<binary> serve`. */
function fakeHelper(body: string): string {
  const folder = mkdtempSync(join(tmpdir(), "speech-helper-test-"));
  const file = join(folder, "speech-helper");
  writeFileSync(file, `#!${process.execPath}\nif (process.argv[2] !== "serve") process.exit(0);\n${body}\n`);
  chmodSync(file, 0o755);
  // macOS checks a new executable on its first launch, one file at a time across the system: about 250 ms alone and
  // seconds when many tests start helpers at once, longer than a test's short call timeout. Launch it once here.
  spawnSync(file, ["warm-up"]);
  return file;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check() && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a helper that writes a lot of diagnostics still answers", { timeout: 10_000 }, async () => {
  const helper = new SpeechHelper(fakeHelper(`
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const { id } = JSON.parse(line);
      process.stderr.write("x".repeat(1024 * 1024), () => process.stdout.write(JSON.stringify({ id, ok: true }) + "\\n"));
    });`));
  try {
    await helper.engine("parakeet").prepare();
  } finally {
    helper.close();
  }
});

test("a helper that stops answering is killed and the call fails", { timeout: 10_000 }, async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "speech-helper-pid-")), "pid");
  const helper = new SpeechHelper(fakeHelper(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`), { timeoutMs: 300 });
  await assert.rejects(helper.engine("parakeet").transcribe("/tmp/take.wav"), /did not answer/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});

test("closing rejects a waiting call and kills a helper that does not exit", { timeout: 10_000 }, async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "speech-helper-pid-")), "pid");
  // Ignores the end of its input, as a hung helper would.
  const helper = new SpeechHelper(fakeHelper(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.on("end", () => {}); setInterval(() => {}, 1000);`), { closeMs: 200 });
  const waiting = helper.engine("parakeet").prepare();
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  let closed = false;
  const closing = helper.close().then(() => { closed = true; });
  await assert.rejects(waiting, /closed/);
  // Still inside the grace period: the helper is running, so close() has not settled.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), true);
  assert.equal(closed, false);
  await closing;
  assert.equal(alive(pid), false);
});
