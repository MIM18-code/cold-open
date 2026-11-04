import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { PhoneServer } from "../../desktop/src/main/phone/server.ts";
import { PhoneInboxStore } from "../../desktop/src/main/phone/inbox.ts";
import { DocumentSession } from "../../desktop/src/renderer/core/session.ts";
import { filePhoneNotes } from "../../desktop/src/renderer/features/phone/receipts.ts";
import { records } from "../../desktop/src/renderer/features/rewrite/records.ts";
import { decodePairing } from "../src/pairing.ts";
import { sendPending, type Take } from "../src/outbox.ts";

// The phone's real SQLite outbox, with expo-sqlite backed by node:sqlite.
const bundle = await build({ stdin: { contents: `export * from "./src/store";`, resolveDir: resolve(import.meta.dirname, "..") },
  bundle: true, write: false, platform: "node", format: "esm", external: ["node:sqlite"],
  plugins: [{ name: "sqlite", setup(b) {
    b.onResolve({ filter: /^expo-sqlite$/ }, () => ({ path: "expo-sqlite", namespace: "shim" }));
    b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: `
      import { DatabaseSync } from "node:sqlite";
      export function openDatabaseSync() {
        const db = new DatabaseSync(":memory:");
        return { execSync: sql => db.exec(sql), runSync: (sql, ...a) => db.prepare(sql).run(...a),
          getFirstSync: (sql, ...a) => db.prepare(sql).get(...a) ?? null, getAllSync: (sql, ...a) => db.prepare(sql).all(...a),
          withTransactionSync(fn) { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } };
      }` }));
  } }] });
const store = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0]!.text).toString("base64"));

test("an unsent note from the old note editor joins the note screen without replacing what is there", () => {
  const row = { id: "p1", scene: "Scene 1", text: "A rope drops." };
  store.keepComposition("old-room", { kind: "note", row, text: "Older unsent note" });
  store.moveNoteComposition("old-room", store.resumeComposition("old-room"));
  assert.deepEqual(store.resumeCapture(), { row, text: "Older unsent note" });
  store.keepComposition("old-room", { kind: "note", row, text: "Second old note" });
  store.moveNoteComposition("old-room", store.resumeComposition("old-room"));
  assert.deepEqual(store.resumeCapture(), { row, text: "Older unsent note\n\nSecond old note" });
  assert.equal(store.resumeComposition("old-room"), null);
  store.keepCapture({ row: null, text: "" });
});

test("a note written before pairing waits, joins the first pairing, and lands in the Mac's Notes without review", async () => {
  const loose: Take = { id: "loose-note-000001", room: store.UNPAIRED, kind: "note", text: "Nora's thermos should be red.",
    paragraphId: "", sourceText: "", scene: "", created: Date.now(), outcome: "pending" };
  store.keepCapture({ row: null, text: loose.text });
  assert.equal(store.resumeCapture().text, loose.text, "the unsent note survives a relaunch");
  store.saveNote(loose);
  assert.equal(store.resumeCapture().text, "", "saving clears the note screen");
  store.saveTake({ ...loose, id: "old-draft-0000001", kind: "draft" });

  const dir = await mkdtemp(join(tmpdir(), "cold-open-notes-"));
  const inbox = new PhoneInboxStore(dir), key = "test-document-key";
  const server = new PhoneServer({ title: "Ferry", revision: "v1", cues: [] }, () => {}, item => inbox.append(key, item));
  const pair = decodePairing((await server.start("127.0.0.1")).pairing);
  const session = DocumentSession.untitled();
  try {
    const signal = new AbortController().signal;
    await sendPending(pair, store.listTakes(), signal, store.mark);
    assert.equal((await inbox.list(key)).length, 0, "nothing goes out before the note joins a pairing");
    assert.equal(store.claimUnpairedNotes(pair.invite.room), 1, "only waiting notes join; drafts never move scripts");
    await sendPending(pair, store.listTakes(), signal, store.mark);
    assert.equal(store.listTakes().find((t: Take) => t.id === loose.id).outcome, "delivered");
    const received = await inbox.list(key);
    assert.deepEqual(received.map(r => [r.kind, r.paragraphId, r.text]), [["note", "", loose.text]]);
    assert.equal(await filePhoneNotes(session, received, () => true, async () => {}), 1);
    const [note] = records(session.doc, "note");
    assert.equal(note!.text, loose.text);
    assert.equal(note!.author, "Phone");
    assert.equal(note!.anchor, undefined);
  } finally { session.destroy(); await server.stop(); await rm(dir, { recursive: true, force: true }); }
});
