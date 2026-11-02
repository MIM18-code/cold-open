// Joining a co-writing session from the renderer's controller, against a real relay on 127.0.0.1 and a stand-in
// for the app and the main process: what happens to the window's own script while the host's is on its way.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { ScreenplayDoc } from "@screenplay/engine";
import { createRelay, readKeyFor, type Relay } from "@screenplay/relay";
import { RelayClient } from "@screenplay/relay/client";
import { formatInvite } from "@screenplay/relay/protocol";

import { CHANNELS } from "../src/shared/api.ts";
import { SYNC } from "../src/shared/channels/sync.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";

const calls: { channel: string; args: unknown[] }[] = [];
(globalThis as any).window = {
  desktop: {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      if (channel === SYNC.userName) return "Tester";
      if (channel === SYNC.takeJoin) return null;
      if (channel === "shell:message-box") return { response: 0 };
      return undefined;
    },
    on: () => () => undefined,
    spelling: { isMisspelled: () => false, suggestions: () => [], addToDictionary: () => undefined },
    platform: "darwin",
  },
};
// Loaded by URL after the fake bridge exists; the renderer modules read window.desktop when they load.
const { CollabController } = await import(new URL("../src/renderer/features/collab/controller.ts", import.meta.url).href);

const relays: Relay[] = [];
const clients: RelayClient[] = [];
after(async () => {
  for (const client of clients) client.destroy();
  for (const relay of relays) await relay.close();
});

function fakeApp(session: DocumentSession) {
  const sessionListeners = new Set<(next: DocumentSession, previous: DocumentSession) => void>();
  const app = {
    session,
    editor: null,
    toasts: [] as string[],
    setSession(next: DocumentSession) {
      const previous = app.session;
      app.session = next;
      for (const listener of sessionListeners) listener(next, previous);
    },
    onSession(listener: (next: DocumentSession, previous: DocumentSession) => void) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    subscribe: () => () => undefined,
    setting: <T>(_key: string, fallback: T) => fallback,
    toast: (message: string) => void app.toasts.push(message),
    togglePanel: () => undefined,
    flushPending: () => undefined,
    refreshMenu: () => undefined,
  };
  return app;
}

async function hostedRoom() {
  const relay = await createRelay({ host: "127.0.0.1", port: 0, allowClaim: false });
  relays.push(relay);
  const keys = relay.createRoom();
  const url = `ws://127.0.0.1:${relay.port}`;
  const shareScript = async (text: string) => {
    const doc = new ScreenplayDoc();
    doc.load({ titlePage: [], paragraphs: [{ id: "p1", type: "action", runs: [{ text }] }] });
    const host = new RelayClient({ relay: url, room: keys.room, key: keys.key, doc: doc.ydoc });
    clients.push(host);
    await host.whenSynced();
    return host;
  };
  return { relay, keys, url, shareScript, invite: formatInvite({ relay: url, room: keys.room, key: keys.key, readOnly: false }) };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("typing while Join waits keeps the window's script; the shared one opens in a new window", async () => {
  const { shareScript, invite } = await hostedRoom();
  const own = DocumentSession.untitled();
  const app = fakeApp(own);
  const collab = new CollabController(app);
  calls.length = 0;
  const joining = collab.join(invite);
  // The writer dismisses the Join dialog and starts typing before the host's script arrives.
  await wait(50);
  const id = own.doc.toScript().paragraphs[0]!.id;
  own.edit(() => own.doc.insertText(id, 0, "INT. MY OWN SCENE - DAY"));
  await shareScript("The host's script.");
  await joining;
  assert.equal(app.session, own);
  assert.equal(own.doc.toScript().paragraphs[0]!.runs[0]!.text, "INT. MY OWN SCENE - DAY");
  assert.deepEqual(calls.filter((call) => call.channel === SYNC.queueJoin).map((call) => call.args[0]), [invite]);
  assert.ok(calls.some((call) => call.channel === CHANNELS.newWindow));
  assert.equal(collab.state.mode, "idle");
});

test("an untouched window takes the shared script", async () => {
  const { shareScript, invite } = await hostedRoom();
  const own = DocumentSession.untitled();
  const app = fakeApp(own);
  const collab = new CollabController(app);
  const joining = collab.join(invite);
  await wait(30);
  await shareScript("The host's script.");
  await joining;
  assert.notEqual(app.session, own);
  assert.equal(app.session.doc.toScript().paragraphs[0]!.runs[0]!.text, "The host's script.");
  assert.equal(collab.state.mode, "guest");
  await collab.stop();
});

test("a Join that times out leaves no listener on the abandoned session", async (t) => {
  const { invite } = await hostedRoom();
  const own = DocumentSession.untitled();
  const app = fakeApp(own);
  const collab = new CollabController(app);
  // Count onChange listeners on the shared session Join creates.
  const created: DocumentSession[] = [];
  const original = DocumentSession.prototype.onChange;
  t.mock.method(DocumentSession.prototype, "onChange", function (this: DocumentSession, listener: () => void) {
    if (!created.includes(this)) created.push(this);
    return original.call(this, listener);
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const joining = collab.join(invite).catch((error: Error) => error);
  // The relay answers, but no host is there: the room stays empty until Join gives up.
  for (let i = 0; i < 5000 && !created.length; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(16_000);
  t.mock.timers.reset();
  const error = await joining;
  assert.match(String(error), /Could not reach/);
  assert.equal(created.length, 1);
  assert.equal((created[0] as unknown as { listeners: Set<unknown> }).listeners.size, 0);
  assert.equal(app.session, own);
});

test("a read-only invite opens the shared script read-only", async () => {
  const { keys, url, shareScript } = await hostedRoom();
  await shareScript("Read me.");
  const app = fakeApp(DocumentSession.untitled());
  const collab = new CollabController(app);
  await collab.join(formatInvite({ relay: url, room: keys.room, key: readKeyFor(keys.key), readOnly: true }));
  assert.equal(app.session.readOnly, true);
  assert.throws(() => app.session.edit(() => undefined), /read-only/);
  await collab.stop();
  assert.equal(app.session.readOnly, false);
});

test("opening another script while Join waits keeps it; the shared one opens in a new window", async () => {
  const { shareScript, invite } = await hostedRoom();
  const app = fakeApp(DocumentSession.untitled());
  const collab = new CollabController(app);
  const deactivate = collab.activate();
  calls.length = 0;
  const joining = collab.join(invite);
  await wait(50);
  // File > Open into this untitled window before the host's script arrives.
  const opened = DocumentSession.untitled();
  opened.path = "/tmp/Opened.screenplay";
  app.setSession(opened);
  await shareScript("The host's script.");
  await joining;
  assert.equal(app.session, opened);
  assert.deepEqual(calls.filter((call) => call.channel === SYNC.queueJoin).map((call) => call.args[0]), [invite]);
  assert.ok(calls.some((call) => call.channel === CHANNELS.newWindow));
  assert.equal(collab.state.mode, "idle");
  deactivate();
});
