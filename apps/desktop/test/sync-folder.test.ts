// Folder sync: the log format, and two documents syncing through folders with a fake cloud that delivers files
// late, in pieces, and more than once.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ScreenplayDoc, newId } from "@screenplay/engine";
import * as Y from "yjs";

import { HEADER_BYTES, crc32, encodeHeader, encodeRecords, parseLog } from "../src/main/sync/folder-log.ts";
import { FolderSync, syncFolderFor } from "../src/main/sync/folder-sync.ts";
import { openForRead } from "../src/main/safe-fs.ts";

const temp = mkdtempSync(join(tmpdir(), "screenplay-sync-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let dirCount = 0;
const freshDir = () => {
  const dir = join(temp, `case-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const REMOTE = Symbol("folder");

/** A device: a Y.Doc whose local updates go to its log and whose remote updates come from the others' logs. */
function device(folder: string, deviceId: string, doc = new Y.Doc(), options: { watch?: boolean; compactBytes?: number } = {}) {
  const sync = new FolderSync({
    folder, deviceId, rescanMs: 60_000, watch: options.watch ?? false,
    ...(options.compactBytes ? { compactBytes: options.compactBytes } : {}),
    onUpdates: (updates) => updates.forEach((update) => Y.applyUpdate(doc, update, REMOTE)),
    onError: (error) => assert.fail(String(error)),
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) void sync.append([update]);
  });
  return { doc, sync, text: () => doc.getText("body").toString() };
}

async function waitFor(check: () => boolean, what: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the sync folder sits next to the document", () => {
  assert.equal(syncFolderFor("/Users/a/Scripts/My Draft.screenplay"), "/Users/a/Scripts/My Draft.screenplay-sync");
});

test("a log read at every possible truncation yields only whole records, in order", () => {
  const updates = [new Uint8Array([1, 2, 3]), new Uint8Array(300).fill(7), new Uint8Array([9])];
  const file = new Uint8Array([...encodeHeader(), ...encodeRecords(updates)]);
  let previous = 0;
  for (let cut = 0; cut <= file.length; cut++) {
    const parsed = parseLog(file.subarray(0, cut));
    assert.equal(parsed.invalid, false, `cut ${cut}`);
    assert.ok(parsed.records.length >= previous);
    parsed.records.forEach((record, i) => assert.deepEqual(record, updates[i]));
    previous = parsed.records.length;
    // Reading on from where the partial read stopped gives the rest.
    const rest = parseLog(file, parsed.end);
    assert.equal(parsed.records.length + rest.records.length, updates.length);
  }
  assert.equal(previous, 3);
  assert.equal(parseLog(file).incomplete, false);
});

test("a record with a bad checksum stops the read until it is fixed", () => {
  const good = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
  const file = new Uint8Array([...encodeHeader(), ...encodeRecords(good)]);
  const damaged = file.slice();
  damaged[damaged.length - 1] = 0;
  const parsed = parseLog(damaged);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.incomplete, true);
  assert.equal(parseLog(file, parsed.end).records.length, 1);
  assert.equal(parseLog(new TextEncoder().encode("not a log at all, but long enough")).invalid, true);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("two devices converge through a cloud that delivers late, partially and twice", async () => {
  const folderA = freshDir();
  const folderB = freshDir();
  const a = device(folderA, "device-aaaa");
  const b = device(folderB, "device-bbbb");
  await a.sync.start();
  await b.sync.start();

  // The fake cloud copies each device's own log to the other folder, sometimes only a prefix of it.
  const deliver = (from: string, to: string, id: string, fraction = 1) => {
    const source = join(from, `${id}.ylog`);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(source);
    } catch {
      return;
    }
    writeFileSync(join(to, `${id}.ylog`), bytes.subarray(0, Math.floor(bytes.length * fraction)));
  };

  a.doc.getText("body").insert(0, "INT. DINER - NIGHT\n");
  b.doc.getText("body").insert(0, "FADE IN:\n");
  await a.sync.append([]);
  await b.sync.append([]);
  for (let round = 0; round < 12; round++) {
    a.doc.getText("body").insert(a.text().length, `a${round} `);
    if (round % 3 === 0) b.doc.getText("body").insert(0, `b${round} `);
    await a.sync.append([]);
    await b.sync.append([]);
    // Partial delivery, a scan, then (sometimes) the rest.
    deliver(folderA, folderB, "device-aaaa", 0.4 + (round % 5) / 10);
    deliver(folderB, folderA, "device-bbbb", 0.5);
    await b.sync.scan();
    await a.sync.scan();
    if (round % 2) {
      deliver(folderA, folderB, "device-aaaa");
      deliver(folderB, folderA, "device-bbbb");
      await b.sync.scan();
      await a.sync.scan();
    }
  }
  deliver(folderA, folderB, "device-aaaa");
  deliver(folderB, folderA, "device-bbbb");
  await b.sync.scan();
  await a.sync.scan();
  assert.equal(a.text(), b.text());
  assert.ok(a.text().includes("INT. DINER") && a.text().includes("FADE IN:") && a.text().includes("a11 ") && a.text().includes("b9 "));

  // Delivering everything again changes nothing.
  const before = a.text();
  writeFileSync(join(folderA, "device-bbbb.ylog"), new Uint8Array(0));
  await a.sync.scan();
  deliver(folderB, folderA, "device-bbbb");
  await a.sync.scan();
  assert.equal(a.text(), before);
  await a.sync.stop();
  await b.sync.stop();
});

test("compaction rewrites a log under a new generation and readers pick it up", async () => {
  const folder = freshDir();
  const a = device(folder, "device-aaaa", new Y.Doc(), { compactBytes: 400 });
  const b = device(folder, "device-bbbb");
  await a.sync.start();
  await b.sync.start();
  for (let i = 0; i < 60; i++) a.doc.getText("body").insert(a.text().length, `line ${i}\n`);
  await a.sync.append([]);
  await b.sync.scan();
  assert.equal(b.text(), a.text());
  const log = new Uint8Array(readFileSync(join(folder, "device-aaaa.ylog")));
  assert.ok(log.length < 1400, `log compacted to ${log.length} bytes`);
  assert.ok(parseLog(log).records.length < 60);
  for (let i = 0; i < 5; i++) a.doc.getText("body").insert(0, `new ${i}\n`);
  await a.sync.append([]);
  await b.sync.scan();
  assert.equal(b.text(), a.text());
  assert.deepEqual(readdirSync(folder).filter((name) => name.startsWith(".")), []);
  await a.sync.stop();
  await b.sync.stop();
});

test("starting writes what this device has that its log lacks, and repairs a torn log", async () => {
  const folder = freshDir();
  // A screenplay written before folder sync was turned on.
  const script = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: newId(), type: "sceneHeading", runs: [{ text: "EXT. PIER - DAWN" }] }] });
  // A crash left half a record at the end of this device's log.
  const torn = new Uint8Array([...encodeHeader(), ...encodeRecords([new Uint8Array([0, 0])])]);
  writeFileSync(join(folder, "device-aaaa.ylog"), new Uint8Array([...torn, 0, 0, 1, 0, 0]));
  const a = new FolderSync({ folder, deviceId: "device-aaaa", watch: false, onUpdates: () => undefined });
  await a.start(script.encodeState());
  const repaired = parseLog(new Uint8Array(readFileSync(join(folder, "device-aaaa.ylog"))));
  assert.equal(repaired.incomplete, false);

  const other = new ScreenplayDoc();
  const b = device(folder, "device-bbbb", other.ydoc);
  const initial = await b.sync.start(other.encodeState());
  initial.forEach((update) => other.applyUpdate(update, REMOTE));
  assert.equal(other.toScript().paragraphs[0]?.runs[0]?.text, "EXT. PIER - DAWN");

  // Starting again with nothing new appends at most a tiny record.
  const size = readFileSync(join(folder, "device-aaaa.ylog")).length;
  await a.stop();
  const again = new FolderSync({ folder, deviceId: "device-aaaa", watch: false, onUpdates: () => undefined });
  await again.start(script.encodeState());
  assert.ok(readFileSync(join(folder, "device-aaaa.ylog")).length - size < 64);
  await again.stop();
  await b.sync.stop();
});

test("fs.watch delivers another device's changes without waiting for the rescan", async () => {
  const folder = freshDir();
  const a = device(folder, "device-aaaa", new Y.Doc(), { watch: true });
  const b = device(folder, "device-bbbb", new Y.Doc(), { watch: true });
  await a.sync.start();
  await b.sync.start();
  a.doc.getText("body").insert(0, "watched");
  await waitFor(() => b.text() === "watched", "the watcher");
  b.doc.getText("body").insert(7, " back");
  await waitFor(() => a.text() === "watched back", "the watcher, the other way");
  await a.sync.stop();
  await b.sync.stop();
});

test("a log copied over by an older cloud version is re-read from the start", async () => {
  const folderA = freshDir();
  const folderB = freshDir();
  const a = device(folderA, "device-aaaa");
  const b = device(folderB, "device-bbbb");
  await a.sync.start();
  await b.sync.start();
  a.doc.getText("body").insert(0, "one ");
  await a.sync.append([]);
  const early = join(temp, "early.ylog");
  copyFileSync(join(folderA, "device-aaaa.ylog"), early);
  a.doc.getText("body").insert(4, "two");
  await a.sync.append([]);
  copyFileSync(join(folderA, "device-aaaa.ylog"), join(folderB, "device-aaaa.ylog"));
  await b.sync.scan();
  copyFileSync(early, join(folderB, "device-aaaa.ylog"));
  await b.sync.scan();
  copyFileSync(join(folderA, "device-aaaa.ylog"), join(folderB, "device-aaaa.ylog"));
  await b.sync.scan();
  assert.equal(b.text(), "one two");
  assert.ok(HEADER_BYTES > 0);
  await a.sync.stop();
  await b.sync.stop();
});

test("changes in this device's log that the opened file lacks come back on start", async () => {
  const folder = freshDir();
  const saved = new Y.Doc();
  saved.getText("body").insert(0, "Saved line. Cut words.");
  const savedState = Y.encodeStateAsUpdate(saved);
  // The writer keeps typing and deleting with folder sync on, then closes without saving (or the app crashes).
  const a = device(folder, "device-aaaa", saved);
  await a.sync.start(savedState);
  saved.getText("body").insert(11, " Logged, never saved.");
  saved.getText("body").delete(32, 11);
  await a.sync.append([]);
  await a.sync.stop();
  // Reopening the file gives the older state; start hands back what the log has, so this Mac matches the others.
  const reopened = new Y.Doc();
  Y.applyUpdate(reopened, savedState);
  const again = new FolderSync({ folder, deviceId: "device-aaaa", watch: false, onUpdates: () => undefined });
  const initial = await again.start(savedState);
  initial.forEach((update) => Y.applyUpdate(reopened, update, REMOTE));
  assert.equal(reopened.getText("body").toString(), saved.getText("body").toString());
  await again.stop();
});

test("starting again with an unchanged document appends nothing, even when it has deletions", async () => {
  const folder = freshDir();
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "Some text, partly cut.");
  doc.getText("body").delete(4, 5);
  const state = Y.encodeStateAsUpdate(doc);
  const first = new FolderSync({ folder, deviceId: "device-aaaa", watch: false, onUpdates: () => undefined });
  assert.deepEqual(await first.start(state), []);
  await first.stop();
  const size = readFileSync(join(folder, "device-aaaa.ylog")).length;
  for (let i = 0; i < 3; i++) {
    const next = new FolderSync({ folder, deviceId: "device-aaaa", watch: false, onUpdates: () => undefined });
    assert.deepEqual(await next.start(state), []);
    await next.stop();
  }
  assert.equal(readFileSync(join(folder, "device-aaaa.ylog")).length, size);
});

test("a log whose merged state is past the compaction size is not rewritten on every append", async () => {
  const folder = freshDir();
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "x".repeat(2000));
  const a = device(folder, "device-aaaa", doc, { compactBytes: 500 });
  await a.sync.start(Y.encodeStateAsUpdate(doc));
  const generation = () => parseLog(new Uint8Array(readFileSync(join(folder, "device-aaaa.ylog")))).generation;
  const before = generation();
  for (let i = 0; i < 10; i++) {
    doc.getText("body").insert(0, "y");
    await a.sync.append([]);
  }
  assert.equal(generation(), before);
  await a.sync.stop();
});

test("a log past the compaction size is not rewritten on the first appends after a restart", async () => {
  const folder = freshDir();
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "x".repeat(3000));
  const first = new FolderSync({ folder, deviceId: "device-aaaa", compactBytes: 1000, watch: false, onUpdates: () => undefined });
  await first.start(Y.encodeStateAsUpdate(doc));
  await first.stop();
  const a = device(folder, "device-aaaa", doc, { compactBytes: 1000 });
  await a.sync.start(Y.encodeStateAsUpdate(doc));
  const generation = () => parseLog(new Uint8Array(readFileSync(join(folder, "device-aaaa.ylog")))).generation;
  const before = generation();
  for (let i = 0; i < 5; i++) {
    doc.getText("body").insert(0, "a");
    await a.sync.append([]);
  }
  assert.equal(generation(), before);
  await a.sync.stop();
});

test("a log of several records past the compaction size is compacted on the first append after a restart", async () => {
  const folder = freshDir();
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  // Earlier sessions each appended a little and never reached their compaction size.
  const first = new FolderSync({ folder, deviceId: "device-aaaa", compactBytes: 1_000_000, watch: false, onUpdates: () => undefined });
  await first.start(Y.encodeStateAsUpdate(doc));
  for (let i = 0; i < 40; i++) {
    doc.getText("body").insert(0, `line ${i} ${"x".repeat(40)}\n`);
    await first.append(updates.splice(0));
  }
  await first.stop();
  const log = () => parseLog(new Uint8Array(readFileSync(join(folder, "device-aaaa.ylog"))));
  assert.ok(log().records.length > 1);
  const before = log().generation;
  const a = device(folder, "device-aaaa", doc, { compactBytes: 1000 });
  await a.sync.start(Y.encodeStateAsUpdate(doc));
  doc.getText("body").insert(0, "a");
  await a.sync.append([]);
  assert.notEqual(log().generation, before);
  assert.equal(log().records.length, 1);
  await a.sync.stop();
});

test("compacting after a torn append keeps the changes written behind the torn record", async () => {
  const folder = freshDir();
  const doc = new Y.Doc();
  const body = doc.getText("body");
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  const errors: unknown[] = [];
  const a = new FolderSync({ folder, deviceId: "device-aaaa", compactBytes: 200, watch: false, onUpdates: () => undefined, onError: (error) => errors.push(error) });
  body.insert(0, "one");
  await a.start(Y.encodeStateAsUpdate(doc));
  updates.length = 0;
  body.insert(3, "-two");
  await a.append(updates.splice(0));
  // A failed write (a full disk) got one whole record onto the disk, then the start of a record whose body never
  // arrived. The append was reported as failed, so this device never counted the whole one as written.
  body.insert(body.length, "-written-before-the-tear");
  writeFileSync(join(folder, "device-aaaa.ylog"), encodeRecords(updates.splice(0)), { flag: "a" });
  writeFileSync(join(folder, "device-aaaa.ylog"), new Uint8Array([0, 0, 1, 0xf4, 1, 2, 3, 4, 9, 9]), { flag: "a" });
  for (let i = 0; i < 6; i++) {
    body.insert(body.length, `-edit${i}-${"x".repeat(40)}`);
    await a.append(updates.splice(0));
  }
  assert.deepEqual(errors, []);

  const other = new Y.Doc();
  const b = new FolderSync({ folder, deviceId: "device-bbbb", watch: false, onUpdates: () => undefined });
  for (const update of await b.start()) Y.applyUpdate(other, update);
  assert.equal(other.getText("body").toString(), body.toString());
  await a.stop();
  await b.stop();
});

test("stopping while the start is still under way leaves no watcher or timer behind", async () => {
  const folder = freshDir();
  const a = device(folder, "device-aaaa", new Y.Doc(), { watch: true });
  // A window closes while its document's sync is still starting.
  const starting = a.sync.start();
  await a.sync.stop();
  await starting;
  const internals = a.sync as unknown as { watcher?: unknown; timer?: unknown };
  assert.equal(internals.watcher, undefined);
  assert.equal(internals.timer, undefined);
});

// Hostile or damaged logs. Anyone who can write the sync folder can put a record with a valid checksum in it, or a
// file of any size, so one bad record or file must cost only itself.

/** The update for typing `text` at the start of an otherwise empty script, from a device of its own. */
function typed(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

const logFile = (...records: Uint8Array[]) => new Uint8Array([...encodeHeader(), ...encodeRecords(records)]);
// A valid checksum over bytes that are not a Yjs update: one client, two structs, then nothing.
const NOT_AN_UPDATE = new Uint8Array([1, 2, 3]);
const isUpdate = (record: Uint8Array) => {
  try {
    Y.decodeUpdate(record);
    return true;
  } catch {
    return false;
  }
};

/** A device that records what folder sync hands it instead of failing on the first error. */
function watcher(folder: string, options: { maxLogBytes?: number } = {}) {
  const doc = new Y.Doc();
  const delivered: Uint8Array[] = [];
  const errors: string[] = [];
  const sync = new FolderSync({
    folder, deviceId: "device-aaaa", rescanMs: 60_000, watch: false, ...options,
    onUpdates: (updates) => {
      delivered.push(...updates);
      for (const update of updates) Y.applyUpdate(doc, update, REMOTE);
    },
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });
  return { doc, sync, delivered, errors, text: () => doc.getText("body").toString() };
}

test("a record that is not a Yjs update is skipped and reported, and the records around it still arrive", async () => {
  const folder = freshDir();
  const a = watcher(folder);
  await a.sync.start();
  writeFileSync(join(folder, "device-good.ylog"), logFile(typed("GOOD ")));
  writeFileSync(join(folder, "device-evil.ylog"), logFile(typed("BEFORE "), NOT_AN_UPDATE, typed("AFTER ")));
  await a.sync.scan();
  assert.ok(a.delivered.every(isUpdate), "only Yjs updates are handed on");
  for (const word of ["GOOD ", "BEFORE ", "AFTER "]) assert.ok(a.text().includes(word), `${word}arrived`);
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0]!, /device-evil\.ylog.*not a script change/);

  // The reader moved past the bad record: a later record in the same log arrives, and nothing is reported twice.
  writeFileSync(join(folder, "device-evil.ylog"), logFile(typed("BEFORE "), NOT_AN_UPDATE, typed("AFTER "), typed("LATER ")));
  await a.sync.scan();
  assert.ok(a.text().includes("LATER "));
  assert.equal(a.errors.length, 1);
  await a.sync.stop();
});

test("starting with a bad record in another device's log still returns the good records", async () => {
  const folder = freshDir();
  writeFileSync(join(folder, "device-evil.ylog"), logFile(NOT_AN_UPDATE, typed("GOOD ")));
  const a = watcher(folder);
  const updates = await a.sync.start();
  assert.equal(updates.length, 1);
  assert.ok(updates.every(isUpdate));
  // A second window opening the same script reads every log from the start.
  assert.ok((await a.sync.snapshot()).every(isUpdate));
  await a.sync.stop();
});

test("a bad record in this device's own log does not stop sync from starting, and the log is rewritten clean", async () => {
  const folder = freshDir();
  const own = join(folder, "device-aaaa.ylog");
  writeFileSync(own, logFile(typed("MINE "), NOT_AN_UPDATE));
  const a = watcher(folder);
  const updates = await a.sync.start(typed("OPENED "));
  // What the log had that the opened script lacks comes back, as before.
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  assert.ok(doc.getText("body").toString().includes("MINE "));
  const records = parseLog(new Uint8Array(readFileSync(own))).records;
  assert.ok(records.length > 0 && records.every(isUpdate));
  const rebuilt = new Y.Doc();
  for (const record of records) Y.applyUpdate(rebuilt, record);
  assert.ok(rebuilt.getText("body").toString().includes("MINE ") && rebuilt.getText("body").toString().includes("OPENED "));
  await a.sync.scan();
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0]!, /own log.*not a script change/);
  await a.sync.stop();
});

test("a record in this device's own log that decodes but cannot be applied does not stop sync from starting", async () => {
  const folder = freshDir();
  const own = join(folder, "device-aaaa.ylog");
  // Decodes as an update, and names a parent that does not exist.
  const unappliable = new Uint8Array([1, 1, 7, 0, 132, 7, 10, 1, 120, 0]);
  assert.ok(isUpdate(unappliable));
  writeFileSync(own, logFile(typed("MINE "), unappliable));
  const a = watcher(folder);
  const updates = await a.sync.start(typed("OPENED "));
  const doc = new Y.Doc();
  for (const update of updates) {
    try {
      Y.applyUpdate(doc, update);
    } catch {
      // The window applies each on its own and skips one that fails.
    }
  }
  assert.ok(doc.getText("body").toString().includes("MINE "));
  await a.sync.append([typed("LATER ")]);
  await a.sync.stop();
});

test("a log too large to read is skipped and reported while the other logs are still read", async () => {
  const folder = freshDir();
  const a = watcher(folder);
  await a.sync.start();
  // A sparse file: free to make, and past the 2 GiB that can be read into memory at once.
  const huge = join(folder, "device-huge.ylog");
  writeFileSync(huge, logFile(typed("HUGE ")));
  truncateSync(huge, 2 ** 31 + 1);
  writeFileSync(join(folder, "device-good.ylog"), logFile(typed("GOOD ")));
  await a.sync.scan();
  assert.ok(a.text().includes("GOOD "));
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0]!, /device-huge\.ylog.*larger than 64 MB/);
  // Still skipped, still reported once, and the other log keeps syncing.
  writeFileSync(join(folder, "device-good.ylog"), logFile(typed("GOOD "), typed("MORE ")));
  await a.sync.scan();
  assert.ok(a.text().includes("MORE "));
  assert.equal(a.errors.length, 1);
  await a.sync.stop();
});

test("a log that grows after its size was checked is read only up to the size that was checked", async () => {
  // Folder sync checks a log's size on the open file and then reads it. Someone who can write the folder can grow the
  // file in between (a sparse file costs nothing), so the read takes the checked size and no more.
  const folder = freshDir();
  const path = join(folder, "device-grow.ylog");
  writeFileSync(path, logFile(typed("FIRST ")));
  const opened = (await openForRead(path))!;
  try {
    const size = opened.info.size;
    truncateSync(path, 300 * 1024 * 1024);
    const bytes = await opened.readFirst(size);
    assert.equal(bytes.length, size);
    assert.equal(parseLog(bytes).records.length, 1);
    // A file that shrank gives what is left.
    truncateSync(path, 10);
    assert.equal((await opened.readFirst(size)).length, 10);
  } finally {
    await opened.close();
  }
});

test("the size limit applies to any log, and a log back under it is read again", async () => {
  const folder = freshDir();
  const a = watcher(folder, { maxLogBytes: 200 });
  await a.sync.start();
  const big = join(folder, "device-big.ylog");
  writeFileSync(big, logFile(typed("x".repeat(400))));
  await a.sync.scan();
  assert.equal(a.text(), "");
  assert.equal(a.errors.length, 1);
  writeFileSync(big, logFile(typed("SMALL ")));
  await a.sync.scan();
  assert.ok(a.text().includes("SMALL "));
  await a.sync.stop();
});

// Root reads a file of any mode, so there the unreadable log would simply be read.
test("a log that cannot be read does not lose the records of the logs read before it", { skip: process.getuid?.() === 0 }, async () => {
  const folder = freshDir();
  const a = watcher(folder);
  await a.sync.start();
  writeFileSync(join(folder, "device-good.ylog"), logFile(typed("GOOD ")));
  writeFileSync(join(folder, "device-zzzz.ylog"), logFile(typed("LOCKED ")), { mode: 0o000 });
  await a.sync.scan();
  assert.ok(a.text().includes("GOOD "));
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0]!, /could not read the log device-zzzz\.ylog/);
  await a.sync.stop();
});
