// What someone on the same Wi-Fi sees of a home pairing: every byte the Mac's listener receives and sends while
// an iPhone pairs, reads the live script, sends takes and syncs receipts. None of it may show the pairing secret,
// the room or its keys, the script, or the writer's notes; and a captured request sent again must do nothing.
import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ScreenplayDoc, parseFountain } from "@screenplay/engine";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneHost } from "../src/main/phone/host.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { PhoneServer } from "../src/main/phone/server.ts";
import { publishToPhone } from "../src/renderer/features/phone/publisher.ts";
import { decodePairing } from "../../mobile/src/pairing.ts";
import { connect, type Row } from "../../mobile/src/live.ts";
import { deliver, deviceStatus, syncReceipts, type Take } from "../../mobile/src/outbox.ts";
import { openRequest, openResponse } from "@screenplay/relay/sealed";
import { phoneLink } from "./phone-link.ts";

const SCRIPT = "INT. LIGHTHOUSE - NIGHT\n\nMARGUERITE climbs the spiral stairs with a storm lantern.\n\nMARGUERITE\nThe keeper lied about the wreck.";
const NOTE = "Give her the brass telescope here, not the lantern.";

/** Every byte a listener receives and sends, in order, as a capture on the network would hold them. */
function tap(server: Server) {
  const received: Buffer[] = [], sent: Buffer[] = [];
  server.on("connection", (socket: Socket) => {
    socket.on("data", chunk => received.push(Buffer.from(chunk)));
    const write = socket.write.bind(socket);
    socket.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sent.push(Buffer.from(chunk as Uint8Array));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof socket.write;
  });
  return { received: () => Buffer.concat(received), sent: () => Buffer.concat(sent) };
}

async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 300 && !ok(); i++) await delay(10);
  assert.ok(ok(), what);
}

/** The words a capture must not hold, including the forms a secret takes when it is merely re-encoded. */
function leaks(wire: Buffer, secrets: string[]) {
  const found: string[] = [];
  for (const secret of secrets) {
    const forms = [Buffer.from(secret), Buffer.from(secret, "utf16le"), Buffer.from(Buffer.from(secret).toString("base64")),
      Buffer.from(Buffer.from(secret).toString("base64url")), Buffer.from(Buffer.from(secret).toString("hex")), Buffer.from(encodeURIComponent(secret))];
    if (forms.some(form => wire.includes(form))) found.push(secret);
  }
  return found;
}

async function session(listener: Server, pairing: string, publisher: Parameters<typeof publishToPhone>[0], kind: "one-off" | "remembered") {
  const wire = tap(listener);
  const pair = decodePairing(pairing), signal = new AbortController().signal;
  const doc = ScreenplayDoc.fromScript(parseFountain(SCRIPT));
  const host = publishToPhone(publisher, doc, () => ({ title: "The Wreck of the Calliope", name: "Josephine Writer", writers: [], cursor: null }));
  let rows: Row[] = [], state = "";
  const leave = connect(pair, value => { rows = value; }, () => {}, value => { state = value; });
  try {
    await until(() => state === "Live" && rows.some(row => row.text.includes("keeper lied")), "the iPhone reads the script");
    doc.insertText(doc.paragraphs()[1]!.id, 0, "Drenched, ");
    await until(() => rows.some(row => row.text.startsWith("Drenched")), "a live edit arrives");
    assert.deepEqual(await deviceStatus(pair, signal, "Josephine’s iPhone"), { open: true });
    const take: Take = { id: "wire-receipt-0001", room: pair.invite.room, kind: "note", text: NOTE,
      paragraphId: doc.paragraphs()[1]!.id, sourceText: rows[1]!.text, scene: "Scene 1", created: Date.now(), outcome: "pending" };
    await deliver(pair, take, signal);
    assert.deepEqual([...await syncReceipts(pair, signal, [take])], []);

    const up = wire.received(), down = wire.sent();
    assert.ok(up.includes("POST /link HTTP/1.1") && up.includes("GET /sealed/"), "the tap sees the requests themselves");
    assert.ok(up.length > 1500 && down.length > 1500, "the tap sees the traffic");
    const code = JSON.parse(pairing);
    const secrets = [code.secret, pair.invite.room, pair.invite.key, publisher.key,
      "LIGHTHOUSE", "MARGUERITE", "spiral stairs", "keeper lied", "Drenched", "brass telescope", "wire-receipt-0001",
      "The Wreck of the Calliope", "Josephine", "Cold Open Remote", "Scene 1", "paragraphId", "/api/inbox", "/api/receipts",
      ...(kind === "remembered" ? [code.deviceId, code.scriptId] : [])];
    assert.deepEqual(leaks(up, secrets), [], "iPhone to Mac");
    assert.deepEqual(leaks(down, secrets), [], "Mac to iPhone");
    assert.ok(!up.includes("Bearer") && !up.toString("latin1").toLowerCase().includes("authorization"), "no bearer is sent");
    return { up, pair, take };
  } finally { leave(); host.stop(); doc.ydoc.destroy(); }
}

