import assert from "node:assert/strict";
import test from "node:test";
import { ScreenplayDoc } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { acceptPhoneRecord } from "../src/renderer/features/phone/receipts.ts";
import { createRecord, putRecord, records } from "../src/renderer/features/rewrite/records.ts";

const note = () => createRecord("note", "Phone note", "Check the door.");
const receiptKeys = (s: DocumentSession) => [...s.doc.meta.keys()].filter(k => k.startsWith("phone.accepted."));

test("phone acceptance retries reuse the accepted record without accumulating receipt metadata", async () => {
  const session = DocumentSession.untitled(), id = "message-00000001";
  const results = await Promise.all([
    acceptPhoneRecord(session, id, note(), () => true),
    acceptPhoneRecord(session, id, note(), () => true),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(records(session.doc).length, 1);
  assert.deepEqual(receiptKeys(session), []);
  // A failed acknowledgement can leave the item in the local inbox across restart.
  const reopened = new DocumentSession(ScreenplayDoc.fromUpdate(session.doc.encodeState()));
  assert.equal(await acceptPhoneRecord(reopened, id, note(), () => true), false);
  assert.equal(records(reopened.doc).length, 1);
  assert.deepEqual(receiptKeys(reopened), []);
  session.destroy();
  reopened.destroy();
});

test("legacy phone receipts move into existing records and disappear from document metadata", async () => {
  const session = DocumentSession.untitled(), record = note(), id = "legacy-message-00001";
  session.edit(() => {
    putRecord(session.doc, record);
    session.doc.meta.set("phone.accepted." + id, record.id);
    session.doc.meta.set("phone.accepted.deleted-message", "already-deleted-record");
  });
  assert.equal(await acceptPhoneRecord(session, id, note(), () => true), false);
  assert.equal(records(session.doc).length, 1);
  assert.deepEqual(receiptKeys(session), []);
  assert.equal(await acceptPhoneRecord(session, id, note(), () => true), false);
  session.destroy();
});

test("phone acceptance refuses a stale session after computing its record identity", async () => {
  const session = DocumentSession.untitled();
  let current = true;
  const pending = acceptPhoneRecord(session, "message-00000001", note(), () => current);
  current = false;
  await assert.rejects(pending, /editable script/);
  assert.equal(session.dirty, false);
  session.destroy();
});
