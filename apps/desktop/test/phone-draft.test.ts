import assert from "node:assert/strict";
import test from "node:test";
import { ScreenplayDoc, plainText } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { draftElements } from "../src/renderer/features/phone/draft.ts";
import { acceptPhoneRecord } from "../src/renderer/features/phone/receipts.ts";
import { createRecord } from "../src/renderer/features/rewrite/records.ts";

const text = "INT. KITCHEN - DAY\n\nMARA\n(quietly)\nKeep the door closed.\n\n> CUT TO:";
test("phone Fountain preview preserves headings, characters, parentheticals, dialogue and transitions", () => {
  assert.deepEqual(draftElements(text).map(({ type, text }) => ({ type, text })), [
    { type: "sceneHeading", text: "INT. KITCHEN - DAY" }, { type: "character", text: "MARA" },
    { type: "parenthetical", text: "(quietly)" }, { type: "dialogue", text: "Keep the door closed." },
    { type: "transition", text: "CUT TO:" },
  ]);
  for (const text of ["A door closes.", "Title: a passage", "==="])
    assert.deepEqual(draftElements(text), [{ type: "action", text, uncertainty: "" }]);
});

test("reviewed draft inserts after its attachment once across retries and reopen, and undoes as one edit", async () => {
  const s = DocumentSession.untitled();
  const anchor = s.script().paragraphs[0]!.id;
  s.edit(() => {
    s.doc.insertText(anchor, 0, "Attached passage.");
    s.doc.insertParagraph(1, { type: "action", runs: [{ text: "Following passage." }] });
  });
  const draft = { paragraphId: anchor, sourceText: "Attached passage.", elements: draftElements(text) };
  const record = createRecord("cut", "Phone draft", text);
  const accept = (session: DocumentSession) => acceptPhoneRecord(session, "draft-receipt-001", record, () => true, draft);
  try {
    assert.equal(await accept(s), true);
    assert.deepEqual(s.script().paragraphs.slice(1, -1).map(p => plainText(p.runs)), draft.elements.map(e => e.text));
    assert.equal(plainText(s.script().paragraphs.at(-1)!.runs), "Following passage.");
    assert.equal(await accept(s), false);
    const reopened = new DocumentSession(ScreenplayDoc.fromUpdate(s.doc.encodeState()));
    try { assert.equal(await accept(reopened), false); } finally { reopened.destroy(); }
    s.undo.undo();
    assert.equal(s.script().paragraphs.length, 2);
  } finally { s.destroy(); }
});

test("draft acceptance refuses changed or missing attachments without consuming the receipt", async () => {
  const s = DocumentSession.untitled();
  const record = createRecord("cut", "Phone draft", text);
  const metadata = s.doc.meta.toJSON();
  try {
    for (const paragraphId of ["missing", s.script().paragraphs[0]!.id]) {
      await assert.rejects(acceptPhoneRecord(s, "draft-receipt-001", record, () => true,
        { paragraphId, sourceText: "Gone.", elements: draftElements(text) }), /changed or was removed/);
    }
    assert.equal(s.script().paragraphs.length, 1);
    assert.deepEqual(s.doc.meta.toJSON(), metadata);
  } finally { s.destroy(); }
});

test("server accepts anchored drafts, deduplicates receipts and rejects invalid draft requests without a listener", async () => {
  const { PhoneServer } = await import("../src/main/phone/server.ts");
  const { Readable } = await import("node:stream");
  const server = new PhoneServer({ title: "Test", revision: "r1", cues: [] });
  const item = { id: "draft-receipt-001", kind: "draft", text, paragraphId: "p", sourceText: "Attached." };
  async function post(body: unknown) {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: { host: "", authorization: `Bearer ${server["token"]}`, "content-type": "application/json" },
      method: "POST", url: "/api/inbox", socket: { remoteAddress: "127.0.0.1" },
    });
    let code = 0;
    const res = { writeHead(status: number) { code = status; }, end() {} };
    await server["route"](req as unknown as import("node:http").IncomingMessage,
      res as unknown as import("node:http").ServerResponse, "", "");
    return code;
  }
  try {
    assert.equal(await post(item), 200);
    assert.equal(server.items()[0]?.kind, "draft");
    assert.equal(await post(item), 200);
    assert.equal(server.items().length, 1);
    assert.equal(await post({ ...item, text: "Changed." }), 409);
    for (const change of [{ paragraphId: "" }, { sourceText: "x".repeat(1501) }, { kind: "unknown" },
      { text: " " }, { text: "x".repeat(20001) }, { id: "bad" }])
      assert.equal(await post({ ...item, ...change }), 400);
    server.acknowledge(item.id, "accepted");
    assert.equal(await post(item), 200);
    assert.equal(server.items().length, 0);
  } finally { await server.stop(); }
});

