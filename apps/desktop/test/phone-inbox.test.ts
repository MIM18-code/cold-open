import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { phoneDocumentKey, watchPhoneDocumentKey } from "../src/renderer/features/phone/identity.ts";
import { phonePathKey } from "../src/main/phone/identity.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";

const item = { id: "message-00000001", kind: "note" as const, text: "Keep this", cueId: "c", paragraphId: "p",
  revision: "r", created: new Date().toISOString() };

test("phone identity survives FDX and Fountain reopening without creating metadata or dirtying a script", async () => {
  for (const format of ["fdx", "fountain"] as const) {
    const first = DocumentSession.untitled(), reopened = DocumentSession.untitled();
    first.path = "/scripts/../scripts/Draft." + format;
    reopened.path = "/scripts/Draft." + format;
    const readId = (session: DocumentSession, create = false) => {
      assert.equal(create, false);
      return session.doc.meta.get("history.documentId") as string | undefined ?? null;
    };
    const pathKey = async (path: string) => phonePathKey(path);
    const move = async () => {};
    const key = await phoneDocumentKey(first, readId, pathKey, move);
    assert.equal(key, await phoneDocumentKey(reopened, readId, pathKey, move));
    assert.equal(first.dirty, false);
    assert.equal(first.doc.meta.has("history.documentId"), false);
    // A first native save later adds a history ID; the inbox key must not move with it.
    first.doc.meta.set("history.documentId", "existing-history-id");
    assert.equal(await phoneDocumentKey(first, readId, pathKey, move), key);
    first.destroy();
    reopened.destroy();
  }
});

test("untitled phone inbox identity stays in its session", async () => {
  const a = DocumentSession.untitled(), b = DocumentSession.untitled();
  const key = (s: DocumentSession) => phoneDocumentKey(s, () => null,
    async () => { throw new Error("No file path"); }, async () => {});
  assert.equal(await key(a), await key(a));
  assert.notEqual(await key(a), await key(b));
  assert.equal(a.dirty, false);
  a.destroy();
  b.destroy();
});

test("phone identity moves its inbox on first Save and Save As while the panel is closed", async () => {
  const session = DocumentSession.untitled(), moves: string[][] = [], errors: unknown[] = [];
  const metadata = session.doc.meta.toJSON();
  const pathKey = async (path: string) => phonePathKey(path);
  const move = async (from: string, to: string) => { moves.push([from, to]); };
  const unwatch = watchPhoneDocumentKey(session, () => null, pathKey, move, error => errors.push(error));
  try {
    const initial = await phoneDocumentKey(session, () => null, pathKey, move);
    session.markSaved("/scripts/First.screenplay", "screenplay", "First");
    const saved = await phoneDocumentKey(session, () => null, pathKey, move);
    session.markSaved("/scripts/Second.screenplay", "screenplay", "Second");
    const savedAs = await phoneDocumentKey(session, () => null, pathKey, move);
    assert.deepEqual(moves, [[initial, saved], [saved, savedAs]]);
    assert.equal(savedAs, phonePathKey("/scripts/Second.screenplay"));
    assert.deepEqual(errors, []);
    assert.equal(session.dirty, false);
    assert.deepEqual(session.doc.meta.toJSON(), metadata);
  } finally {
    unwatch();
    session.destroy();
  }
});

test("moving a phone inbox merges saved items and retargets incoming paired messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-move-")), store = new PhoneInboxStore(root);
  const from = "untitled-session-0001", to = phonePathKey("/scripts/Saved.screenplay");
  const active = { key: from };
  try {
    await store.append(from, item);
    await store.append(to, item);
    await store.append(to, { ...item, id: "message-00000002", text: "Already saved" });
    const moving = store.move(from, to, () => { active.key = to; });
    const receiving = store.append(() => active.key, { ...item, id: "message-00000003" });
    await Promise.all([moving, receiving]);
    assert.deepEqual(await store.list(from), []);
    assert.deepEqual((await store.list(to)).map(row => row.id).sort(), [
      "message-00000001", "message-00000002", "message-00000003",
    ]);
    assert.equal(active.key, to);
    await store.move(to, to);
    assert.equal((await store.list(to)).length, 3);
    const savedAs = phonePathKey("/scripts/Renamed.screenplay");
    await store.move(to, savedAs, () => { active.key = savedAs; });
    assert.deepEqual(await store.list(to), []);
    assert.equal((await store.list(savedAs)).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phone inbox moves reject malformed keys and overflowing merges without losing either inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-move-limits-")), store = new PhoneInboxStore(root);
  const from = "source-project-0001", to = "target-project-0001";
  try {
    await store.append(from, item);
    for (const key of ["../../scripts/Draft.screenplay", "short", "x".repeat(81), "bad/key-0000001", null, {}]) {
      await assert.rejects(store.move(key, to), /Invalid phone document identity/);
      await assert.rejects(store.move(from, key), /Invalid phone document identity/);
    }
    for (let n = 0; n < 100; n++) {
      await store.append(to, { ...item, id: `target-message-${String(n).padStart(4, "0")}` });
    }
    await assert.rejects(store.move(from, to), /100 saved phone items/);
    assert.deepEqual(await store.list(from), [item]);
    assert.equal((await store.list(to)).length, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearing old phone inboxes frees project capacity while preserving current and active projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-capacity-")), store = new PhoneInboxStore(root);
  try {
    for (let n = 0; n < 100; n++) await store.append(`project-${String(n).padStart(12, "0")}`, item);
    await assert.rejects(store.append("new-project-00000001", item), /100 projects/);
    assert.equal(await store.clearOther(["project-000000000000", "project-000000000001"]), 98);
    await store.append("new-project-00000001", item);
    assert.equal((await store.list("project-000000000000")).length, 1);
    assert.equal((await store.list("project-000000000001")).length, 1);
    assert.equal((await store.list("new-project-00000001")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a saved script brings over the inbox an older version kept under its history ID, once", async () => {
  const session = DocumentSession.untitled();
  session.path = "/scripts/Legacy.screenplay";
  session.doc.meta.set("history.documentId", "0f8c4a52-1d2e-4b7a-9c3d-5e6f7a8b9c0d");
  const adopted: string[][] = [];
  const key = () => phoneDocumentKey(session, (s) => s.doc.meta.get("history.documentId") as string ?? null,
    async (path) => phonePathKey(path), async () => undefined, async (k) => k,
    async (legacy, path) => { adopted.push([legacy, path]); });
  try {
    const first = await key();
    assert.equal(first, phonePathKey("/scripts/Legacy.screenplay"));
    assert.deepEqual(adopted, [["0f8c4a52-1d2e-4b7a-9c3d-5e6f7a8b9c0d", "/scripts/Legacy.screenplay"]]);
    await key();
    assert.equal(adopted.length, 1);
  } finally {
    session.destroy();
  }
});
