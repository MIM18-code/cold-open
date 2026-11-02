// Screenshots of every view, panel, modal and settings section in light and dark, at the default window size and
// a small one, for checking the layout by eye. Hidden windows, as always. Opt in, with a folder for the images:
//   SCREENPLAY_SCREENSHOTS=/tmp/shots npx playwright test e2e/screens.spec.ts
import { test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { close, launch, runCommand } from "./helpers.ts";

const OUT = process.env.SCREENPLAY_SCREENSHOTS;
const SIZES = [[1280, 860], [900, 700]] as const;
const THEMES = ["light", "dark"] as const;
const MODAL_COMMANDS = [
  "reports.open", "reports.sides", "rename.open", "compare.open", "structure.goToScene", "collab.join", "print.print", "title-page.edit", "file.recent",
];

async function size(electronApp: ElectronApplication, width: number, height: number): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height]);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT!, `${name}.png`) });
}

test("screenshots of every surface", async () => {
  test.skip(!OUT, "set SCREENPLAY_SCREENSHOTS to a folder");
  test.setTimeout(600_000);
  mkdirSync(OUT!, { recursive: true });
  const { electronApp, page } = await launch();
  try {
    // The empty first-run script first.
    for (const theme of THEMES) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const [w, h] of SIZES) {
        await size(electronApp, w, h);
        await shot(page, `${theme}-${w}-first-run`);
      }
    }
    // Load the fixture through File > Open so it renders like a real script.
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog;
    }, fileURLToPath(new URL("../../../packages/engine/test/fixtures/synthetic.fountain", import.meta.url)));
    await runCommand(page, "file.open");
    await page.waitForTimeout(800);
    const views: string[] = await page.evaluate(() => (window as any).__app.views.map((v: any) => v.id));
    const panels: string[] = await page.evaluate(() => (window as any).__app.panels.filter((p: any) => p.side === "right").map((p: any) => p.id));
    const sections: string[] = await page.evaluate(() => (window as any).__app.settingsSections.map((s: any) => s.id));

    for (const theme of THEMES) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const [w, h] of SIZES) {
        await size(electronApp, w, h);
        const name = (what: string) => `${theme}-${w}-${what}`;
        for (const view of views) {
          await page.evaluate((v) => (window as any).__app.setView(v), view);
          await shot(page, name(`view-${view}`));
        }
        await page.evaluate(() => (window as any).__app.setView("script"));
        for (const panel of panels) {
          await page.evaluate((p) => (window as any).__app.togglePanel(p, true), panel);
          await shot(page, name(`panel-${panel}`));
        }
        await page.evaluate(() => {
          const app = (window as any).__app;
          if (app.ui.rightPanel) app.togglePanel(app.ui.rightPanel, false);
        });
        for (const command of MODAL_COMMANDS) {
          await runCommand(page, command);
          await shot(page, name(`modal-${command}`));
          await page.evaluate(() => (window as any).__app.closeModal());
        }
        await page.evaluate(() => (window as any).__app.openModal("workspace.settings"));
        for (const section of sections) {
          const title = await page.evaluate((id) => (window as any).__app.settingsSections.find((s: any) => s.id === id).title, section);
          await page.locator(".workspace-settings nav .list-row", { hasText: title }).first().click();
          await shot(page, name(`settings-${section}`));
        }
        await page.evaluate(() => (window as any).__app.closeModal());
        await page.evaluate(() => (window as any).__app.setPalette(true));
        await shot(page, name("palette"));
        await page.evaluate(() => (window as any).__app.setPalette(false));
      }
    }
  } finally {
    await close(electronApp, page);
  }
});
