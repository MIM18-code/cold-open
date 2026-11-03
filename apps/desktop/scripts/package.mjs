// Builds the Mac app (.app and .dmg) into release/. Main, preload and renderer are bundled, so the staged app
// carries no node_modules: just dist/, the icon, and native speech and voice resources.
// Unsigned by default; set SCREENPLAY_SIGN=developer-id to sign with the keychain's Developer ID.
import { build, Platform } from "electron-builder";
import { stageParakeet } from "./parakeet-resources.mjs";
import { releasePolicy } from "./release-policy.mjs";
import { cpSync, existsSync, readdirSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "../..");
const stage = join(root, "release/.stage");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The stage has no node_modules, so electron-builder is told which Electron to package.
const electronVersion = JSON.parse(readFileSync(join(repo, "node_modules/electron/package.json"), "utf8")).version;

const policy = releasePolicy(process.env, {
  speech: existsSync(join(repo, "native/speech-helper/.build/release/speech-helper")),
  voice: existsSync(join(repo, "native/voice-helper/.build/release/voice-helper")),
});

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: "cold-open", productName: "Cold Open", version: manifest.version, description: manifest.description,
  license: manifest.license, author: "MindInMotion", type: "module", main: "dist/main/index.js",
}, null, 2));
for (const name of ["LICENSE", "COPYRIGHT", "THIRD_PARTY_NOTICES.md"]) if (existsSync(join(repo, name))) cpSync(join(repo, name), join(stage, name));
// Third-party notices for everything bundled (scripts/prepare-licenses.mjs). A release build must carry them.
const licenses = join(repo, "release/licenses-stage/licenses");
if (existsSync(licenses)) cpSync(licenses, join(stage, "licenses"), { recursive: true });
else if (policy.release) throw new Error("Run node scripts/prepare-licenses.mjs before a release build.");

// Helpers ship without debug symbols: their symbol tables name local build paths, and the app has no use for them.
const strip = (file) => execFileSync("/usr/bin/strip", ["-S", "-x", file]);
const builtHelper = join(repo, "native/speech-helper/.build/release/speech-helper");
const helper = join(stage, "speech-helper");
cpSync(builtHelper, helper); strip(helper);
const parakeet = join(stage, "parakeet-tdt-0.6b-v3");
await stageParakeet(parakeet);
const extraResources = [{ from: helper, to: "speech-helper" }, { from: parakeet, to: "parakeet-tdt-0.6b-v3" }];

const voiceBuild = join(repo, "native/voice-helper/.build/release");
const voiceStage = join(stage, "voice-resources"); mkdirSync(voiceStage, { recursive: true });
for (const name of readdirSync(voiceBuild)) if (name === "voice-helper" || /\.(bundle|metallib|dylib)$/.test(name)) cpSync(join(voiceBuild, name), join(voiceStage, name), { recursive: true });
for (const name of readdirSync(voiceStage)) if (name === "voice-helper" || name.endsWith(".dylib")) strip(join(voiceStage, name));
// MLX loads its Metal library from this bundle. Without it every engine, including Phonon and Kokoro, dies at load.
if (!existsSync(join(voiceStage, "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib"))) {
  throw new Error("Voice helper is missing mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib. Rebuild it with `swift build -c release` (not --build-system native) in native/voice-helper.");
}
extraResources.push({ from: voiceStage, to: "voice-helper" });

const document = (ext, name, role = "Editor", rank = "Default") => ({ ext, name, role, rank, icon: join(root, "build/icon.icns") });

await build({
  targets: Platform.MAC.createTarget(["dmg", "dir"]),
  projectDir: stage,
  publish: "never",
  config: {
    // Unchanged on purpose: the bundle identifier ties the app to its macOS keychain items, permissions and signing.
    appId: "tv.mindinmotion.inklot",
    forceCodeSigning: policy.release,
    electronVersion,
    productName: "Cold Open",
    // No spaces: the DMG name ends up in download URLs and the Homebrew cask.
    artifactName: "ColdOpen-${version}.${ext}",
    directories: { output: join(root, "release"), buildResources: join(root, "build") },
    files: ["dist/**", "package.json", "LICENSE", "COPYRIGHT", "THIRD_PARTY_NOTICES.md", "licenses/**"],
    extraResources,
    asar: true,
    npmRebuild: false,
    mac: {
      category: "public.app-category.productivity",
      // The bundled speech helper needs macOS 14; the voice helper checks for 15 itself.
      minimumSystemVersion: "14.0",
      icon: join(root, "build/icon.icns"),
      target: ["dmg", "dir"],
      identity: policy.signed ? undefined : null,
      hardenedRuntime: policy.signed,
      notarize: policy.release,
      entitlements: join(root, "build/entitlements.mac.plist"),
      entitlementsInherit: join(root, "build/entitlements.inherit.plist"),
      extendInfo: {
        NSMicrophoneUsageDescription: "Cold Open uses the microphone when you dictate scenes.",
        NSLocalNetworkUsageDescription: "Cold Open connects to co-writers or a paired phone only when you start sharing.",
      },
    },
    protocols: [{ name: "Cold Open co-writing invite", schemes: ["screenplay"] }],
    fileAssociations: [
      document("screenplay", "Screenplay", "Editor", "Owner"),
      document("fdx", "Final Draft Document", "Editor", "Alternate"),
      document("fountain", "Fountain Screenplay", "Editor", "Alternate"),
      document("coldopentakes", "Cold Open Takes", "Viewer", "Alternate"),
      // Takes files an iPhone made before the rename still open in Finder.
      document("inklottakes", "Cold Open Takes", "Viewer", "Alternate"),
    ],
  },
});
// electron-builder signs and notarizes the app (stapled before it goes into the DMG, so it opens offline after a
// copy) but not the DMG. A release signs, notarizes and staples the DMG too, so Gatekeeper accepts the download itself.
if (policy.release) {
  const dmg = join(root, "release", `ColdOpen-${manifest.version}.dmg`);
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
    .split("\n").map((line) => /"(Developer ID Application: [^"]+)"/.exec(line)?.[1]).filter(Boolean);
  const identity = process.env.SCREENPLAY_SIGN_IDENTITY ?? (identities.length === 1 ? identities[0] : undefined);
  if (!identity) throw new Error("Set SCREENPLAY_SIGN_IDENTITY to one Developer ID Application identity.");
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) throw new Error("Notarizing the DMG needs APPLE_KEYCHAIN_PROFILE.");
  execFileSync("codesign", ["--force", "--sign", identity, "--timestamp", dmg], { stdio: "inherit" });
  const submitted = JSON.parse(execFileSync("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--output-format", "json"], { encoding: "utf8" }));
  console.log(`Notarizing the DMG (submission ${submitted.id}).`);
  // Poll rather than hold one --wait connection, so sleep or a dropped network only pauses the wait.
  let status;
  for (;;) {
    try { status = JSON.parse(execFileSync("xcrun", ["notarytool", "info", submitted.id, "--keychain-profile", profile, "--output-format", "json"], { encoding: "utf8" })).status; }
    catch { status = undefined; }
    if (status && status !== "In Progress") break;
    execFileSync("/bin/sleep", ["30"]);
  }
  if (status !== "Accepted") {
    const log = execFileSync("xcrun", ["notarytool", "log", submitted.id, "--keychain-profile", profile], { encoding: "utf8" });
    throw new Error(`DMG notarization ${status}:\n${log}`);
  }
  execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
}
console.log(`Built into ${join(root, "release")}`);
