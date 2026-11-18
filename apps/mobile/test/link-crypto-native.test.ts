// The iPhone's CryptoKit primitives against the Mac's node:crypto ones, without a phone: CryptoKit exists on macOS,
// so modules/link-crypto/ios/LinkCryptoCore.swift is compiled here with a small command-line harness. Every output
// must equal the Node provider's byte for byte, and each side must open what the other sealed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ReplayGuard, answerSealed, linkKeys, linkRoot, openResponse, sealRequest, type LinkCrypto,
} from "@screenplay/relay/sealed";
import { nodeLinkCrypto } from "@screenplay/relay/sealed-node";

const swiftc = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
const missing = process.platform !== "darwin" ? "CryptoKit needs macOS"
  : swiftc.status !== 0 ? "swiftc is not installed (install the Xcode command-line tools)" : false;

const harness = `import Foundation
func bytes(_ text: Substring) -> Data {
  var data = Data(), at = text.startIndex
  while at < text.endIndex { let next = text.index(at, offsetBy: 2); data.append(UInt8(text[at..<next], radix: 16)!); at = next }
  return data
}
func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
while let line = readLine() {
  let f = line.split(separator: " ", omittingEmptySubsequences: false)
  do {
    switch f[0] {
    case "hkdf": print(hex(try LinkCryptoCore.hkdf(ikm: bytes(f[1]), salt: bytes(f[2]), info: bytes(f[3]), length: Int(f[4])!)))
    case "seal": print(hex(try LinkCryptoCore.seal(key: bytes(f[1]), nonce: bytes(f[2]), aad: bytes(f[3]), plaintext: bytes(f[4]))))
    case "open": print(hex(try LinkCryptoCore.open(key: bytes(f[1]), nonce: bytes(f[2]), aad: bytes(f[3]), sealed: bytes(f[4]))))
    case "random": print(hex(try LinkCryptoCore.random(length: Int(f[1])!)))
    default: print("?")
    }
  } catch { print("!") }
}
`;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const range = (from: number, count: number) => Uint8Array.from({ length: count }, (_, i) => from + i);
const random = (length: number) => new Uint8Array(randomBytes(length));

