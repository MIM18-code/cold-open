import assert from "node:assert/strict";
import { test } from "node:test";

import { extractEditCommands, parseEditCommand } from "../src/main/dictation/commands.ts";

test("change X to Y everywhere", () => {
  const command = parseEditCommand("Change Bob to Robert everywhere.");
  assert.deepEqual(command, { kind: "replace", find: "Bob", replacement: "Robert", scope: "script", spoken: "Change Bob to Robert everywhere." });
});

test("replace X with Y", () => {
  const command = parseEditCommand("Replace the window with the door");
  assert.equal(command?.find, "window");
  assert.equal(command?.replacement, "door");
  assert.equal(command?.scope, "script");
});

test("scope words choose the scene", () => {
  assert.equal(parseEditCommand("Change Bob to Robert in this scene.")?.scope, "scene");
  assert.equal(parseEditCommand("In this scene, change Bob to Robert.")?.scope, "scene");
  assert.equal(parseEditCommand("Throughout the script, change Bob to Robert.")?.scope, "script");
  assert.equal(parseEditCommand("Change Bob to Robert throughout the script")?.scope, "script");
});

test("rename, swap, quotes and filler words", () => {
  assert.equal(parseEditCommand("Rename Bob to Robert.")?.replacement, "Robert");
  assert.equal(parseEditCommand("Swap Bob for Robert everywhere.")?.replacement, "Robert");
  assert.equal(parseEditCommand("Please change the name Bob to Robert.")?.find, "Bob");
  assert.equal(parseEditCommand("Change “Old Man Jenkins” to “Mr. Jenkins” everywhere.")?.find, "Old Man Jenkins");
});

test("ordinary writing is not a command", () => {
  assert.equal(parseEditCommand("Maya replaces the battery with a fresh one."), null);
  assert.equal(parseEditCommand("Bob changes to Robert."), null);
  assert.equal(parseEditCommand("Maya says change Bob to Robert."), null);
  assert.equal(parseEditCommand("Change is coming."), null);
  assert.equal(parseEditCommand("Replace it."), null);
});

test("long spans are not commands", () => {
  assert.equal(parseEditCommand("Change the old man walks slowly across the empty parking lot to the diner."), null);
});

test("commands are taken out of a take and the rest is kept in order", () => {
  const { commands, rest } = extractEditCommands(
    "Interior kitchen night. Maya stands at the sink. Change Bob to Robert everywhere. Maya says, I can't do this anymore.");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.find, "Bob");
  assert.equal(rest, "Interior kitchen night. Maya stands at the sink. Maya says, I can't do this anymore.");
});

test("a take that is only a command leaves nothing to format", () => {
  const { commands, rest } = extractEditCommands("Change Bob to Robert everywhere.");
  assert.equal(commands.length, 1);
  assert.equal(rest, "");
});
