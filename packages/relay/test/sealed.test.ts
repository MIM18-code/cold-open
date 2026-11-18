// The sealed link's framing: key derivation, HTTP envelopes, replay and wrong-key rejection, and the WebSocket
// tunnel, checked against Node's own HKDF and OpenSSL's ChaCha20 so the pure-JS cipher is not its own witness.
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { test } from "node:test";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import {
  FRAME_DATA, LINK_VERSION, LinkClient, LinkError, ReplayGuard, Tunnel, answerSealed, fromBase64url, linkKeys,
  linkRoot, openRequest, openResponse, requestId, sealRequest, sealResponse, toBase64url,
} from "../src/sealed.ts";

const secret = () => randomBytes(32).toString("base64url");
const nonce = () => new Uint8Array(randomBytes(24));
const utf8 = (text: string) => new Uint8Array(Buffer.from(text));
const kind = (expected: LinkError["kind"]) => (error: unknown) => error instanceof LinkError && error.kind === expected;

/** XChaCha20-Poly1305 built from OpenSSL: HChaCha20 from a ChaCha20 keystream block, then RFC 8439 AEAD. */
function opensslXChaCha(key: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, plain: Uint8Array): Uint8Array {
  // A ChaCha20 block is the rounds' output plus the input state. HChaCha20 is the rounds' output alone, words 0-3
  // and 12-15, so subtract the constants and the counter-and-nonce words from the first keystream block.
  const block = createCipheriv("chacha20", key, nonce24.subarray(0, 16)).update(Buffer.alloc(64));
  const constants = Buffer.from("expand 32-byte k");
  const subkey = Buffer.alloc(32);
  for (let word = 0; word < 4; word++) {
    subkey.writeUInt32LE((block.readUInt32LE(word * 4) - constants.readUInt32LE(word * 4)) >>> 0, word * 4);
    subkey.writeUInt32LE((block.readUInt32LE(48 + word * 4) - Buffer.from(nonce24).readUInt32LE(word * 4)) >>> 0, 16 + word * 4);
  }
  const cipher = createCipheriv("chacha20-poly1305", subkey, Buffer.concat([Buffer.alloc(4), nonce24.subarray(16)]), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plain.length });
  return new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]));
}

test("the pure-JS cipher matches OpenSSL", () => {
  for (const size of [0, 1, 63, 64, 65, 1000, 70_000]) {
    const key = new Uint8Array(randomBytes(32)), n = nonce(), aad = new Uint8Array(randomBytes(size % 40)), plain = new Uint8Array(randomBytes(size));
    assert.deepEqual(xchacha20poly1305(key, n, aad).encrypt(plain), opensslXChaCha(key, n, aad, plain), `size ${size}`);
  }
});

test("keys are HKDF-SHA256 of the pairing secret, as documented", () => {
  const token = secret(), keys = linkKeys(linkRoot(token));
  // Node's HKDF does RFC 5869 extract and expand in one call, from the 32 secret bytes.
  const derive = (label: string, length: number) =>
    new Uint8Array(hkdfSync("sha256", Buffer.from(token, "base64url"), "coldopen-phone-link-v2", label, length));
  assert.deepEqual(keys.kid, derive("kid", 16));
  assert.deepEqual(keys.request, derive("http phone to mac", 32));
  assert.deepEqual(keys.response, derive("http mac to phone", 32));
  assert.equal(keys.id, Buffer.from(keys.kid).toString("base64url"));
  assert.equal(keys.id.length, 22);
  assert.notDeepEqual(keys.request, keys.response);
  assert.throws(() => linkRoot("short"), kind("malformed"));
  assert.throws(() => linkRoot("!".repeat(43)), kind("malformed"));
});

test("base64url round-trips every length and refuses other alphabets", () => {
  for (let length = 0; length < 70; length++) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.equal(toBase64url(bytes), Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(fromBase64url(toBase64url(bytes)), bytes);
  }
  for (const bad of ["a", "ab+d", "ab/d", "ab=d", "abcé"]) assert.throws(() => fromBase64url(bad), kind("malformed"));
});

