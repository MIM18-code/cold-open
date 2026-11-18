// The sealed link's framing: key derivation, HTTP envelopes, replay and wrong-key rejection, and the WebSocket
// tunnel. The Node provider is checked against published vectors first, and the derivations against the
// documented formulas, so the code is not its own witness.
import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  FRAME_DATA, LINK_VERSION, LinkClient, LinkError, ReplayGuard, Tunnel, answerSealed, fromBase64url, linkKeys as keysFor,
  linkRoot as rootFor, openRequest, openResponse, requestId, sealRequest, sealResponse, toBase64url,
} from "../src/sealed.ts";
import { nodeLinkCrypto } from "../src/sealed-node.ts";

const linkRoot = (token: string) => rootFor(nodeLinkCrypto, token);
const linkKeys = (root: Uint8Array) => keysFor(nodeLinkCrypto, root);
const secret = () => randomBytes(32).toString("base64url");
const rid = () => new Uint8Array(randomBytes(24));
const utf8 = (text: string) => new Uint8Array(Buffer.from(text));
const hex = (text: string) => new Uint8Array(Buffer.from(text.replace(/[\s:]/g, ""), "hex"));
const range = (from: number, count: number) => Uint8Array.from({ length: count }, (_, i) => from + i);
const kind = (expected: LinkError["kind"]) => (error: unknown) => error instanceof LinkError && error.kind === expected;

/** McGrew and Viega, "The Galois/Counter Mode of Operation (GCM)", revised 2005, Test Case 16: 256-bit key, 96-bit IV, AAD. */
const GCM_CASE_16 = {
  key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
  iv: "cafebabefacedbaddecaf888",
  aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
  plain: "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
  cipher: "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
  tag: "76fc6ece0f4e1768cddf8853bb2d551b",
};

test("AES-256-GCM matches McGrew and Viega's GCM specification, test case 16", () => {
  const { key, iv, aad, plain, cipher, tag } = GCM_CASE_16;
  const expected = hex(cipher + tag);
  assert.deepEqual(nodeLinkCrypto.seal(hex(key), hex(iv), hex(aad), hex(plain)), expected);
  assert.deepEqual(nodeLinkCrypto.open(hex(key), hex(iv), hex(aad), expected), hex(plain));
  for (const at of [0, 30, expected.length - 1]) {
    const changed = expected.slice(); changed[at]! ^= 1;
    assert.throws(() => nodeLinkCrypto.open(hex(key), hex(iv), hex(aad), changed), `byte ${at}`);
  }
  assert.throws(() => nodeLinkCrypto.open(hex(key), hex(iv), utf8("other"), expected), "different AAD");
  assert.throws(() => nodeLinkCrypto.open(hex(key), hex(iv), hex(aad), expected.subarray(0, 15)), "shorter than a tag");
  assert.throws(() => nodeLinkCrypto.seal(hex(key).subarray(1), hex(iv), hex(aad), hex(plain)), "a short key");
  assert.throws(() => nodeLinkCrypto.seal(hex(key), hex(iv + "00"), hex(aad), hex(plain)), "a nonce that is not 12 bytes");
});

test("HKDF-SHA256 matches RFC 5869 test cases 1 and 3", () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  assert.deepEqual(nodeLinkCrypto.hkdf(ikm, range(0, 13), range(0xf0, 10), 42),
    hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"));
  // Empty salt and info, as the link's second-level keys use an empty salt.
  assert.deepEqual(nodeLinkCrypto.hkdf(ikm, new Uint8Array(0), new Uint8Array(0), 42),
    hex("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"));
  assert.equal(nodeLinkCrypto.random(24).length, 24);
  assert.notDeepEqual(nodeLinkCrypto.random(32), nodeLinkCrypto.random(32));
});

test("keys are HKDF-SHA256 of the pairing secret, as documented", () => {
  const token = secret(), root = linkRoot(token), keys = linkKeys(root);
  // Node's HKDF does RFC 5869 extract and expand in one call.
  const hkdf = (ikm: Uint8Array | Buffer, salt: string | Uint8Array, info: string, length: number) =>
    new Uint8Array(hkdfSync("sha256", ikm, salt, info, length));
  assert.deepEqual(root, hkdf(Buffer.from(token, "base64url"), "coldopen-phone-link-v3", "root", 32));
  assert.deepEqual(keys.kid, hkdf(root, "", "kid", 16));
  assert.deepEqual(keys.request, hkdf(root, "", "http phone to mac", 32));
  assert.deepEqual(keys.response, hkdf(root, "", "http mac to phone", 32));
  assert.equal(keys.crypto, nodeLinkCrypto);
  assert.equal(keys.id, Buffer.from(keys.kid).toString("base64url"));
  assert.equal(keys.id.length, 22);
  assert.notDeepEqual(keys.request, keys.response);
  assert.throws(() => linkRoot("short"), kind("malformed"));
  assert.throws(() => linkRoot("!".repeat(43)), kind("malformed"));
  assert.throws(() => linkKeys(new Uint8Array(31)), kind("malformed"));
});