test("synced acceptance skips insertion; offline acceptance reports copies without deleting either writer's text", async () => {
  const { applyUpdate } = await import("yjs");
  const { records } = await import("../src/renderer/features/rewrite/records.ts");
  const { repairMessage } = await import("../src/renderer/features/editor/rules.ts");
  const first = DocumentSession.untitled();
  const paragraphId = first.doc.paragraphs()[0]!.id;
  first.edit(() => first.doc.insertText(paragraphId, 0, "Attached."));
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  const follower = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  const draft = { paragraphId, sourceText: "Attached.", elements: draftElements("INT. ROOM - DAY\n\nA door closes.") };
  const accept = (s: DocumentSession) => acceptPhoneRecord(s, "offline-receipt-001",
    createRecord("cut", "Phone draft", "A door closes."), () => true, draft);
  const notices: string[] = [];
  first.doc.onRepair(report => { const message = repairMessage(report); if (message) notices.push(message); });
  try {
    await accept(first);
    applyUpdate(follower.doc.ydoc, first.doc.encodeState());
    assert.equal(await accept(follower), false);
    assert.equal(follower.doc.paragraphs().length, 3);
    await accept(second);
    second.edit(() => second.doc.insertText(second.doc.paragraphs()[2]!.id, 0, "Second writer. "));
    applyUpdate(first.doc.ydoc, second.doc.encodeState());
    applyUpdate(second.doc.ydoc, first.doc.encodeState());
    assert.equal(records(first.doc).length, 1);
    assert.equal(first.doc.paragraphs().length, 5);
    assert.ok(first.doc.paragraphs().some(p => plainText(p.runs).includes("Second writer.")));
    assert.ok(notices.some(n => /two copies|twice/.test(n)));
    assert.deepEqual(first.doc.validate(), []);
    assert.deepEqual(second.script().paragraphs, first.script().paragraphs);
    assert.equal(await accept(first), false);
  } finally { first.destroy(); second.destroy(); follower.destroy(); }
});

test("reopened text reanchors drafts and notes; missing or ambiguous text can be attached at the cursor", async () => {
  const { records, resolveAnchor } = await import("../src/renderer/features/rewrite/records.ts");
  for (const kind of ["draft", "note"] as const) {
    const session = DocumentSession.untitled();
    const paragraphId = session.doc.paragraphs()[0]!.id;
    session.edit(() => session.doc.insertText(paragraphId, 0, "Captured paragraph."));
    const attachment = { paragraphId: "old-fountain-id", sourceText: "Captured paragraph.",
      ...(kind === "draft" ? { elements: draftElements("New text.") } : {}) };
    try {
      await acceptPhoneRecord(session, `reopened-${kind}-receipt`, createRecord("note", "Phone", "New text."),
        () => true, attachment);
      if (kind === "draft") assert.equal(plainText(session.doc.paragraphs()[1]!.runs), "New text.");
      else assert.equal(resolveAnchor(session.doc, records(session.doc)[0]!.anchor)?.paragraphId, paragraphId);
      session.edit(() => session.doc.insertParagraph(session.doc.paragraphs().length,
        { type: "action", runs: [{ text: "Captured paragraph." }] }));
      for (const sourceText of ["Captured paragraph.", "Gone.", "Captured"]) {
        const id = `ambiguous-${kind}-${sourceText.length}`;
        await assert.rejects(acceptPhoneRecord(session, id, createRecord("note", "Phone", "Keep me."),
          () => true, { ...attachment, sourceText }), /Insert at cursor/);
        await acceptPhoneRecord(session, id, createRecord("note", "Phone", "Keep me."),
          () => true, { ...attachment, sourceText, cursor: { paragraphId, offset: 4 } });
        if (kind === "note") {
          const record = records(session.doc).find(r => r.phoneReceipt === id)!;
          assert.equal(resolveAnchor(session.doc, record.anchor)?.from, 4);
        }
      }
    } finally { session.destroy(); }
  }
});
