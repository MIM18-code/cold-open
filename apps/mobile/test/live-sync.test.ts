import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { ScreenplayDoc, parseFountain } from "@screenplay/engine";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "@screenplay/relay/protocol";
import { connect, type Row } from "../src/live.ts";
import type { Pairing } from "../src/pairing.ts";
import { FakeSocket } from "../../../packages/relay/test/fake-socket.ts";

const pair = { invite: { relay: "ws://localhost:4456", room: "room", key: "key", readOnly: true } } as Pairing;
const deliver = (socket: FakeSocket, write: (e: encoding.Encoder) => void) => {
  const e = encoding.createEncoder(); write(e);
  const bytes = encoding.toUint8Array(e);
  socket.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
};

test("host presence before the doc syncs leaves the reader and its cache alone", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const OriginalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = OriginalSocket; });
  FakeSocket.instances = [];
  const host = ScreenplayDoc.fromScript(parseFountain("INT. FERRY TERMINAL - DAWN\n\nA lamp crosses the water."));
  const hostAwareness = new awarenessProtocol.Awareness(new Y.Doc());
  hostAwareness.setLocalState({ user: { name: "Mara" }, doc: { name: "The Last Crossing" } });
  const scripts: Row[][] = [];
  const stop = connect(pair, rows => scripts.push(rows), () => {}, () => {});
  try {
    const socket = FakeSocket.instances[0]!;
    socket.readyState = 1; socket.onopen?.();
    // The relay forwards the host's awareness before answering sync step 1.
    deliver(socket, e => { encoding.writeVarUint(e, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(hostAwareness, [hostAwareness.clientID])); });
    assert.deepEqual(scripts, [], "an unsynced, empty doc must not replace the cached reader");
    deliver(socket, e => { encoding.writeVarUint(e, MESSAGE_SYNC); syncProtocol.writeSyncStep2(e, host.ydoc); });
    assert.ok(scripts.length > 0);
    assert.equal(scripts.at(-1)!.at(-1)!.text, "A lamp crosses the water.");
  } finally { stop(); hostAwareness.destroy(); host.ydoc.destroy(); }
});