test("a request opens only with its own key and unchanged", () => {
  const keys = linkKeys(linkRoot(secret())), other = linkKeys(linkRoot(secret()));
  const request = { t: 1_700_000_000_000, m: "POST" as const, p: "/api/inbox", b: { text: "INT. KITCHEN - DAY" } };
  const n = nonce(), body = sealRequest(keys, request, n);
  assert.deepEqual(openRequest(keys, body), { request, nonce: n });
  assert.equal(requestId(body), keys.id);
  assert.ok(!Buffer.from(body, "base64url").includes("KITCHEN"), "the body is not readable");

  // Another pairing's key: the ID does not match, and with the ID forced the tag does not.
  assert.throws(() => openRequest(other, body), kind("unknown"));
  const bytes = Buffer.from(body, "base64url");
  const renamed = Buffer.from(bytes); renamed.set(other.kid, 1);
  assert.throws(() => openRequest(other, renamed.toString("base64url")), kind("forged"));
  assert.throws(() => openRequest(keys, renamed.toString("base64url")), kind("unknown"));

  // Any changed byte of the nonce, the ciphertext or the tag is refused.
  for (const at of [17, 30, 41, 45, bytes.length - 1]) {
    const changed = Buffer.from(bytes); changed[at]! ^= 1;
    assert.throws(() => openRequest(keys, changed.toString("base64url")), kind("forged"), `byte ${at}`);
  }
  const version = Buffer.from(bytes); version[0] = LINK_VERSION + 1;
  assert.throws(() => openRequest(keys, version.toString("base64url")), kind("malformed"));
  assert.throws(() => openRequest(keys, bytes.subarray(0, 40).toString("base64url")), kind("malformed"));
  assert.equal(requestId("Bearer abc"), null);
  assert.equal(requestId(""), null);
});

test("a response answers only the request it was made for", () => {
  const keys = linkKeys(linkRoot(secret())), other = linkKeys(linkRoot(secret()));
  const asked = nonce(), reply = { s: 200, b: { open: true }, now: 5 };
  const body = sealResponse(keys, asked, reply, nonce());
  assert.deepEqual(openResponse(keys, asked, body), reply);
  assert.throws(() => openResponse(keys, nonce(), body), kind("forged"), "an old response replayed to a new request");
  assert.throws(() => openResponse(other, asked, body), kind("forged"));
  const changed = Buffer.from(body, "base64url"); changed[changed.length - 20]! ^= 0x80;
  assert.throws(() => openResponse(keys, asked, changed.toString("base64url")), kind("forged"));
  assert.throws(() => openResponse(keys, asked, '{"error":"Pairing refused."}'), kind("malformed"));
});

test("the two directions use different keys", () => {
  const keys = linkKeys(linkRoot(secret())), n = nonce();
  // A request reflected back as a response, and a response sent up as a request, both fail.
  const request = Buffer.from(sealRequest(keys, { t: 1, m: "GET", p: "/api/device" }, n), "base64url");
  assert.throws(() => openResponse(keys, n, request.subarray(17).toString("base64url")), kind("forged"));
  const response = Buffer.from(sealResponse(keys, n, { s: 200, b: null, now: 1 }, n), "base64url");
  const reflected = Buffer.concat([Buffer.from([LINK_VERSION]), keys.kid, response]);
  assert.throws(() => openRequest(keys, reflected.toString("base64url")), kind("forged"));
});

