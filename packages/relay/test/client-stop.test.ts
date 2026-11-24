import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { RelayClient } from "../src/client.ts";
import { CLOSE_DENIED, CLOSE_FULL } from "../src/protocol.ts";
import { FakeSocket } from "./fake-socket.ts";

test("destroy inside the reconnect callback is final, including queued socket events", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  FakeSocket.instances = [];
  const doc = new Y.Doc();
  const client = new RelayClient({ relay: "ws://localhost:4456", room: "room", key: "key", doc,
    WebSocket: FakeSocket as unknown as typeof WebSocket });
  try {
    const socket = FakeSocket.instances[0]!;
    const queuedClose = socket.onclose!;
    client.onStatus(status => { if (status === "reconnecting") client.destroy(); });
    socket.close();
    queuedClose({ code: 1006, reason: "late" });
    t.mock.timers.tick(120000);
    assert.equal(client.status, "stopped");
    assert.equal(FakeSocket.instances.length, 1);
    assert.ok(FakeSocket.instances.every(socket => socket.readyState === 3));
  } finally { client.destroy(); doc.destroy(); }
});

test("a refusal shows its own reason, not one left by an earlier close", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  FakeSocket.instances = [];
  const doc = new Y.Doc();
  const client = new RelayClient({ relay: "ws://localhost:4456", room: "room", key: "key", doc,
    WebSocket: FakeSocket as unknown as typeof WebSocket });
  try {
    FakeSocket.instances[0]!.close(CLOSE_FULL, "");
    assert.equal(client.reason, "the relay is full");
    t.mock.timers.tick(120000);
    assert.equal(FakeSocket.instances.length, 2, "it tried again");
    FakeSocket.instances[1]!.close(CLOSE_DENIED, "wrong key");
    assert.equal(client.status, "denied");
    assert.equal(client.reason, "wrong key");
  } finally { client.destroy(); doc.destroy(); }
});
