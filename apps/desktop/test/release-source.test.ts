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
    "native/voice-helper/.build/release/voice-helper", ".claude/worktrees/x/README.md", "scripts/private-text.json", "README.md"]) assert.ok(!publicPath(path), path);
});

test("private audit patterns stay out of the public verifier", async (t) => {
  const { existsSync, readFileSync } = await import("node:fs");
  const path = new URL("../../../scripts/private-text.json", import.meta.url);
  if (!existsSync(path)) { t.skip("Private audit patterns are intentionally absent from the public source."); return; }
  const list: string[] = JSON.parse(readFileSync(path, "utf8")).patterns;
  const verifier = readFileSync(new URL("../../../scripts/verify-release.mjs", import.meta.url), "utf8");
  for (const pattern of list) assert.ok(!new RegExp(pattern).test(verifier), pattern);
});