test("CryptoKit and node:crypto agree byte for byte and open each other's messages", { skip: missing }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "coldopen-link-crypto-"));
  try {
    const main = join(temp, "main.swift"), executable = join(temp, "link-crypto");
    await writeFile(main, harness);
    execFileSync("xcrun", ["swiftc", "-O", "-o", executable,
      resolve(import.meta.dirname, "../modules/link-crypto/ios/LinkCryptoCore.swift"), main], { stdio: "pipe" });
    /** Runs a batch of harness lines; returns one output line each, "!" where Swift threw. */
    const swift = (lines: string[]) => {
      const out = execFileSync(executable, { input: lines.join("\n") + "\n", encoding: "utf8", maxBuffer: 64 << 20 }).split("\n");
      assert.equal(out.length, lines.length + 1);
      return out.slice(0, -1);
    };
    const swiftProvider: LinkCrypto = {
      hkdf: (ikm, salt, info, length) => unhex(swift([`hkdf ${hex(ikm)} ${hex(salt)} ${hex(info)} ${length}`])[0]!),
      seal: (key, nonce, aad, plain) => unhex(swift([`seal ${hex(key)} ${hex(nonce)} ${hex(aad)} ${hex(plain)}`])[0]!),
      open(key, nonce, aad, sealed) {
        const out = swift([`open ${hex(key)} ${hex(nonce)} ${hex(aad)} ${hex(sealed)}`])[0]!;
        if (out === "!") throw new Error("CryptoKit refused the message.");
        return unhex(out);
      },
      random: (length) => unhex(swift([`random ${length}`])[0]!),
    };

    // Published vectors: McGrew and Viega's GCM specification test case 16 (256-bit key, AAD), and RFC 5869 test
    // cases 1 and 3.
    const gcmKey = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
    const gcmPlain = "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39";
    const [gcm, rfc5869a, rfc5869c] = swift([
      `seal ${gcmKey} cafebabefacedbaddecaf888 feedfacedeadbeeffeedfacedeadbeefabaddad2 ${gcmPlain}`,
      `hkdf ${"0b".repeat(22)} ${hex(range(0, 13))} ${hex(range(0xf0, 10))} 42`,
      `hkdf ${"0b".repeat(22)}   42`,
    ]);
    assert.equal(gcm, "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662"
      + "76fc6ece0f4e1768cddf8853bb2d551b");
    assert.equal(rfc5869a, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    assert.equal(rfc5869c, "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8");

    // HKDF: the link's own derivations for a fixed secret, then random inputs of every shape the link uses.
    const fixed = linkKeys(nodeLinkCrypto, linkRoot(nodeLinkCrypto, "A".repeat(43)));
    const fixedSwift = linkKeys(swiftProvider, linkRoot(swiftProvider, "A".repeat(43)));
    for (const field of ["root", "kid", "request", "response"] as const) assert.deepEqual(fixedSwift[field], fixed[field], field);
    const hkdfCases = Array.from({ length: 40 }, (_, i) => ({ ikm: random(32), salt: random([0, 24, 48, 64][i % 4]!),
      info: random(i % 30), length: [16, 32, 42, 64][i % 4]! }));
    const hkdfOut = swift(hkdfCases.map(c => `hkdf ${hex(c.ikm)} ${hex(c.salt)} ${hex(c.info)} ${c.length}`));
    hkdfCases.forEach((c, i) => assert.equal(hkdfOut[i], hex(nodeLinkCrypto.hkdf(c.ikm, c.salt, c.info, c.length)), `hkdf ${i}`));

    // AES-256-GCM: sizes around block boundaries and a large body, zero and counter nonces, any AAD.
    const sizes = [0, 1, 15, 16, 17, 63, 64, 65, 127, 128, 1000, 24_000, 70_000];
    const sealCases = sizes.map((size, i) => ({ key: random(32), nonce: i % 2 ? new Uint8Array(12) : random(12),
      aad: random(i * 3 % 41), plain: random(size) }));
    const sealed = swift(sealCases.map(c => `seal ${hex(c.key)} ${hex(c.nonce)} ${hex(c.aad)} ${hex(c.plain)}`));
    const fromNode = sealCases.map(c => nodeLinkCrypto.seal(c.key, c.nonce, c.aad, c.plain));
    sealCases.forEach((c, i) => {
      assert.equal(sealed[i], hex(fromNode[i]!), `seal size ${sizes[i]}`);
      assert.deepEqual(nodeLinkCrypto.open(c.key, c.nonce, c.aad, unhex(sealed[i]!)), c.plain, `Node opens Swift's, size ${sizes[i]}`);
      const changed = unhex(sealed[i]!); changed[i * 7 % changed.length]! ^= 1;
      assert.throws(() => nodeLinkCrypto.open(c.key, c.nonce, c.aad, changed), `Node refuses a changed byte, size ${sizes[i]}`);
    });
    const opened = swift(sealCases.flatMap((c, i) => {
      const changed = fromNode[i]!.slice(); changed[changed.length - 1 - i % 16]! ^= 0x80;
      const otherAad = Uint8Array.of(...c.aad, 1);
      return [`open ${hex(c.key)} ${hex(c.nonce)} ${hex(c.aad)} ${hex(fromNode[i]!)}`,
        `open ${hex(c.key)} ${hex(c.nonce)} ${hex(c.aad)} ${hex(changed)}`,
        `open ${hex(c.key)} ${hex(c.nonce)} ${hex(otherAad)} ${hex(fromNode[i]!)}`];
    }));
    sealCases.forEach((c, i) => {
      assert.equal(opened[i * 3], hex(c.plain), `Swift opens Node's, size ${sizes[i]}`);
      assert.equal(opened[i * 3 + 1], "!", `Swift refuses a changed byte, size ${sizes[i]}`);
      assert.equal(opened[i * 3 + 2], "!", `Swift refuses other AAD, size ${sizes[i]}`);
    });
    assert.deepEqual(swift([`open ${"00".repeat(32)} ${"00".repeat(12)}  ${"00".repeat(15)}`, `seal ${"00".repeat(31)} ${"00".repeat(12)}  00`]),
      ["!", "!"], "a message shorter than a tag, and a short key");
    assert.deepEqual(swift([`seal ${"00".repeat(32)} ${"00".repeat(16)}  00`]), ["!"], "a nonce that is not 12 bytes");

    // Random bytes come from the system, the length asked for, and differ.
    const [a, b] = swift(["random 24", "random 24"]);
    assert.equal(a!.length, 48);
    assert.notEqual(a, b);

    // A whole sealed request made by the iPhone's primitives, answered by the Mac's, and the answer opened again.
    const token = randomBytes(32).toString("base64url");
    const phone = linkKeys(swiftProvider, linkRoot(swiftProvider, token)), mac = linkKeys(nodeLinkCrypto, linkRoot(nodeLinkCrypto, token));
    const guard = new ReplayGuard(nodeLinkCrypto), rid = swiftProvider.random(24);
    const body = sealRequest(phone, { t: Date.now(), e: guard.run, m: "POST", p: "/api/inbox", b: { text: "INT. LIGHTHOUSE - NIGHT" } }, rid);
    const answer = await answerSealed(mac, guard, body, async request => ({ status: 201, body: request.b }));
    assert.deepEqual(openResponse(phone, rid, answer).b, { text: "INT. LIGHTHOUSE - NIGHT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
