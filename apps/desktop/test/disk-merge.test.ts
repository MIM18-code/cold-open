import assert from "node:assert/strict";
import test from "node:test";
import { ScreenplayDoc, plainText } from "@screenplay/engine";
import { decodeNative, encodeNative, mergeNativeFromDisk, metaAfterMerge } from "../src/renderer/core/fileformat.ts";

const ORIGIN = Symbol("test-disk-merge");
const text = (doc: ScreenplayDoc) => doc.toScript().paragraphs.map((p) => plainText(p.runs)).join("\n");

function script(): ScreenplayDoc {
  return ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", runs: [{ text: "INT. GARAGE - NIGHT" }] },
    { id: "a1", type: "action", runs: [{ text: "Nell waits." }] },
  ] });
}

test("a copy saved by another Mac through folder sync merges in without losing either side", () => {
  const mine = script();
  const saved = encodeNative(mine);
  // The other Mac opens the same file, types, and its save replaces ours in the shared folder.
  const theirs = decodeNative(saved).doc;
  theirs.insertText("a1", "Nell waits.".length, " The engine ticks.");
  const theirFile = encodeNative(theirs);
  // Meanwhile this Mac keeps typing.
  mine.insertText("h1", 0, "EXT./");

  assert.equal(mergeNativeFromDisk(mine, theirFile, ORIGIN), "merged");
  assert.match(text(mine), /EXT\.\/INT\. GARAGE - NIGHT/);
  assert.match(text(mine), /Nell waits\. The engine ticks\./);
});

test("a disk copy whose changes this document already has reports contained and changes nothing", () => {
  const mine = script();
  const theirs = decodeNative(encodeNative(mine)).doc;
  theirs.insertText("a1", 0, "Still, ");
  const theirFile = encodeNative(theirs);
  // Folder sync already delivered the same edit through the log.
  assert.equal(mergeNativeFromDisk(mine, theirFile, ORIGIN), "merged");
  const before = text(mine);
  assert.equal(mergeNativeFromDisk(mine, theirFile, ORIGIN), "contained");
  assert.equal(text(mine), before);
});

test("deletions made on the other copy come across too", () => {
  const mine = script();
  const theirs = decodeNative(encodeNative(mine)).doc;
  theirs.deleteText("a1", 0, "Nell ".length);
  assert.equal(mergeNativeFromDisk(mine, encodeNative(theirs), ORIGIN), "merged");
  assert.match(text(mine), /^INT\. GARAGE - NIGHT\nwaits\.$/);
});

test("a different script saved at the same path is never merged", () => {
  const mine = script();
  const before = text(mine);
  assert.equal(mergeNativeFromDisk(mine, encodeNative(script()), ORIGIN), "unrelated");
  assert.equal(mergeNativeFromDisk(mine, new TextEncoder().encode("Title: Not ours"), ORIGIN), "unrelated");
  assert.equal(text(mine), before);
});

test("the history ID a merge will keep is known before merging", () => {
  // Both copies wrote their own history ID on their first save; only one survives the merge.
  const mine = script();
  const theirs = decodeNative(encodeNative(mine)).doc;
  mine.meta.set("history.documentId", "mine-history-id-000");
  theirs.meta.set("history.documentId", "their-history-id-000");
  const theirFile = encodeNative(theirs);
  const predicted = metaAfterMerge(mine, theirFile, "history.documentId");
  assert.equal(mine.meta.get("history.documentId"), "mine-history-id-000");
  mergeNativeFromDisk(mine, theirFile, ORIGIN);
  assert.equal(mine.meta.get("history.documentId"), predicted);
});
