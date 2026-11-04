// Launch the built app with a throwaway user-data folder so tests never touch real settings or recent files.
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function launch(args: string[] = [], existingUserData?: string): Promise<{ electronApp: ElectronApplication; page: Page; userData: string }> {
  const userData = existingUserData ?? mkdtempSync(join(tmpdir(), "screenplay-e2e-"));
  const electronApp = await electron.launch({
    args: [join(import.meta.dirname, ".."), `--user-data-dir=${userData}`, ...args],
    env: { ...process.env, SCREENPLAY_E2E: "1" },
  });
  const page = await electronApp.firstWindow();
  await page.waitForSelector(".shell");
  return { electronApp, page, userData };
}

/** Run a command by id through the renderer's app object, as a menu click would. */
export async function runCommand(page: Page, id: string): Promise<void> {
  await page.evaluate((commandId) => (window as any).__app.runCommand(commandId), id);
}

/** Quit without the save prompt: tests that edit the document leave it dirty. */
export async function close(electronApp: ElectronApplication, page?: Page): Promise<void> {
  if (page && !page.isClosed()) await page.evaluate(() => ((window as any).__app.session.dirty = false)).catch(() => undefined);
  await electronApp.close();
}

/** Answer the next in-app confirmation (a renderer messageBox) with its second button, then go back to cancelling. */
export async function confirmNextPrompt(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const g = globalThis as { e2eMessageBox?: () => number };
    const previous = g.e2eMessageBox;
    g.e2eMessageBox = () => { g.e2eMessageBox = previous; return 1; };
  });
}
