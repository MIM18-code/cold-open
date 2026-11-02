// A second launch on the same profile hands its file to the running copy and exits, so two processes never share
// one ChatGPT sign-in or settings file. A separate profile (every other test) still gets its own copy.
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFdx } from "@screenplay/engine";
import { close, launch } from "./helpers.ts";

test("a second copy on the same profile hands its script to the first and exits", async () => {
  const first = await launch();
  try {
    const dir = mkdtempSync(join(tmpdir(), "coldopen-second-"));
    const script = join(dir, "Handed Over.fdx");
    writeFileSync(script, writeFdx({ titlePage: [], paragraphs: [
      { id: "s", type: "sceneHeading", sceneId: "s", runs: [{ text: "INT. DINER - NIGHT" }] },
      { id: "a", type: "action", runs: [{ text: "The second copy never opens a window." }] },
    ] }));
    const electron = createRequire(import.meta.url)("electron") as unknown as string;
    const second = spawn(electron, [join(import.meta.dirname, ".."), `--user-data-dir=${first.userData}`, script],
      { env: { ...process.env, SCREENPLAY_E2E: "1" }, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => second.on("exit", resolve));
    expect(code).toBe(0);
    await expect.poll(() => first.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).join(" | ")), { timeout: 15_000 })
      .toContain("Handed Over");
  } finally { await close(first.electronApp, first.page); }
});
