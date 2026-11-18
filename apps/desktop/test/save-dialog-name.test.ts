// A save or export dialog starts where its default path points. The script's name feeds that path, and a guest's
// window takes its name from the host, so neither the name nor the dialog may carry a folder.
import assert from "node:assert/strict";
import { test } from "node:test";

import { plainFileName, saveDialogName } from "../src/shared/file-name.ts";
import { hostDocName } from "../src/renderer/features/collab/presence.ts";

const hostNamed = (name: unknown) => hostDocName(new Map<number, unknown>([[7, { user: { name: "Host", color: "#b5442c" }, cursor: null, doc: { name } }]]), 3);

test("a host's document name reaches the guest without any path in it", () => {
  for (const name of ["../../Library/LaunchAgents/agent", "/Users/someone/.ssh/authorized_keys", "..\\..\\Start Menu\\run", "~/Documents/../.zshrc"]) {
    const got = hostNamed(name);
    assert.ok(got && !/[/\\]/.test(got) && !got.startsWith("."), `${name} -> ${got}`);
  }
  assert.equal(hostNamed("Pilot"), "Pilot");
  assert.equal(hostNamed("Pilot: Part 2 (blue)"), "Pilot: Part 2 (blue)");
  assert.equal(hostNamed("AC/DC"), "AC DC");
  // Nothing usable left: the guest keeps its own title.
  assert.equal(hostNamed("../.."), null);
  assert.equal(hostNamed("/"), null);
});

test("the save dialog takes a file name from the page, never a folder", () => {
  assert.equal(saveDialogName("Pilot.screenplay"), "Pilot.screenplay");
  assert.equal(saveDialogName("../../Library/LaunchAgents/agent.fdx"), "agent.fdx");
  assert.equal(saveDialogName("/Users/someone/.ssh/authorized_keys"), "authorized_keys");
  assert.equal(saveDialogName("C:\\Users\\someone\\run.pdf"), "run.pdf");
  assert.equal(saveDialogName("/tmp/.hidden.fdx"), "hidden.fdx");
  assert.equal(saveDialogName("Pilot\u0000.pdf"), "Pilot.pdf");
  for (const empty of ["", "/", "..", "../", ".", 7, null, undefined, { path: "/etc" }]) assert.equal(saveDialogName(empty), undefined);
});

test("a plain name is left as the writer typed it", () => {
  assert.equal(plainFileName("The Long Goodbye (rev. 3)"), "The Long Goodbye (rev. 3)");
  assert.equal(plainFileName("  Draft  "), "Draft");
});
