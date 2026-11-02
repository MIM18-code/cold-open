// An input method's composition that commits after a co-writer's edit: the replaced text is the characters the
// editor drew, found again in today's text, so text a co-writer typed between them survives.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import { charactersAt, liveRanges, relativeAt } from "../src/renderer/features/editor/positions.ts";

/** Replace drawn offsets [from, to) with text the way the editor's commit does, after `remote` changed the text. */
function commitOver(initial: string, from: number, to: number, text: string, remote: (body: Y.Text) => void): string {
  const ydoc = new Y.Doc();
  ydoc.clientID = 1;
  const body = ydoc.getText("body");
  body.insert(0, initial);
  const drawn = Y.snapshot(ydoc);
  const peer = new Y.Doc();
  peer.clientID = 2;
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  remote(peer.getText("body"));
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));
  const start = relativeAt(body, drawn, from);
  const replaced = charactersAt(body, drawn, from, to);
  ydoc.transact(() => {
    for (const [a, b] of liveRanges(body, replaced).reverse()) body.delete(a, b - a);
    body.insert(Y.createAbsolutePositionFromRelativePosition(start, ydoc)!.index, text);
  });
  return body.toString();
}

test("a co-writer's text inside the replaced range survives the commit", () => {
  // Sol's case: "cd" composed over with X while REMOTE arrives between c and d.
  assert.equal(commitOver("abcdef", 2, 4, "X", (body) => body.insert(3, "REMOTE")), "abXREMOTEef");
  assert.equal(commitOver("abcdef", 1, 5, "X", (body) => (body.insert(4, "two"), body.insert(2, "one"))), "aXonetwof");
});

test("text before, after or deleted by the co-writer lands as before", () => {
  assert.equal(commitOver("abcdef", 2, 4, "X", (body) => body.insert(0, "REMOTE")), "REMOTEabXef");
  assert.equal(commitOver("abcdef", 2, 4, "X", (body) => body.insert(4, "R")), "abXRef");
  assert.equal(commitOver("abcdef", 2, 4, "X", (body) => body.delete(2, 1)), "abXef");
  assert.equal(commitOver("abcdef", 2, 4, "X", (body) => body.delete(1, 4)), "aXf");
  assert.equal(commitOver("abcdef", 3, 3, "X", (body) => body.insert(0, "R")), "RabcXdef");
});

test("a co-writer's deletion that another co-writer's typing splits still counts in the drawn text", () => {
  // Yjs empties collected letters, and the right half of a split one is no longer counted as text: with
  // collection on, "cd" below resolves one letter late and the commit gives "ZcXf". The editor holds collection
  // while it has a drawn snapshot (controller.ts bind), as here.
  const ydoc = new Y.Doc();
  ydoc.clientID = 1;
  let drawing = false;
  ydoc.gcFilter = () => !drawing;
  const body = ydoc.getText("body");
  body.insert(0, "abcdef");
  const drawn = Y.snapshot(ydoc);
  drawing = true;
  const peer = (client: number) => {
    const doc = new Y.Doc();
    doc.clientID = client;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(ydoc));
    return doc;
  };
  const deleter = peer(2), typer = peer(3);
  typer.getText("body").insert(1, "Z");
  deleter.getText("body").delete(0, 2);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(deleter));
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(typer));
  const start = relativeAt(body, drawn, 2);
  const replaced = charactersAt(body, drawn, 2, 4);
  ydoc.transact(() => {
    for (const [a, b] of liveRanges(body, replaced).reverse()) body.delete(a, b - a);
    body.insert(Y.createAbsolutePositionFromRelativePosition(start, ydoc)!.index, "X");
  });
  assert.equal(body.toString(), "ZXef");
});

test("characters are found across many items and paragraphs", () => {
  const ydoc = new Y.Doc();
  const body = ydoc.getText("body");
  for (let i = 0; i < 200; i++) body.insert(body.length, `\nline ${i}`);
  const drawn = Y.snapshot(ydoc);
  const before = body.toString();
  const from = before.indexOf("line 50"), to = before.indexOf("line 52");
  // A co-writer adds a word in the middle of the range and deletes a line before it.
  body.insert(before.indexOf("line 51") + 4, " NEW");
  body.delete(before.indexOf("line 10"), 8);
  const ranges = liveRanges(body, charactersAt(body, drawn, from, to));
  assert.equal(ranges.length, 2);
  assert.equal(ranges.map(([a, b]) => body.toString().slice(a, b)).join(""), before.slice(from, to));
});
