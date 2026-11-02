import { expect, test } from "@playwright/test";

import { close, launch } from "./helpers.ts";

test("the app opens a window with the shell", async () => {
  const { electronApp, page } = await launch();
  await expect(page.locator(".titlebar-name")).toHaveText(/Untitled/);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
  await electronApp.close();
});

test("a 900 by 700 window keeps every writing panel discoverable", async () => {
  const { electronApp, page } = await launch();
  try {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 700));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900);
    await page.waitForSelector(".editor-pm");
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.togglePanel(app.panels.find((p: any) => p.side === "left").id, true);
      app.togglePanel(app.panels.find((p: any) => p.side === "right").id, true);
    });
    await expect(page.locator(".sidepanel")).toHaveCount(2);
    await expect(page.locator(".sidepanel-left")).toBeHidden();
    // Tabs stay on one row; additional panels are available through More.
    const strip = page.getByRole("tablist", { name: "right panels" });
    const first = strip.getByRole("tab").first();
    await first.focus();
    await first.press("End");
    const last = strip.getByRole("tab").last();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute("aria-selected", "true");
    const geometry = await strip.evaluate((element) => {
      const tabs = Array.from(element.querySelectorAll('[role="tab"]'));
      const selected = element.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        rows: new Set(tabs.map((tab) => tab.getBoundingClientRect().top)).size,
        visible: selected.left >= box.left && selected.right <= box.right,
      };
    });
    expect(geometry).toEqual({ rows: 1, visible: true });
    await last.press("Home");
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("aria-selected", "true");
    const more = page.getByRole("button", { name: "More", exact: true });
    await more.click();
    const menu = page.getByRole("menu", { name: "More panels" });
    const available = [
      ...await strip.getByRole("tab").allTextContents(),
      ...await menu.getByRole("menuitem").allTextContents(),
    ].sort();
    const registered = await page.evaluate(() => (window as any).__app.panels
      .filter((panel: any) => panel.side === "right").map((panel: any) => panel.title).sort());
    expect(available).toEqual(registered);
    await menu.getByRole("menuitem", { name: "Phone", exact: true }).click();
    await expect(strip.getByRole("tab", { name: "Phone", exact: true })).toBeFocused();
    await expect(strip.getByRole("tab", { name: "Phone", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(menu).toBeHidden();
    await more.focus();
    await more.press("ArrowDown");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await menu.getByRole("menuitem").first().press("End");
    await expect(menu.getByRole("menuitem").last()).toBeFocused();
    await menu.getByRole("menuitem").last().press("Escape");
    await expect(more).toBeFocused();
    await expect(menu).toBeHidden();
    const clippedLabels = await page.locator(".titlebar .header-tool, .sidepanel-tabs button").evaluateAll((buttons) =>
      buttons.filter((button) => button.scrollWidth > button.clientWidth + 1).map((button) => button.textContent?.trim()));
    expect(clippedLabels, "header actions and panel tabs must show their complete labels").toEqual([]);
  } finally {
    await close(electronApp, page);
  }
});


test("Fit width protects readability and restores the scene sidebar without changing preferences", async () => {
  const { electronApp, page } = await launch();
  try {
    const resize = async (width: number) => {
      await electronApp.evaluate(({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(value, 700);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    };
    await resize(900);
    await page.waitForSelector(".editor-pm");
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.togglePanel("navigator", true);
      app.togglePanel("proofread", true);
    });
    const scenes = page.locator(".sidepanel-left");
    const toggle = page.getByRole("button", { name: "Toggle left sidebar" });
    const scale = () => page.locator(".editor-view").evaluate((element) =>
      Number(getComputedStyle(element).getPropertyValue("--editor-zoom")));
    const preferredPanel = () => page.evaluate(() => (window as any).__app.ui.leftPanel);
    await expect(scenes).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await preferredPanel()).toBe("navigator");
    await expect.poll(scale).toBeGreaterThanOrEqual(0.67);

    await expect.poll(() => page.locator(".editor-scroll").evaluate((element) =>
      element.scrollWidth - element.clientWidth)).toBe(0);
    const margins = await page.locator(".editor-scroll").evaluate((element) => {
      const page = element.querySelector(".editor-sheet")!.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      return [page.left - viewport.left, viewport.left + element.clientWidth - page.right];
    });
    expect(Math.abs(margins[0]! - margins[1]!)).toBeLessThanOrEqual(1);
    await resize(1280);
    await expect(scenes).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await resize(900);
    await expect(scenes).toBeHidden();
    await toggle.click();
    await expect(scenes).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(scale).toBeGreaterThanOrEqual(0.67);
    await expect.poll(() => page.locator(".editor-scroll").evaluate((element) =>
      element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);

    await expect.poll(() => page.locator(".editor-scroll").evaluate((element) =>
      (element as HTMLElement).offsetHeight - element.clientHeight)).toBeGreaterThan(0);
    await page.locator(".editor-scroll").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await page.locator(".editor-scroll").evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    // Closing the assistant resets the temporary override; reopening protects the page again.
    await page.evaluate(() => (window as any).__app.togglePanel("proofread", false));
    await expect(page.locator(".sidepanel-right")).toHaveCount(0);
    await expect(scenes).toBeVisible();
    await page.evaluate(() => (window as any).__app.togglePanel("proofread", true));
    await expect(scenes).toBeHidden();
    await page.evaluate(() => (window as any).__app.togglePanel("proofread", false));
    await expect(page.locator(".sidepanel-right")).toHaveCount(0);
    await expect(scenes).toBeVisible();
    expect(await preferredPanel()).toBe("navigator");

    // An intentional close is a real preference, not a temporary collapse to restore later.
    await toggle.click();
    await resize(1280);
    await expect(scenes).toHaveCount(0);
    expect(await preferredPanel()).toBeNull();
  } finally {
    await close(electronApp, page);
  }
});
