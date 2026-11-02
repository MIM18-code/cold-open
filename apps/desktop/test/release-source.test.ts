import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JavaScript release script
import { publicPath } from "../../../scripts/release-source.mjs";

test("the public source snapshot takes the app, packages, helpers and notices, not internal notes or build output", () => {
  for (const path of ["apps/desktop/src/main/index.ts", "apps/desktop/test/autocomplete.test.ts", "packages/engine/src/fdx.ts",
    "packages/engine/test/fixtures/synthetic.fdx", "native/voice-helper/Package.swift", "LICENSE", "THIRD_PARTY_NOTICES.md",
    "docs/NATIVE_SOURCE.md", "docs/sync-protocol.md", "docs/phone-remote/script-light.png", "scripts/verify-release.mjs", "scripts/build-helpers.sh"]) assert.ok(publicPath(path), path);
  for (const path of ["docs/product-decisions.md", "docs/Backlot_Writers_Block_integration_plan.docx", "docs/verification/consolidation.json",
    "bench/e2e.ts", "terra-prompt-new-features.md", "apps/desktop/release/ColdOpen.dmg", "apps/desktop/dist/main/index.js",
    "native/voice-helper/.build/release/voice-helper", ".claude/worktrees/x/README.md", "README.md"]) assert.ok(!publicPath(path), path);
});

test("the private-text list stays out of the public source and out of the public scripts", async () => {
  const { readFileSync } = await import("node:fs");
  assert.ok(!publicPath("scripts/private-text.json"));
  const list: string[] = JSON.parse(readFileSync(new URL("../../../scripts/private-text.json", import.meta.url), "utf8")).patterns;
  const verifier = readFileSync(new URL("../../../scripts/verify-release.mjs", import.meta.url), "utf8");
  for (const pattern of list) assert.ok(!new RegExp(pattern).test(verifier), pattern);
});