test("HTTP envelopes are built as documented", () => {
  const keys = linkKeys(linkRoot(secret())), id = rid(), sid = rid();
  const request = { t: 1, m: "GET" as const, p: "/api/device" };
  const bytes = fromBase64url(sealRequest(keys, request, id));
  assert.equal(bytes[0], 3);
  assert.deepEqual(bytes.subarray(1, 17), keys.kid);
  assert.deepEqual(bytes.subarray(17, 41), id);
  const requestKey = new Uint8Array(hkdfSync("sha256", keys.request, id, "request", 32));
  assert.deepEqual(bytes.subarray(41), nodeLinkCrypto.seal(requestKey, new Uint8Array(12),
    Buffer.concat([Buffer.from("coldopen-link-v3 request"), keys.kid]), utf8(JSON.stringify(request))));

  const response = { s: 200, b: null, now: 2 };
  const answer = fromBase64url(sealResponse(keys, id, response, sid));
  assert.deepEqual(answer.subarray(0, 24), sid);
  const responseKey = new Uint8Array(hkdfSync("sha256", keys.response, Buffer.concat([id, sid]), "response", 32));
  assert.deepEqual(answer.subarray(24), nodeLinkCrypto.seal(responseKey, new Uint8Array(12),
    Buffer.concat([Buffer.from("coldopen-link-v3 response"), id]), utf8(JSON.stringify(response))));
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
  const n = rid(), body = sealRequest(keys, request, n);
  assert.deepEqual(openRequest(keys, body), { request, rid: n });
  assert.equal(requestId(body), keys.id);
  assert.ok(!Buffer.from(body, "base64url").includes("KITCHEN"), "the body is not readable");

  // Another pairing's key: the ID does not match, and with the ID forced the tag does not.
  assert.throws(() => openRequest(other, body), kind("unknown"));
  const bytes = Buffer.from(body, "base64url");
  const renamed = Buffer.from(bytes); renamed.set(other.kid, 1);
  assert.throws(() => openRequest(other, renamed.toString("base64url")), kind("forged"));
  assert.throws(() => openRequest(keys, renamed.toString("base64url")), kind("unknown"));

  // Any changed byte of the request ID, the ciphertext or the tag is refused.
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
  const asked = rid(), reply = { s: 200, b: { open: true }, now: 5 };
  const body = sealResponse(keys, asked, reply, rid());
  assert.deepEqual(openResponse(keys, asked, body), reply);
  assert.throws(() => openResponse(keys, rid(), body), kind("forged"), "an old response replayed to a new request");
  assert.throws(() => openResponse(other, asked, body), kind("forged"));
  const changed = Buffer.from(body, "base64url"); changed[changed.length - 20]! ^= 0x80;
  assert.throws(() => openResponse(keys, asked, changed.toString("base64url")), kind("forged"));
  const sid = Buffer.from(body, "base64url"); sid[3]! ^= 1;
  assert.throws(() => openResponse(keys, asked, sid.toString("base64url")), kind("forged"), "a changed response ID");
  assert.throws(() => openResponse(keys, asked, Buffer.from(body, "base64url").subarray(0, 39).toString("base64url")), kind("malformed"));
  assert.throws(() => openResponse(keys, asked, '{"error":"Pairing refused."}'), kind("malformed"));
});

test("the two directions use different keys", () => {
  const keys = linkKeys(linkRoot(secret())), n = rid();
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
  const guard = new ReplayGuard(nodeLinkCrypto), clock = () => now;
  const handle = async () => { handled++; return { status: 200, body: { id: "saved" } }; };
  const n = rid(), body = sealRequest(keys, { t: now, e: guard.run, m: "POST", p: "/api/inbox", b: { id: "take" } }, n);
  assert.deepEqual(openResponse(keys, n, await answerSealed(keys, guard, body, handle, undefined, clock)).b, { id: "saved" });
  await assert.rejects(answerSealed(keys, guard, body, handle, undefined, clock), kind("replayed"));
  now += 60_000;
  await assert.rejects(answerSealed(keys, guard, body, handle, undefined, clock), kind("replayed"));
  // Past the window the request ID is forgotten, and the request is stale instead: answered 425, never run.
  now += 120_000;
  assert.equal(openResponse(keys, n, await answerSealed(keys, guard, body, handle, undefined, clock)).s, 425);
  assert.equal(handled, 1);
});

