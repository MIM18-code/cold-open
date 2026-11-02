import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "../src/live.ts";
import type { Pairing } from "../src/pairing.ts";
import { FakeSocket } from "../../../packages/relay/test/fake-socket.ts";

const pair = { invite: { relay: "ws://localhost:4456", room: "room", key: "key", readOnly: true } } as Pairing;

test("interruptions replace one reader and Disconnect stops every reader and retry", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const OriginalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = OriginalSocket; });
  FakeSocket.instances = [];
  const stop = connect(pair, () => {}, () => {}, () => {});
  try {
    for (let n = 0; n < 4; n++) {
      FakeSocket.instances.at(-1)!.close();
      t.mock.timers.tick(4000);
      assert.equal(FakeSocket.instances.filter(s => s.readyState !== 3).length, 1);
    }
    stop();
    t.mock.timers.tick(120000);
    assert.ok(FakeSocket.instances.every(s => s.readyState === 3));
  } finally { stop(); }
});

test("Disconnect from a reconnect status callback cannot schedule another reader", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const OriginalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = OriginalSocket; });
  FakeSocket.instances = [];
  let stop = () => {};
  stop = connect(pair, () => {}, () => {}, status => { if (status === "Reconnecting") stop(); });
  FakeSocket.instances[0]!.close();
  t.mock.timers.tick(120000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.ok(FakeSocket.instances.every(s => s.readyState === 3));
  stop();
});
