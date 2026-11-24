// What the page sends to the main process is read as data: a tampered page can send anything.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fileWriter } from "../src/main/file-writer.ts";
import { isWebUrl, menuCommands } from "../src/main/page-input.ts";

test("only an http or https address with a host opens in the browser", () => {
  for (const url of ["https://example.com", "http://example.com/a?b", "HTTPS://example.com"]) assert.equal(isWebUrl(url), true, url);
  for (const url of ["https:example.com", "https:/example.com", "https://", "https:// example.com", "file:///etc/hosts", "javascript:alert(1)", "", 7, null, undefined])
    assert.equal(isWebUrl(url), false, String(url));
});

test("a menu list that is not a list of commands builds no menu items", () => {
  assert.deepEqual(menuCommands("File"), []);
  assert.deepEqual(menuCommands({ length: 1, 0: { id: "a", label: "A", menu: "File" } }), []);
  const kept = menuCommands([
    { id: "file.save", label: "Save", menu: "File", accelerator: "CmdOrCtrl+S", group: "save", enabled: true, checked: false },
    { id: "x", label: "No such menu", menu: "Window" },
    { id: 4, label: "Bad id", menu: "File" },
    { id: "y", label: { toString: () => "boom" }, menu: "File" },
    null, "text", 3,
    { id: "edit.copy", label: "Copy", menu: "Edit", accelerator: 12, enabled: "yes", click: () => undefined },
  ]);
  assert.deepEqual(kept, [
    { id: "file.save", label: "Save", menu: "File", accelerator: "CmdOrCtrl+S", group: "save", enabled: true, checked: false },
    { id: "edit.copy", label: "Copy", menu: "Edit" },
  ]);
});

test("a write that waited in the queue checks its destination again before it writes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "file-writer-"));
  const path = join(folder, "Script.screenplay");
  try {
    let allowed = true;
    const write = fileWriter(() => allowed);
    const first = write(null, path, "one");
    // Asked for while the folder was still allowed; by the time it runs, it is not.
    const second = write(null, path, "two");
    await first;
    allowed = false;
    await assert.rejects(second, /Save dialog/);
    assert.equal(readFileSync(path, "utf8"), "one", "the refused write left the file alone");
    assert.throws(() => write(null, path, "three"), /Save dialog/);
    allowed = true;
    await write(null, path, "four");
    assert.equal(readFileSync(path, "utf8"), "four");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
