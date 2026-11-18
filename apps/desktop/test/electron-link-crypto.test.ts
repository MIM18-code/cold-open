// The sealed link's Node provider inside Electron's own runtime. Electron ships BoringSSL, not OpenSSL, and lacks
// ciphers plain Node has (ChaCha20-Poly1305 among them), so the unit tests under plain Node cannot prove the Mac
// app can seal. This runs packages/relay/src/sealed-node.ts in the Electron binary and compares with plain Node.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { nodeLinkCrypto } from "@screenplay/relay/sealed-node";

const electron = (() => {
  try { return createRequire(import.meta.url)("electron") as unknown as string; } catch { return ""; }
})();
const missing = typeof electron === "string" && electron && existsSync(electron) ? false
  : "The Electron binary is not installed (run npm install in the repository).";

const provider = pathToFileURL(resolve(import.meta.dirname, "../../../packages/relay/src/sealed-node.ts")).href;
const script = `
const { nodeLinkCrypto: c } = await import(${JSON.stringify(provider)});
const input = JSON.parse(process.argv.at(-1)), h = s => new Uint8Array(Buffer.from(s, "hex")), x = b => Buffer.from(b).toString("hex");
const sealed = c.seal(h(input.key), h(input.nonce), h(input.aad), h(input.plain));
const tampered = sealed.slice(); tampered[3] ^= 1;
let refused = false;
try { c.open(h(input.key), h(input.nonce), h(input.aad), tampered); } catch { refused = true; }
console.log(JSON.stringify({
  electron: process.versions.electron,
  hkdf: x(c.hkdf(h(input.ikm), h(input.salt), new TextEncoder().encode("ws phone to mac"), 32)),
  sealed: x(sealed),
  opened: x(c.open(h(input.key), h(input.nonce), h(input.aad), sealed)),
  refused,
  random: c.random(24).length,
}));
`;

test("the Node provider seals, opens and refuses tampering inside Electron, matching plain Node", { skip: missing }, () => {
  const hex = (length: number) => randomBytes(length).toString("hex");
  const input = { ikm: hex(32), salt: hex(64), key: hex(32), nonce: hex(12), aad: hex(40), plain: hex(1000) };
  const run = spawnSync(electron, ["--input-type=module", "-e", script, JSON.stringify(input)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  assert.ok(out.electron, "this ran in Electron");
  const h = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
  const sealed = nodeLinkCrypto.seal(h(input.key), h(input.nonce), h(input.aad), h(input.plain));
  assert.equal(out.hkdf, Buffer.from(nodeLinkCrypto.hkdf(h(input.ikm), h(input.salt), Buffer.from("ws phone to mac"), 32)).toString("hex"));
  assert.equal(out.sealed, Buffer.from(sealed).toString("hex"));
  assert.equal(out.opened, input.plain);
  assert.equal(out.refused, true);
  assert.equal(out.random, 24);
});