test("a captured request is refused when it is sent again", async () => {
  const keys = linkKeys(linkRoot(secret()));
  let now = 1_000_000, handled = 0;
  const guard = new ReplayGuard(), clock = () => now;
  const handle = async () => { handled++; return { status: 200, body: { id: "saved" } }; };
  const n = nonce(), body = sealRequest(keys, { t: now, e: guard.run, m: "POST", p: "/api/inbox", b: { id: "take" } }, n);
  assert.deepEqual(openResponse(keys, n, await answerSealed(keys, guard, body, handle, undefined, clock)).b, { id: "saved" });
  await assert.rejects(answerSealed(keys, guard, body, handle, undefined, clock), kind("replayed"));
  now += 60_000;
  await assert.rejects(answerSealed(keys, guard, body, handle, undefined, clock), kind("replayed"));
  // Past the window the nonce is forgotten, and the request is stale instead: answered 425, never run.
  now += 120_000;
  assert.equal(openResponse(keys, n, await answerSealed(keys, guard, body, handle, undefined, clock)).s, 425);
  assert.equal(handled, 1);
});

test("a request recorded before the Mac restarted is never run after it, whatever its timestamp", async () => {
  const keys = linkKeys(linkRoot(secret()));
  let handled = 0;
  const handle = async () => { handled++; return { status: 200, body: null }; };
  // The iPhone's clock runs a minute ahead of the Mac's: inside the window, so nothing corrects it.
  const before = new ReplayGuard(), n = nonce();
  const body = sealRequest(keys, { t: 1_060_000, e: before.run, m: "POST", p: "/api/device", b: { name: "Old name" } }, n);
  assert.equal(openResponse(keys, n, await answerSealed(keys, before, body, handle, undefined, () => 1_000_000)).s, 200);
  assert.equal(handled, 1);

  // The Mac restarts ten seconds later with no memory of that nonce. The recorded request's time still looks
  // current, and it is sealed with the right key, but it names the earlier run.
  const after = new ReplayGuard();
  assert.notEqual(after.run, before.run);
  const reply = openResponse(keys, n, await answerSealed(keys, after, body, handle, undefined, () => 1_010_000));
  assert.equal(reply.s, 425);
  assert.equal(handled, 1, "the replay was not run");

  // A request that names no run at all is never run either, on any guard.
  const blank = nonce(), unnamed = sealRequest(keys, { t: 1_010_000, m: "POST", p: "/api/device", b: { name: "x" } }, blank);
  assert.equal(openResponse(keys, blank, await answerSealed(keys, after, unnamed, handle, undefined, () => 1_010_000)).s, 425);
  assert.equal(handled, 1);

  // The real iPhone learns the new run from that sealed answer and carries on after one retry.
  const posts: string[] = [];
  const client = new LinkClient(keys, async (sealed) => { posts.push(sealed); return answerSealed(keys, before, sealed, handle, undefined, () => 1_000_000); },
    undefined, () => 1_060_000);
  assert.equal((await client.call("GET", "/api/device")).status, 200);
  const restarted = new LinkClient(keys, async (sealed) => answerSealed(keys, after, sealed, handle, undefined, () => 1_010_000), undefined, () => 1_070_000);
  assert.equal((await restarted.call("GET", "/api/device")).status, 200);
  assert.equal(handled, 3);
  // Everything the first client sent, replayed to the restarted Mac, runs nothing.
  for (const sealed of posts) {
    const sentNonce = openRequest(keys, sealed).nonce;
    assert.equal(openResponse(keys, sentNonce, await answerSealed(keys, after, sealed, handle, undefined, () => 1_010_000)).s, 425);
  }
  assert.equal(handled, 3);
});

test("the replay guard bounds its memory", () => {
  const guard = new ReplayGuard(1000, 3), run = guard.run;
  assert.equal(guard.admit(run, 10, nonce(), 10), "fresh");
  assert.equal(guard.admit(run, 11, nonce(), 11), "fresh");
  assert.equal(guard.admit(run, 12, nonce(), 12), "fresh");
  assert.equal(guard.admit(run, 13, nonce(), 13), "busy");
  assert.equal(guard.admit(run, 1500, nonce(), 1500), "fresh", "expired nonces make room");
  assert.equal(guard.admit(run, Number.NaN, nonce(), 1500), "stale");
  assert.equal(guard.admit(run, 1500 + 1001, nonce(), 1500), "stale", "a time from the future");
  assert.equal(guard.admit(undefined, 1500, nonce(), 1500), "stale", "no run named");
  assert.equal(guard.admit(new ReplayGuard().run, 1500, nonce(), 1500), "stale", "another run");
  assert.equal(run.length, 22);
});

