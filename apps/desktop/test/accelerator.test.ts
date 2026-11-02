import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesKey, type KeyPress } from "../src/shared/accelerator.ts";

const press = (key: string, code: string, mods: Partial<KeyPress> = {}): KeyPress =>
  ({ key, code, meta: false, control: false, alt: false, shift: false, ...mods });

test("menu accelerators match the key press that the main process sees", () => {
  assert.equal(matchesKey(press("b", "KeyB", { meta: true }), "CmdOrCtrl+B", true), true);
  assert.equal(matchesKey(press("b", "KeyB", { control: true }), "CmdOrCtrl+B", true), false, "Ctrl is not Cmd on a Mac");
  assert.equal(matchesKey(press("b", "KeyB", { control: true }), "CmdOrCtrl+B", false), true);
  assert.equal(matchesKey(press("b", "KeyB", { meta: true, shift: true }), "CmdOrCtrl+B", true), false, "extra modifiers do not match");
  assert.equal(matchesKey(press("Z", "KeyZ", { meta: true, shift: true }), "CmdOrCtrl+Shift+Z", true), true);
  assert.equal(matchesKey(press("1", "Digit1", { meta: true }), "CmdOrCtrl+1", true), true);
  assert.equal(matchesKey(press("1", "Digit1", { meta: true, control: true }), "Ctrl+Cmd+1", true), true);
  // Option changes the typed character on a Mac; the physical key still matches.
  assert.equal(matchesKey(press("º", "Digit0", { meta: true, alt: true }), "CmdOrCtrl+Alt+0", true), true);
  assert.equal(matchesKey(press("ƒ", "KeyF", { meta: true, alt: true }), "CmdOrCtrl+Alt+F", true), true);
  assert.equal(matchesKey(press("=", "Equal", { meta: true }), "CmdOrCtrl+=", true), true);
  assert.equal(matchesKey(press("-", "Minus", { meta: true }), "CmdOrCtrl+-", true), true);
  assert.equal(matchesKey(press(",", "Comma", { meta: true }), "CmdOrCtrl+,", true), true);
  assert.equal(matchesKey(press("+", "Equal", { meta: true, shift: true }), "CmdOrCtrl+Shift+Plus", true), true);
  assert.equal(matchesKey(press("b", "KeyB"), "CmdOrCtrl+B", true), false, "a plain letter is typing, not a command");
});

test("on other layouts the typed character decides, except where Option or the digit row changed it", () => {
  // Dvorak puts ";" where QWERTY has Z and "b" where QWERTY has N.
  assert.equal(matchesKey(press(";", "KeyZ", { meta: true }), "CmdOrCtrl+;", true), true);
  assert.equal(matchesKey(press(";", "KeyZ", { meta: true }), "CmdOrCtrl+Z", true), false, "Cmd+; on Dvorak is not Undo");
  assert.equal(matchesKey(press("b", "KeyN", { meta: true }), "CmdOrCtrl+B", true), true);
  assert.equal(matchesKey(press("b", "KeyN", { meta: true }), "CmdOrCtrl+N", true), false, "Cmd+B on Dvorak is not New");
  // AZERTY types "&" and "é" on the 1 and 2 keys; Cmd+1 and Cmd+2 still set the element type.
  assert.equal(matchesKey(press("&", "Digit1", { meta: true }), "CmdOrCtrl+1", true), true);
  assert.equal(matchesKey(press("é", "Digit2", { meta: true }), "CmdOrCtrl+2", true), true);
  // A layout with no Latin letters (Russian "и" on the B key) falls back to the key's position.
  assert.equal(matchesKey(press("и", "KeyB", { meta: true }), "CmdOrCtrl+B", true), true);
  // A dead key (Option+E on a Mac) also falls back to the position.
  assert.equal(matchesKey(press("Dead", "KeyE", { meta: true, alt: true }), "CmdOrCtrl+Alt+E", true), true);
});

test("navigation key aliases and modified Enter work across native and renderer events", () => {
  assert.equal(matchesKey(press("ArrowUp", "ArrowUp", { meta: true, alt: true }), "CmdOrCtrl+Alt+Up", true), true);
  assert.equal(matchesKey(press("ArrowDown", "ArrowDown", { meta: true, alt: true }), "CmdOrCtrl+Alt+Down", true), true);
  assert.equal(matchesKey(press("Enter", "Enter", { meta: true, shift: true }), "CmdOrCtrl+Shift+Enter", true), true);
  assert.equal(matchesKey(press("Tab", "Tab", { control: true, shift: true }), "Ctrl+Shift+Tab", true), true);
  assert.equal(matchesKey(press("Escape", "Escape"), "Esc", true), true);
});

test("native and renderer accelerator matching leave IME composition keys alone", () => {
  for (const mac of [true, false]) {
    const mods = mac ? { meta: true } : { control: true };
    assert.equal(matchesKey(press("2", "Digit2", { ...mods, composing: true }), "CmdOrCtrl+2", mac), false);
    assert.equal(matchesKey(press("Process", "Digit2", mods), "CmdOrCtrl+2", mac), false);
    assert.equal(matchesKey(press("2", "Digit2", mods), "CmdOrCtrl+2", mac), true);
  }
});