test("a one-off home pairing shows the network neither the secret nor the script", async t => {
  // The exact bodies the iPhone posts, to find in the capture and send again.
  const bodies: string[] = [], realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: string, options?: RequestInit) => {
    if (String(url).endsWith("/link") && bodies.length < 50) bodies.push(String(options?.body));
    return realFetch(url, options);
  });
  const saved: string[] = [];
  const server = new PhoneServer({ title: "The Wreck of the Calliope", revision: "v1", cues: [] }, () => {}, item => { saved.push(item.text); });
  const info = await server.start("127.0.0.1");
  try {
    const { up } = await session(server["server"]!, info.pairing, info.publisher, "one-off");
    assert.deepEqual(saved, [NOTE]);

    // Send every captured request again, byte for byte. One that ran is refused in the clear. The iPhone's first,
    // sent before it knew the Mac's run ID, was answered "try again" and never ran, and gets that answer again.
    const captured = [...bodies];
    assert.ok(captured.length >= 3);
    const { origin, keys } = phoneLink(info.pairing);
    const answers: number[] = [];
    for (const body of captured) {
      assert.ok(up.includes(body), "the capture holds this request");
      const replayed = await fetch(origin + "/link", { method: "POST", headers: { "content-type": "text/plain" }, body });
      if (replayed.status === 403) assert.deepEqual(await replayed.json(), { error: "Pairing refused." });
      else assert.equal(openResponse(keys, openRequest(keys, body).nonce, await replayed.text()).s, 425);
      answers.push(replayed.status);
    }
    assert.deepEqual(answers, [200, ...captured.slice(1).map(() => 403)]);
    assert.deepEqual(saved, [NOTE]);
    assert.equal(server.items().length, 1);
    // A request with one changed character does not authenticate either.
    const tampered = captured[0]!.slice(0, -2) + (captured[0]!.at(-2) === "A" ? "B" : "A") + captured[0]!.at(-1);
    assert.equal((await fetch(origin + "/link", { method: "POST", body: tampered })).status, 403);
  } finally { await server.stop(); }
});

test("a remembered home pairing shows the network neither the secret nor the script", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-wire-"));
  const devices = new PhoneDevices(join(root, "devices.json"));
  const inbox = new PhoneInboxStore(join(root, "inbox"));
  const host = new PhoneHost();
  let server: PhoneServer | undefined;
  try {
    await host.start("127.0.0.1", "127.0.0.1", 0);
    const created = await devices.create("c".repeat(64), "127.0.0.1");
    server = new PhoneServer({ title: "The Wreck of the Calliope", revision: "v1", cues: [] }, () => {},
      async item => { await devices.receive(created.device.id, created.device.scriptId, item, inbox); });
    const info = server.attach(host, created.device, created.token, name => devices.seen(created.device.id, name),
      () => devices.decisions(created.device.id));
    const { pair, take } = await session(host["server"]!, info.pairing, info.publisher, "remembered");
    assert.equal((await inbox.list(created.device.scriptId))[0]?.text, NOTE);
    assert.equal(devices.device(created.device.id)?.name, "Josephine’s iPhone");
    // What the Mac keeps for this iPhone is derived from the secret, never the secret.
    const stored = JSON.stringify(devices.all());
    assert.ok(!stored.includes(JSON.parse(info.pairing).secret));
    // A second iPhone's key opens nothing of the first's.
    const stranger = await devices.create("d".repeat(64), "127.0.0.1");
    const other = decodePairing(JSON.stringify({ ...JSON.parse(info.pairing), secret: stranger.token }));
    await assert.rejects(deliver(other, take, new AbortController().signal),
      (e: unknown) => e instanceof Error && "status" in e && e.status === 502);
    await deliver(pair, take, new AbortController().signal);
    assert.equal((await inbox.list(created.device.scriptId)).length, 1);
  } finally { await server?.stop(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});

test("the Safari link, when the writer asks for one, is a separate credential that cannot reach the app's requests", async () => {
  const server = new PhoneServer({ title: "Draft", revision: "v1", cues: [{ id: "c", paragraphId: "p", speaker: "MARA", heading: "INT. ROOM", text: "Open the door." }] });
  const info = await server.start("127.0.0.1", undefined, undefined, undefined, undefined, true);
  try {
    const wire = tap(server["server"]!);
    const link = phoneLink(info.pairing), page = new URL(info.url), bearer = { authorization: `Bearer ${page.hash.slice(1)}` };
    assert.equal(info.encrypted, false, "the Safari link is reported as not encrypted");
    assert.equal((await fetch(page.origin + "/api/snapshot", { headers: bearer })).status, 200);
    assert.equal((await link.get("/api/receipts")).status, 200);
    // The page's traffic is readable, as the panel says. The secret behind the sealed link still never appears.
    assert.ok(wire.sent().includes("Open the door."));
    assert.deepEqual(leaks(Buffer.concat([wire.received(), wire.sent()]), [link.secret]), []);
  } finally { await server.stop(); }
});