test("the phone follows the Mac's run and clock and never sends the same body twice", async () => {
  const keys = linkKeys(linkRoot(secret()));
  const mac = () => 9_000_000, phone = () => 1_000_000; // The phone's clock is hours behind.
  const guard = new ReplayGuard(), bodies: string[] = [];
  const paths: string[] = [];
  const client = new LinkClient(keys, async (body) => {
    bodies.push(body);
    return answerSealed(keys, guard, body, async (request) => { paths.push(request.p); return { status: 200, body: { open: true } }; }, undefined, mac);
  }, undefined, phone);
  assert.deepEqual(await client.call("GET", "/api/device"), { status: 200, body: { open: true } });
  assert.equal(bodies.length, 2, "one refused, one retried with the Mac's run and time");
  assert.deepEqual(await client.call("POST", "/api/inbox", { id: "x" }), { status: 200, body: { open: true } });
  assert.equal(bodies.length, 3, "both are remembered");
  assert.deepEqual(paths, ["/api/device", "/api/inbox"]);
  assert.equal(new Set(bodies).size, 3);

  // An answer in the clear, or sealed by someone else, is not believed.
  const refused = new LinkClient(keys, async () => JSON.stringify({ error: "This Mac revoked the pairing" }));
  await assert.rejects(refused.call("GET", "/api/device"), kind("malformed"));
  const stranger = linkKeys(linkRoot(secret()));
  const forged = new LinkClient(keys, async (body) => sealResponse(stranger, openRequest(keys, body).nonce, { s: 403, b: null, now: 0 }, nonce()));
  await assert.rejects(forged.call("GET", "/api/device"), kind("forged"));
});

function tunnels(root = linkRoot(secret())) {
  const client = new Uint8Array(randomBytes(32)), server = new Uint8Array(randomBytes(32));
  return { root, phone: new Tunnel(root, client, server, "phone"), mac: new Tunnel(root, client, server, "mac") };
}

test("tunnel messages open once, in order, on their own connection", () => {
  const { root, phone, mac } = tunnels();
  const first = phone.seal(FRAME_DATA, utf8("one")), second = phone.seal(FRAME_DATA, utf8("two")), third = phone.seal(FRAME_DATA, utf8("three"));
  assert.notDeepEqual(first.subarray(0, 4), second.subarray(0, 4));
  assert.deepEqual(mac.open(first), { type: FRAME_DATA, payload: utf8("one") });
  assert.throws(() => mac.open(first), kind("forged"), "replayed");
  assert.throws(() => mac.open(third), kind("forged"), "a dropped message");
  assert.deepEqual(mac.open(second).payload, utf8("two"));
  assert.deepEqual(mac.open(third).payload, utf8("three"));

  const down = mac.seal(FRAME_DATA, utf8("down"));
  assert.throws(() => mac.open(down), kind("forged"), "reflected to its sender");
  assert.deepEqual(phone.open(down).payload, utf8("down"));

  // The same pairing on another connection has other keys.
  const again = tunnels(root);
  assert.throws(() => again.mac.open(first), kind("forged"));
  assert.throws(() => again.phone.open(down), kind("forged"));
  // And a different pairing cannot open anything.
  const stranger = new Tunnel(linkRoot(secret()), new Uint8Array(32), new Uint8Array(32), "mac");
  assert.throws(() => stranger.open(first), kind("forged"));
  const changed = phone.seal(FRAME_DATA, utf8("four")); changed[2]! ^= 1;
  assert.throws(() => mac.open(changed), kind("forged"));
  assert.throws(() => mac.open(new Uint8Array(3)), kind("malformed"));
});
