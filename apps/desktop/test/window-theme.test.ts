import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { windowBackground } from "../src/main/window-theme.ts";

const css = readFileSync(new URL("../src/renderer/shell/styles.css", import.meta.url), "utf8");
const light = /--bg:\s*(#[\da-f]+)/i.exec(css)![1];
const dark = /:root\[data-theme="dark"\]\s*\{\s*--bg:\s*(#[\da-f]+)/i.exec(css)![1];

test("window fill matches renderer light and dark backgrounds with explicit theme overrides", () => {
  assert.equal(windowBackground("light", true), light);
  assert.equal(windowBackground("dark", false), dark);
  for (const setting of ["system", undefined, "invalid"]) {
    assert.equal(windowBackground(setting, false), light);
    assert.equal(windowBackground(setting, true), dark);
  }
});
