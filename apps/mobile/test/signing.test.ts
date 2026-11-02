import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { hmacSha256, signTake, type Sha256 } from "../src/signing.ts";

const hash: Sha256 = async bytes => new Uint8Array(createHash("sha256").update(bytes).digest());

test("phone HMAC matches Node for empty, block-sized, long-key and Unicode inputs", async () => {
  for (const [key, text] of [
    [new Uint8Array(), ""],
    [new Uint8Array(32).fill(0x0b), "Hi There"],
    [new Uint8Array(64).fill(0xff), "a".repeat(64)],
    [new Uint8Array(131).fill(0xaa), "字と🎬\nCafé\u0000".repeat(300)],
  ] as const) {
    const expected = createHmac("sha256", key).update(text).digest();
    assert.deepEqual(Buffer.from(await hmacSha256(key, text, hash)), expected);
  }
});

test("take signatures use the raw token digest and canonical UTF-8 fields", async () => {
  const token = "pairing-token", deviceId = "device-123456789", scriptId = "a".repeat(64);
  const item = { id: "receipt-123456789", kind: "draft", text: '字 🎬\n"Café"',
    paragraphId: "paragraph-1", sourceText: "A passage.\u0000" };
  const message = JSON.stringify(["inklot-take-v1", deviceId, scriptId, item.id,
    item.kind, item.text, item.paragraphId, item.sourceText]);
  const expected = createHmac("sha256", createHash("sha256").update(token).digest())
    .update(message).digest("base64url");
  assert.equal(await signTake(token, deviceId, scriptId, item, hash), expected);
  assert.equal(await signTake(token, deviceId, scriptId, item), expected);
});
