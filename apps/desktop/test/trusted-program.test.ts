// A signed release runs a program only if codesign confirms the expected signature.
// codesign is replaced by a fake that knows which files meet which requirement; the files themselves are real, so
// symlink resolution and the stat-keyed cache run as they do in the app.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { SETTING_KEYS } from "../src/shared/channels/dictation.ts";
import { chosenHelperProblem, UNSIGNED_CHOICE, UNSIGNED_HELPER } from "../src/main/dictation/config.ts";
import { helperMissingMessage } from "../src/main/dictation/errors.ts";
import { DictationRuntime } from "../src/main/dictation/runtime.ts";
import { pickRuntime, trustedOllama } from "../src/main/models/local-runtime.ts";
import {
  appStoreRequirement, cachedTrust, configurePackagedApp, developerIdRequirement, type Exec, OLLAMA_SIGNER, OWN_SIGNER, ownTeam,
  parseTeam, type Signer, TAILSCALE_SIGNER, teamRequirement, trustedProgram,
} from "../src/main/trusted-program.ts";

const APP_TEAM = "ABCDE12345";
const meets = (signer: Signer) => signer(APP_TEAM);

afterEach(() => configurePackagedApp(null));

function program(folder: string, name: string, marker?: string): string {
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\n${marker ? `touch "${marker}"\n` : ""}echo '{"engines":[]}'\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A sealed app whose fake codesign says each file in `signed` meets that requirement and no other. */
const PID = 4242;

function seal(signed: Record<string, string>, team: string | null = APP_TEAM, describe?: Exec) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    assert.equal(file, "/usr/bin/codesign");
    if (args[0] === "-dv") {
      assert.deepEqual(args, ["-dv", "--verbose=2", String(PID)], "the running process is read, not a path");
      return describe ? describe(file, args) : { code: 0, output: `Executable=/Applications/Cold Open.app/Contents/MacOS/Cold Open\nTeamIdentifier=${team ?? "not set"}\n` };
    }
    const wanted = signed[args.at(-1)!];
    return { code: wanted && args.includes(`-R=${wanted}`) ? 0 : 3, output: "" };
  };
  configurePackagedApp({ team: ownTeam(PID, exec), exec });
  return calls;
}

const verifies = (calls: string[][]) => calls.filter((c) => c[1] === "--verify").map((c) => c.at(-1));

test("parseTeam reads codesign's TeamIdentifier and the requirements name the right certificates", () => {
  assert.equal(parseTeam("Identifier=x\nTeamIdentifier=3MU9H2V9Y9\nSealed Resources version=2"), "3MU9H2V9Y9");
  assert.equal(parseTeam("Signature=adhoc\nTeamIdentifier=not set\n"), null);
  assert.equal(parseTeam("code object is not signed at all"), null);
  assert.equal(teamRequirement("W5364U7YZB"), 'anchor apple generic and certificate leaf[subject.OU] = "W5364U7YZB"');
  assert.throws(() => teamRequirement('X" or true'), /team identifier/);
  // Third parties need a Developer ID certificate; the app's own team accepts any of its certificates.
  assert.match(OLLAMA_SIGNER(APP_TEAM), /"3MU9H2V9Y9" and certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] exists and certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists$/);
  assert.equal(OWN_SIGNER(APP_TEAM), teamRequirement(APP_TEAM));
  assert.equal(TAILSCALE_SIGNER(APP_TEAM), `(${developerIdRequirement("W5364U7YZB")}) or (${appStoreRequirement("io.tailscale.ipn.macos")})`);
  assert.throws(() => appStoreRequirement('a" or true'), /bundle identifier/);
});

test("an unsealed build runs every program as given: development, tests and the ad hoc package", async () => {
  assert.equal(await trustedProgram("/opt/homebrew/bin/ollama", OLLAMA_SIGNER), "/opt/homebrew/bin/ollama");
  const calls = seal({}, null);
  assert.equal(await trustedProgram("/opt/homebrew/bin/ollama", OLLAMA_SIGNER), "/opt/homebrew/bin/ollama");
  assert.deepEqual(verifies(calls), []);
  // An unsigned process is unsealed too, but only on codesign's exact line for this pid.
  seal({}, null, async () => ({ code: 1, output: `${PID}: code object is not signed at all\n` }));
  assert.equal(await trustedProgram("/opt/homebrew/bin/ollama", OLLAMA_SIGNER), "/opt/homebrew/bin/ollama");
});