test("a request recorded before the Mac restarted is never run after it, whatever its timestamp", async () => {
  const keys = linkKeys(linkRoot(secret()));
  let handled = 0;
  const handle = async () => { handled++; return { status: 200, body: null }; };
  // The iPhone's clock runs a minute ahead of the Mac's: inside the window, so nothing corrects it.
  const before = new ReplayGuard(nodeLinkCrypto), n = rid();
  const body = sealRequest(keys, { t: 1_060_000, e: before.run, m: "POST", p: "/api/device", b: { name: "Old name" } }, n);
  assert.equal(openResponse(keys, n, await answerSealed(keys, before, body, handle, undefined, () => 1_000_000)).s, 200);
  assert.equal(handled, 1);

  // The Mac restarts ten seconds later with no memory of that request ID. The recorded request's time still looks
  // current, and it is sealed with the right key, but it names the earlier run.
  const after = new ReplayGuard(nodeLinkCrypto);
  assert.notEqual(after.run, before.run);
  const reply = openResponse(keys, n, await answerSealed(keys, after, body, handle, undefined, () => 1_010_000));
  assert.equal(reply.s, 425);
  assert.equal(handled, 1, "the replay was not run");

  // A request that names no run at all is never run either, on any guard.
  const blank = rid(), unnamed = sealRequest(keys, { t: 1_010_000, m: "POST", p: "/api/device", b: { name: "x" } }, blank);
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
    const sent = openRequest(keys, sealed).rid;
    assert.equal(openResponse(keys, sent, await answerSealed(keys, after, sealed, handle, undefined, () => 1_010_000)).s, 425);
  }
  assert.equal(handled, 3);
});

test("the replay guard bounds its memory", () => {
  const guard = new ReplayGuard(nodeLinkCrypto, 1000, 3), run = guard.run;
  assert.equal(guard.admit(run, 10, rid(), 10), "fresh");
  assert.equal(guard.admit(run, 11, rid(), 11), "fresh");
  assert.equal(guard.admit(run, 12, rid(), 12), "fresh");
  assert.equal(guard.admit(run, 13, rid(), 13), "busy");
  assert.equal(guard.admit(run, 1500, rid(), 1500), "fresh", "expired request IDs make room");
  assert.equal(guard.admit(run, Number.NaN, rid(), 1500), "stale");
  assert.equal(guard.admit(run, 1500 + 1001, rid(), 1500), "stale", "a time from the future");
  assert.equal(guard.admit(undefined, 1500, rid(), 1500), "stale", "no run named");
  assert.equal(guard.admit(new ReplayGuard(nodeLinkCrypto).run, 1500, rid(), 1500), "stale", "another run");
  assert.equal(run.length, 22);
});

test("the phone follows the Mac's run and clock and never sends the same body twice", async () => {
  const keys = linkKeys(linkRoot(secret()));
  const mac = () => 9_000_000, phone = () => 1_000_000; // The phone's clock is hours behind.
  const guard = new ReplayGuard(nodeLinkCrypto), bodies: string[] = [];
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
  const forged = new LinkClient(keys, async (body) => sealResponse(stranger, openRequest(keys, body).rid, { s: 403, b: null, now: 0 }, rid()));
  await assert.rejects(forged.call("GET", "/api/device"), kind("forged"));
});

function tunnels(keys = linkKeys(linkRoot(secret()))) {
  const client = new Uint8Array(randomBytes(32)), server = new Uint8Array(randomBytes(32));
  return { keys, client, server, phone: new Tunnel(keys, client, server, "phone"), mac: new Tunnel(keys, client, server, "mac") };
}

test("tunnel keys and nonces are built as documented", () => {
  const { keys, client, server, phone, mac } = tunnels();
  const up = new Uint8Array(hkdfSync("sha256", keys.root, Buffer.concat([client, server]), "ws phone to mac", 32));
  const down = new Uint8Array(hkdfSync("sha256", keys.root, Buffer.concat([client, server]), "ws mac to phone", 32));
  const nonce = (counter: number) => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(counter), 4); return n; };
  phone.seal(FRAME_DATA, utf8("zero"));
  assert.deepEqual(phone.seal(FRAME_DATA, utf8("one")), nodeLinkCrypto.seal(up, nonce(1), new Uint8Array(0), utf8("\0one")));
  assert.deepEqual(mac.seal(2, utf8("bye")), nodeLinkCrypto.seal(down, nonce(0), new Uint8Array(0), utf8("\x02bye")));
});

test("tunnel messages open once, in order, on their own connection", () => {
  const { keys, phone, mac } = tunnels();
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
  const again = tunnels(keys);
  assert.throws(() => again.mac.open(first), kind("forged"));
  assert.throws(() => again.phone.open(down), kind("forged"));
  // And a different pairing cannot open anything.
  const stranger = new Tunnel(linkKeys(linkRoot(secret())), new Uint8Array(32), new Uint8Array(32), "mac");
  assert.throws(() => stranger.open(first), kind("forged"));
  const changed = phone.seal(FRAME_DATA, utf8("four")); changed[2]! ^= 1;
  assert.throws(() => mac.open(changed), kind("forged"));
  assert.throws(() => mac.open(new Uint8Array(3)), kind("malformed"));
});
