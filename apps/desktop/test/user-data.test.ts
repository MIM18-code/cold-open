// Renaming the app changes Electron's default settings folder. A Mac with settings in an older folder keeps it.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { legacyUserDataPath } from "../src/main/user-data.ts";

const appData = "/Users/w/Library/Application Support";
const current = join(appData, "Cold Open");
const has = (...folders: string[]) => (folder: string) => folders.map((name) => join(appData, name)).includes(folder);

test("a fresh install uses the Cold Open folder", () => {
  assert.equal(legacyUserDataPath(appData, current, has()), null);
});

test("a Mac with only Screenplay settings keeps the Screenplay folder", () => {
  assert.equal(legacyUserDataPath(appData, current, has("Screenplay")), join(appData, "Screenplay"));
});

test("a Mac with only Inklot settings keeps the Inklot folder", () => {
  assert.equal(legacyUserDataPath(appData, current, has("Inklot")), join(appData, "Inklot"));
});

test("Inklot settings win over older Screenplay settings, as they did before the rename", () => {
  assert.equal(legacyUserDataPath(appData, current, has("Screenplay", "Inklot")), join(appData, "Inklot"));
});

test("a Cold Open folder that already has settings is used as is", () => {
  assert.equal(legacyUserDataPath(appData, current, has("Cold Open", "Inklot", "Screenplay")), null);
});

test("a folder without settings.json is not adopted", () => {
  assert.equal(legacyUserDataPath(appData, current, () => false), null);
});