test("a sealed build runs a program only with the expected signature, wherever it is", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-")));
  // A folder at the bundle's old path after the running app was moved: its programs get no pass.
  mkdirSync(join(folder, "Cold Open.app/Contents/Resources"), { recursive: true });
  const inBundle = program(join(folder, "Cold Open.app/Contents/Resources"), "evil");
  const ollama = program(folder, "ollama"), planted = program(folder, "planted"), mine = program(folder, "mine");
  const calls = seal({ [ollama]: meets(OLLAMA_SIGNER), [mine]: meets(OWN_SIGNER) });
  assert.equal(await trustedProgram(inBundle, OWN_SIGNER), null);
  assert.deepEqual(verifies(calls), [inBundle]);
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), ollama);
  assert.equal(await trustedProgram(planted, OLLAMA_SIGNER), null);
  assert.equal(await trustedProgram(ollama, OWN_SIGNER), null, "signed, but by another team than the app's");
  assert.equal(await trustedProgram(mine, OWN_SIGNER), mine, "the app's own team, read from its signature");
  assert.equal(await trustedProgram(join(folder, "missing"), OLLAMA_SIGNER), null);
  assert.equal(calls.filter((c) => c[1] === "-dv").length, 1, "the app's own team is read once");
  // System folders get no pass: codesign decides, and an unsigned file there is refused.
  assert.equal(await trustedProgram("/bin/sh", OLLAMA_SIGNER), null);
});

// /System/Volumes/Data is the Mac's data volume; the path does not exist elsewhere.
test("a path on the data volume under /System, or a symlink to one, still needs a signature", { skip: process.platform !== "darwin" }, async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-data-")));
  const evil = program(folder, "evil"), viaData = `/System/Volumes/Data${evil}`;
  assert.equal(realpathSync(viaData), viaData, "realpath keeps the /System prefix");
  const link = join(folder, "ollama");
  symlinkSync(viaData, link);
  const calls = seal({});
  assert.equal(await trustedProgram(viaData, OWN_SIGNER), null);
  assert.equal(await trustedProgram(link, OLLAMA_SIGNER), null);
  assert.deepEqual(verifies(calls), [viaData, viaData]);
});

test("when codesign can't read the app's own signature, programs are refused and it asks again", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-unknown-")));
  const ollama = program(folder, "ollama");
  let answer = { code: -1, output: "" }; // spawn error, timeout or kill
  const calls = seal({ [ollama]: meets(OLLAMA_SIGNER) }, APP_TEAM, async () => answer);
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), null);
  answer = { code: 0, output: "Executable=x\n" }; // no TeamIdentifier line at all
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), null);
  // The "not signed" text inside some other line, as a launch folder's name would put it, is not the pid's own line.
  answer = { code: 1, output: "/tmp/code object is not signed at all/Cold Open.app: code object is not signed at all\n" };
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), null);
  answer = { code: 1, output: `${PID}: code object is not signed at all (and more)\n` };
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), null);
  // A launch folder whose name holds a line break adds a team line of its own ahead of the real one.
  answer = { code: 0, output: `Executable=/tmp/nl\nTeamIdentifier=ZZZZZZZZZZ\nx/Cold Open\nTeamIdentifier=${APP_TEAM}\n` };
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), null);
  answer = { code: 0, output: `Executable=/tmp/nl\nTeamIdentifier=not set\nx/Cold Open\nTeamIdentifier=${APP_TEAM}\n` };
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), null);
  answer = { code: 0, output: `TeamIdentifier=${APP_TEAM}\n` };
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), ollama, "the failure was not kept");
  assert.equal(calls.filter((c) => c[1] === "-dv").length, 7);
  assert.equal(await trustedProgram(ollama, OLLAMA_SIGNER), ollama);
  assert.equal(calls.filter((c) => c[1] === "-dv").length, 7, "a real answer is kept");
});

