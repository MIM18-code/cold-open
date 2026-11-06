// Brainstorm, the button left of Write: one click and the caret is in a fresh note. Typing is the default; the
// microphone never starts by itself. Screenshots are taken when SCREENPLAY_SCREENSHOTS names a folder.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { close, launch } from "./helpers.ts";

const OUT = process.env.SCREENPLAY_SCREENSHOTS;
const KEY = "ControlOrMeta";

const notes = (page: Page) => page.evaluate(() => {
  const meta = (window as any).__app.session.doc.meta as Map<string, any>;
  return [...meta.entries()].filter(([k]) => k.startsWith("workbench.record.")).map(([, v]) => v)
    .map((r) => ({ text: r.text, kind: r.kind, anchor: r.anchor?.paragraphId }));
});

async function shot(page: Page, name: string): Promise<void> {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

test("Brainstorm sits left of Write, opens ready to type, and keeps each idea as a note", async () => {
  const run = await launch();
  try {
    const { page } = run;
    const nav = page.getByRole("navigation", { name: "Writing workspace" });
    const brainstorm = nav.getByRole("button", { name: "Brainstorm" }), write = nav.getByRole("button", { name: "Write" });
    // The app still opens on the script.
    await expect(write).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".editor-pm")).toBeVisible();
    const [b, w] = [await brainstorm.boundingBox(), await write.boundingBox()];
    expect(b!.x).toBeLessThan(w!.x);

    await brainstorm.click();
    const text = page.getByRole("textbox", { name: "New note" });
    await expect(text).toBeFocused();
    await expect(page.getByRole("region", { name: "Brainstorm" }).getByRole("button", { name: "Dictate" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("dialog", { name: "Quick note" })).toHaveCount(0);
    await expect(nav.locator(".plan-trigger")).toHaveText("Plan");
    await expect(nav.locator(".plan-trigger")).not.toHaveClass(/\bon\b/);

    await page.keyboard.type("The garbage truck shows up a day early");
    await expect.poll(() => notes(page)).toEqual([{ text: "The garbage truck shows up a day early", kind: "note", anchor: undefined }]);
    await page.keyboard.press(`${KEY}+Enter`);
    await expect(text).toHaveValue("");
    await expect(text).toBeFocused();
    await expect(page.locator(".brainstorm-list .rewrite-item")).toHaveCount(1);
    await page.keyboard.type("Open on the dumpster");
    await shot(page, "brainstorm");

    // Leaving keeps the note being typed and doesn't carry a floating box over to the script.
    await write.click();
    await expect(page.locator(".editor-pm")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Quick note" })).toHaveCount(0);
    expect((await notes(page)).map((n) => n.text).sort()).toEqual(["Open on the dumpster", "The garbage truck shows up a day early"]);

    // A quick note started on the script is kept, and Brainstorm still opens on a fresh one.
    await page.keyboard.press(`${KEY}+Shift+M`);
    await expect(page.getByRole("dialog", { name: "Quick note" })).toBeVisible();
    await page.keyboard.type("Started on the script");
    await brainstorm.click();
    await expect(text).toHaveValue("");
    await expect(text).toBeFocused();
    await expect.poll(async () => (await notes(page)).map((n) => n.text)).toContain("Started on the script");
    await write.click();

    // Planning views stay in the Plan menu; Brainstorm isn't repeated there.
    await nav.locator(".plan-trigger").click();
    await expect(page.getByRole("menu", { name: "Planning views" }).getByRole("menuitemradio", { name: /Brainstorm/ })).toHaveCount(0);
  } finally { await close(run.electronApp, run.page); }
});
