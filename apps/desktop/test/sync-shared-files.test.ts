// Scripts in a shared folder. A co-writer who can write the folder can swap a script the writer opened for a link to
// another file on this Mac, swap a folder above it, plant a link where a save puts its temporary file, or leave a
// FIFO. The main process's file access (grants.ts, safe-fs.ts) must never follow such a swap or hang on it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PathGrants } from "../src/main/grants.ts";
import { UnsafeFileError, appendRegular, readChosenFile, readRegular, replaceFile, writeNewFile } from "../src/main/safe-fs.ts";

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