test("a sealed build checks and runs the file a symlink points to", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-link-")));
  const target = program(folder, "Tailscale"), link = join(folder, "tailscale-link");
  symlinkSync(target, link);
  const calls = seal({ [target]: meets(TAILSCALE_SIGNER) });
  assert.equal(await trustedProgram(link, TAILSCALE_SIGNER), target);
  assert.deepEqual(verifies(calls), [target]);
});

test("the cached check runs codesign again only when the file changes", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-cache-")));
  const cli = program(folder, "tailscale");
  const calls = seal({ [cli]: meets(TAILSCALE_SIGNER) });
  const trust = cachedTrust(TAILSCALE_SIGNER);
  assert.equal(await trust(cli), cli);
  assert.equal(await trust(cli), cli);
  assert.equal(verifies(calls).length, 1);
  writeFileSync(cli, "#!/bin/sh\necho replaced\n");
  assert.equal(await trust(cli), cli);
  assert.equal(verifies(calls).length, 2);
});

test("a granted speech helper without the app's signature is not run by check, prepare or a take", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-helper-")));
  const marker = join(folder, "ran");
  const chosen = program(folder, "speech-helper", marker);
  const settings = () => ({ [SETTING_KEYS.helperPath]: chosen, "dictation.endpoint": "http://127.0.0.1:9" });
  const runtime = new DictationRuntime({ settings, lookup: { repoRoot: folder } });
  seal({});
  const { helper } = await runtime.check();
  assert.equal(helper.ok, false);
  assert.equal(helper.message, UNSIGNED_HELPER);
  await assert.rejects(runtime.prepare(), { message: UNSIGNED_HELPER });
  await assert.rejects(runtime.processAudio({ audio: new Uint8Array(0) } as never, () => {}), { message: UNSIGNED_HELPER });
  assert.equal(existsSync(marker), false, "the unsigned helper ran");
  assert.equal(await chosenHelperProblem(chosen), UNSIGNED_CHOICE);

  // Signed by the app's own team: it runs, at its resolved path.
  seal({ [chosen]: meets(OWN_SIGNER) });
  const signed = await runtime.check();
  assert.equal(signed.helper.ok, true, signed.helper.message);
  assert.equal(existsSync(marker), true);
  assert.equal(await chosenHelperProblem(chosen), null);
  await runtime.close();
});

test("a sealed build refuses a granted speech helper that is missing, so a file that appears later is not run", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-missing-")));
  const chosen = join(folder, "speech-helper");
  const settings = () => ({ [SETTING_KEYS.helperPath]: chosen, "dictation.endpoint": "http://127.0.0.1:9" });
  const runtime = new DictationRuntime({ settings, lookup: { repoRoot: folder } });
  seal({});
  const { helper } = await runtime.check();
  assert.equal(helper.ok, false);
  assert.equal(helper.message, helperMissingMessage(chosen));
  await assert.rejects(runtime.prepare(), { message: helperMissingMessage(chosen) });
  await assert.rejects(runtime.processAudio({ audio: new Uint8Array(0) } as never, () => {}), { message: helperMissingMessage(chosen) });
  await runtime.close();
});

test("Ollama candidates without Ollama's signature are skipped, and so is a binary beside an unsigned runner", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "trusted-ollama-")));
  for (const name of ["own", "app", "brew"]) mkdirSync(join(folder, name));
  const own = program(join(folder, "own"), "ollama"), app = program(join(folder, "app"), "ollama");
  const brew = program(join(folder, "brew"), "ollama");
  const runner = program(join(folder, "app"), "llama-server");
  const signed = { [app]: meets(OLLAMA_SIGNER), [runner]: meets(OLLAMA_SIGNER) };
  seal(signed);
  assert.equal(await pickRuntime([own, join(folder, "missing"), app, brew]), app);
  assert.equal(await trustedOllama(own), null, "the app's own download must pass too");
  assert.equal(await pickRuntime([own, brew]), undefined);
  seal({ [app]: meets(OLLAMA_SIGNER) });
  assert.equal(await pickRuntime([app]), undefined, "llama-server beside it is not Ollama's");
  configurePackagedApp(null);
  assert.equal(await pickRuntime([join(folder, "missing"), own, app]), own, "unsealed builds keep the first one found");
});
