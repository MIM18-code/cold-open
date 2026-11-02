import { expect, test } from "@playwright/test";
import { close, launch } from "./helpers.ts";

test("Mac accent reaches isolated renderers and live changes keep yellow and graphite readable", async () => {
  const { electronApp, page } = await launch();
  try {
    const accent = await electronApp.evaluate(({ systemPreferences }) => systemPreferences.getAccentColor());
    const rgb = (hex: string) => `rgb(${[0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
    await page.evaluate(() => (window as any).__app.togglePanel("rewrite", true));
    await expect.poll(() => page.locator(".button.primary:not(:disabled)").first().evaluate((element) =>
      getComputedStyle(element).backgroundColor)).toBe(rgb(accent));
    const support = await page.evaluate(() => ({
      supportsKeyword: CSS.supports("color", "AccentColor"),
      resolvedSource: document.documentElement.style.getPropertyValue("--native-accent"),
      nodeAvailable: typeof (window as any).require !== "undefined",
    }));
    await test.info().attach("system-accent-resolution", {
      body: JSON.stringify({ accent, ...support }), contentType: "application/json",
    });
    expect(support.nodeAvailable).toBe(false);

    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      for (const hex of ["0066ccff", "ffcc00ff", "808080ff"]) {
        // Simulate the Electron event, without changing the machine's System Settings.
        await electronApp.evaluate(({ systemPreferences }, value) => {
          systemPreferences.getAccentColor = () => value;
          systemPreferences.emit("accent-color-changed", {}, value);
        }, hex);
        const neutral = theme === "light"
          ? ["rgb(255, 255, 255)", "rgb(23, 25, 28)"]
          : ["rgb(38, 40, 43)", "rgb(233, 234, 236)"];
        for (const selector of [".write-primary", ".panel-tab.on"]) {
          await expect.poll(() => page.locator(selector).evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.backgroundColor, style.color];
          })).toEqual(neutral);
        }
        const text = hex === "0066ccff" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
        for (const selector of [".button.primary:not(:disabled)"]) {
          await expect.poll(() => page.locator(selector).first().evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.backgroundColor, style.color];
          })).toEqual([rgb(hex), text]);
        }
      }
    }
  } finally {
    await close(electronApp, page);
  }
});
