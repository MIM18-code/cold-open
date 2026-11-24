// Scripts in a shared folder. A co-writer who can write the folder can swap a script the writer opened for a link to
// another file on this Mac, swap a folder above it, plant a link where a save puts its temporary file, or leave a
// FIFO. The main process's file access (grants.ts, safe-fs.ts) must never follow such a swap or hang on it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PathGrants } from "../src/main/grants.ts";
import { UnsafeFileError, appendRegular, openForRead, readChosenFile, readRegular, replaceFile, truncateRegular, writeNewFile } from "../src/main/safe-fs.ts";

const temp = mkdtempSync(join(tmpdir(), "screenplay-shared-files-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let caseCount = 0;
function layout() {
  const root = join(temp, `case-${++caseCount}`);
  const shared = join(root, "Dropbox", "Shared");
  const privateDir = join(root, "Private");
  mkdirSync(shared, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  const secret = join(privateDir, "Secret.fdx");
  writeFileSync(secret, "SECRET PAGES");
  const draft = join(shared, "Draft.fdx");
  writeFileSync(draft, "SHARED PAGES");
  return { root, shared, privateDir, secret, draft };
}

test("a granted script swapped for a link to another file is no longer granted", () => {
  const { secret, draft } = layout();
  const grants = new PathGrants();
  grants.allow(draft);
  assert.equal(grants.allows(draft), true);
  rmSync(draft);
  symlinkSync(secret, draft);
  assert.equal(grants.allows(draft), false);
  // Put back as a regular file (a save renames over the link), it is granted again.
  rmSync(draft);
  writeFileSync(draft, "SHARED PAGES");
  assert.equal(grants.allows(draft), true);
  assert.equal(grants.allows(join(draft, "..", "Other.fdx")), false);
});

test("a link the writer already had keeps working, and a save that replaces it with a file is fine", () => {
  const { shared, privateDir } = layout();
  const real = join(privateDir, "Mine.fdx");
  writeFileSync(real, "MINE");
  const link = join(shared, "Mine.fdx");
  symlinkSync(real, link);
  const grants = new PathGrants();
  grants.allow(link);
  assert.equal(grants.allows(link), true);
  // The file it points at is rewritten by its owner (a rename in place): still the same path, still granted.
  writeFileSync(`${real}.new`, "MINE, REVISED");
  renameSync(`${real}.new`, real);
  assert.equal(grants.allows(link), true);
  // Pointed somewhere else afterwards: refused.
  const other = join(privateDir, "Other.fdx");
  writeFileSync(other, "OTHER");
  rmSync(link);
  symlinkSync(other, link);
  assert.equal(grants.allows(link), false);
  // A save renames a file over the link: a regular file at the path itself is fine.
  rmSync(link);
  writeFileSync(link, "MINE, SAVED");
  assert.equal(grants.allows(link), true);
});

test("a folder above a granted script swapped for a link is no longer granted", () => {
  const { root, shared, privateDir, draft } = layout();
  writeFileSync(join(privateDir, "Draft.fdx"), "SECRET IN THE SAME NAME");
  const grants = new PathGrants();
  grants.allow(draft);
  renameSync(shared, join(root, "moved"));
  symlinkSync(privateDir, shared);
  assert.equal(grants.allows(draft), false);
});

test("a Save As target is granted until someone plants a link there", () => {
  const { shared, secret } = layout();
  const target = join(shared, "New.fdx");
  const grants = new PathGrants();
  grants.allow(target);
  assert.equal(grants.allows(target), true);
  symlinkSync(secret, target);
  assert.equal(grants.allows(target), false);
  rmSync(target);
  writeFileSync(target, "SAVED");
  assert.equal(grants.allows(target), true);
});

test("a save never writes through a link planted at its temporary name, and replaces a link at the destination", async () => {
  const { shared, secret, draft } = layout();
  const planted = join(shared, "Draft.fdx.saving-1");
  symlinkSync(secret, planted);
  await assert.rejects(replaceFile(draft, planted, "NEW PAGES"), { code: "EEXIST" });
  assert.equal(readFileSync(secret, "utf8"), "SECRET PAGES");
  assert.equal(readFileSync(draft, "utf8"), "SHARED PAGES");

  rmSync(draft);
  symlinkSync(secret, draft);
  await replaceFile(draft, join(shared, "Draft.fdx.saving-2"), "NEW PAGES");
  assert.equal(readFileSync(secret, "utf8"), "SECRET PAGES");
  assert.ok(lstatSync(draft).isFile());
  assert.equal(readFileSync(draft, "utf8"), "NEW PAGES");
  await assert.rejects(writeNewFile(draft, "AGAIN"), { code: "EEXIST" });
});

test("reads refuse FIFOs at once, and the no-follow helpers refuse links", async () => {
  const { shared, secret } = layout();
  const fifo = join(shared, "Stuck.fdx");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(readChosenFile(fifo), UnsafeFileError);
  await assert.rejects(readRegular(fifo), UnsafeFileError);
  await assert.rejects(appendRegular(fifo, new Uint8Array([1])), UnsafeFileError);

  const link = join(shared, "Link.fdx");
  symlinkSync(secret, link);
  // A file the writer chose may be a link; the folder sync helpers never follow one.
  assert.equal(new TextDecoder().decode(await readChosenFile(link)), "SECRET PAGES");
  await assert.rejects(readRegular(link), UnsafeFileError);
  await assert.rejects(appendRegular(link, new Uint8Array([1])), UnsafeFileError);
  assert.equal(readFileSync(secret, "utf8"), "SECRET PAGES");
  assert.equal(await readRegular(join(shared, "missing.ylog")), null);
  assert.equal(await appendRegular(join(shared, "missing.ylog"), new Uint8Array([1])), false);
});

test("truncating cuts only the file that was read, and never a link, a second name, a FIFO or a file swapped in", async () => {
  const { shared, secret } = layout();
  const log = join(shared, "device.ylog");
  writeFileSync(log, "0123456789");
  const id = () => { const info = statSync(log); return { dev: info.dev, ino: info.ino }; };
  assert.equal(await truncateRegular(log, 6, id()), true);
  assert.equal(readFileSync(log, "utf8"), "012345");
  // It only shortens: a file that is already shorter is left as it is.
  assert.equal(await truncateRegular(log, 9, id()), false);
  assert.equal(readFileSync(log, "utf8"), "012345");
  assert.equal(await truncateRegular(join(shared, "missing.ylog"), 2, id()), false);

  // Another file put at the path since the read: not the one the length was worked out for.
  const read = id();
  rmSync(log);
  writeFileSync(join(shared, "holder"), "keeps the old inode number from being reused");
  writeFileSync(log, "ANOTHER FILE");
  assert.equal(await truncateRegular(log, 3, read), false);
  assert.equal(readFileSync(log, "utf8"), "ANOTHER FILE");

  // A link to a file outside the folder, a second name for one, and a FIFO are refused before anything is cut.
  rmSync(log);
  symlinkSync(secret, log);
  const outside = statSync(secret);
  await assert.rejects(truncateRegular(log, 2, { dev: outside.dev, ino: outside.ino }), UnsafeFileError);
  rmSync(log);
  linkSync(secret, log);
  await assert.rejects(truncateRegular(log, 2, { dev: outside.dev, ino: outside.ino }), UnsafeFileError);
  rmSync(log);
  execFileSync("mkfifo", [log]);
  await assert.rejects(truncateRegular(log, 0, read), UnsafeFileError);
  assert.equal(readFileSync(secret, "utf8"), "SECRET PAGES");
});

test("an append that names the file it expects writes nothing to another file or another length", async (t) => {
  const { shared } = layout();
  const log = join(shared, "device.ylog");
  writeFileSync(log, "0123");
  const info = statSync(log);
  const data = new TextEncoder().encode("45");
  assert.equal(await appendRegular(log, data, { dev: info.dev, ino: info.ino, size: 3 }), false, "not the length it was cut to");
  assert.equal(readFileSync(log, "utf8"), "0123");
  assert.equal(await appendRegular(log, data, { dev: info.dev, ino: info.ino, size: 4 }), true);
  assert.equal(readFileSync(log, "utf8"), "012345");
  rmSync(log);
  writeFileSync(join(shared, "holder"), "keeps the old inode number from being reused");
  writeFileSync(log, "012345");
  assert.equal(await appendRegular(log, data, { dev: info.dev, ino: info.ino, size: 6 }), false, "another file at the path");
  assert.equal(readFileSync(log, "utf8"), "012345");

  // Replaced while the append is writing: the bytes went to the old file, so it does not count as appended.
  const now = statSync(log);
  const probe = await open(log, "r");
  const handle = Object.getPrototypeOf(probe) as { writeFile: (data: Uint8Array) => Promise<void> };
  await probe.close();
  const write = handle.writeFile;
  const swap = t.mock.method(handle, "writeFile", async function (this: unknown, bytes: Uint8Array) {
    await write.call(this, bytes);
    writeFileSync(join(shared, "copy.ylog"), "A COPY SYNC PUT BACK");
    renameSync(join(shared, "copy.ylog"), log);
  });
  assert.equal(await appendRegular(log, data, { dev: now.dev, ino: now.ino, size: 6 }), false);
  swap.mock.restore();
  assert.equal(readFileSync(log, "utf8"), "A COPY SYNC PUT BACK");
});

test("a capped read refuses a file that grew past its limit after its size was checked", async () => {
  const { draft } = layout();
  const opened = (await openForRead(draft))!;
  assert.ok(opened.info.size <= 12);
  writeFileSync(draft, "x".repeat(1000), { flag: "a" });
  await assert.rejects(opened.read(12), /size limit/);
  await opened.close();
  await assert.rejects(readChosenFile(draft, 12), /size limit/);
  assert.equal(new TextDecoder().decode(await readChosenFile(draft, 2000)).slice(0, 12), "SHARED PAGES");
});

test("search read grants cannot write until opened and reject a swapped link", () => {
  const { draft, secret } = layout(), grants = new PathGrants();
  grants.allow(draft, "read");
  assert.equal(grants.allows(draft, "read"), true);
  assert.equal(grants.allows(draft), false);
  grants.allow(draft);
  assert.equal(grants.allows(draft), true);
  grants.allow(draft, "read");
  assert.equal(grants.allows(draft), true, "searching an open document must not revoke its write grant");
  rmSync(draft);
  symlinkSync(secret, draft);
  assert.equal(grants.allows(draft, "read"), false);
  grants.allow(draft, "read");
  assert.equal(grants.allows(draft, "read"), true);
  assert.equal(grants.allows(draft), false, "a new search grant cannot inherit a stale write grant");
});
