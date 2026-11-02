// The app's own file format (.screenplay): an 8-byte magic, a 4-byte header length, a JSON header, then the
// Yjs document state. The state carries the whole collaborative document, so co-writing and sync history
// survive saving and reopening.
import { ScreenplayDoc, SCHEMA_VERSION } from "@screenplay/engine";
import * as Y from "yjs";

const MAGIC = new TextEncoder().encode("SCRNPLY1");

export interface FileHeader {
  format: 1;
  schema: number;
  title?: string;
  savedAt: string;
  app: string;
}

export function encodeNative(doc: ScreenplayDoc, title?: string): Uint8Array {
  const header: FileHeader = { format: 1, schema: SCHEMA_VERSION, savedAt: new Date().toISOString(), app: "screenplay-desktop 0.1", ...(title ? { title } : {}) };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const state = doc.encodeState();
  const out = new Uint8Array(MAGIC.length + 4 + json.length + state.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, json.length, false);
  out.set(json, MAGIC.length + 4);
  out.set(state, MAGIC.length + 4 + json.length);
  return out;
}

export function isNative(data: Uint8Array): boolean {
  return data.length >= MAGIC.length + 4 && MAGIC.every((byte, i) => data[i] === byte);
}

export function decodeNative(data: Uint8Array): { header: FileHeader; doc: ScreenplayDoc } {
  if (!isNative(data)) throw new Error("This is not a screenplay file.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = view.getUint32(MAGIC.length, false);
  const headerEnd = MAGIC.length + 4 + length;
  if (headerEnd > data.length) throw new Error("The file is damaged: its header runs past the end.");
  const header = JSON.parse(new TextDecoder().decode(data.subarray(MAGIC.length + 4, headerEnd))) as FileHeader;
  if (header.schema > SCHEMA_VERSION) throw new Error("This file was saved by a newer version of the app.");
  const doc = ScreenplayDoc.fromUpdate(data.subarray(headerEnd));
  return { header, doc };
}

/** How a .screenplay file on disk relates to an open document. */
export type DiskMerge = "contained" | "merged" | "unrelated";

/**
 * Bring in a .screenplay file that was saved over the one this document came from: by another Mac syncing through
 * the same folder, or by another window. If the two share Yjs history, the disk state merges into the document with
 * nothing lost and the result says whether it brought anything new. A file with no history in common (a different
 * script saved at the same path) is left alone, since merging it would duplicate the script.
 */
export function mergeNativeFromDisk(doc: ScreenplayDoc, data: Uint8Array, origin: unknown): DiskMerge {
  if (!isNative(data)) return "unrelated";
  const { doc: disk } = decodeNative(data);
  try {
    if (!historyInCommon(doc, disk)) return "unrelated";
    let changed = false;
    const onUpdate = () => { changed = true; };
    doc.ydoc.on("update", onUpdate);
    try {
      Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(disk.ydoc, Y.encodeStateVector(doc.ydoc)), origin);
    } finally {
      doc.ydoc.off("update", onUpdate);
    }
    return changed ? "merged" : "contained";
  } finally {
    disk.ydoc.destroy();
  }
}

/** The value a metadata key will have once `data` is merged into `doc`, worked out on a copy. */
export function metaAfterMerge(doc: ScreenplayDoc, data: Uint8Array, key: string): unknown {
  const { doc: disk } = decodeNative(data);
  const merged = ScreenplayDoc.fromUpdate(Y.mergeUpdates([doc.encodeState(), disk.encodeState()]));
  try {
    return merged.meta.get(key);
  } finally {
    disk.ydoc.destroy();
    merged.ydoc.destroy();
  }
}

/** Whether a .screenplay file's state descends from the same document as `doc`, so merging it cannot duplicate it. */
export function sharesHistory(doc: ScreenplayDoc, data: Uint8Array): boolean {
  if (!isNative(data)) return false;
  const { doc: disk } = decodeNative(data);
  try {
    return historyInCommon(doc, disk);
  } finally {
    disk.ydoc.destroy();
  }
}

// Every window that ever edited a document leaves its Yjs client ID in the state, and reopening keeps them, so two
// copies of one script share at least the first one. Independent scripts get independent random IDs.
function historyInCommon(doc: ScreenplayDoc, other: ScreenplayDoc): boolean {
  const theirs = Y.decodeStateVector(Y.encodeStateVector(other.ydoc));
  const ours = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc));
  return [...theirs.keys()].some((client) => ours.has(client));
}
