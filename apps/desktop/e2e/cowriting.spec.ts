// Co-writing between two hidden app instances with the real editor on both sides: each writer's caret is drawn in
// the other's editor, typing in both converges, and a read-only invite gives a script that follows but cannot change.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { launch, runCommand } from "./helpers.ts";

async function quit(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app }) => void setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await electronApp.close().catch(() => undefined);
}

const texts = (page: Page) => page.evaluate(() =>
  (window as any).__app.session.script().paragraphs.map((p: any) => `${p.type}:${p.runs.map((r: any) => r.text).join("")}`));

async function share(page: Page): Promise<{ write: string; read: string }> {
  await runCommand(page, "collab.share");
  await page.getByRole("radio", { name: "On this Mac only" }).check();
  await expect(page.locator(".collab-invite-write")).toHaveValue(/^screenplay:\/\/join\?/);
  return { write: await page.locator(".collab-invite-write").inputValue(), read: await page.locator(".collab-invite-read").inputValue() };
}

async function join(page: Page, invite: string): Promise<void> {
  await runCommand(page, "collab.join");
  await page.locator(".collab-join-input").fill(invite);
  await page.locator(".collab-join-submit").click();
}

/** Put the caret at the end of the script's last paragraph and focus the editor. */
async function caretAtEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).__app;
    const last = app.session.script().paragraphs.at(-1);
    app.editor.setSelection({ paragraphId: last.id, offset: last.runs.map((r: any) => r.text).join("").length });
    app.editor.focus();
  });
}

test("two writers type in their own editors, see each other's carets, and end with the same script", async () => {
  const host = await launch();
  const guest = await launch();
  try {
    const errors: string[] = [];
    for (const page of [host.page, guest.page]) page.on("pageerror", (error) => errors.push(error.message));
    await host.page.evaluate(() => (window as any).__app.setSetting("collab.name", "Ana"));
    await guest.page.evaluate(() => (window as any).__app.setSetting("collab.name", "Ben"));
    await host.page.waitForSelector(".editor-pm");
    await host.page.evaluate(() => (window as any).__app.editor.focus());
    await host.page.keyboard.type("int. writers room - night");
    await host.page.keyboard.press("Escape");
    await host.page.keyboard.press("Enter");
    await host.page.keyboard.type("Ana types.");

    const { write } = await share(host.page);
    await join(guest.page, write);
    await expect.poll(() => texts(guest.page)).toEqual(["sceneHeading:INT. WRITERS ROOM - NIGHT", "action:Ana types."]);
    await guest.page.waitForSelector(".editor-pm");
    await expect(guest.page.locator(".editor-pm > .editor-p")).toHaveCount(2);
    await expect(guest.page.locator(".editor-pm > .editor-p").nth(1)).toContainText("Ana types.");

    // Each editor draws the other writer's caret with their name.
    await caretAtEnd(host.page);
    await caretAtEnd(guest.page);
    await expect(guest.page.locator(".editor-pm .editor-remote-caret .editor-remote-label")).toHaveText("Ana");
    await expect(host.page.locator(".editor-pm .editor-remote-caret .editor-remote-label")).toHaveText("Ben");

    // Both type at once, through the keyboard, into their own editors.
    await host.page.keyboard.press("Enter");
    await guest.page.keyboard.type(" Ben adds a line.");
    await host.page.keyboard.type("Ana keeps going.");
    await expect.poll(async () => {
      const [a, b] = await Promise.all([texts(host.page), texts(guest.page)]);
      return JSON.stringify(a) === JSON.stringify(b) ? a : null;
    }, { timeout: 10_000 }).toEqual(["sceneHeading:INT. WRITERS ROOM - NIGHT", "action:Ana types. Ben adds a line.", "action:Ana keeps going."]);
    const final = await texts(host.page);
    await expect(guest.page.locator(".editor-pm > .editor-p")).toHaveCount(final.length);
    await expect(host.page.locator(".editor-pm > .editor-p")).toHaveCount(final.length);
    // The guest's caret stayed in the text it was typing, across the host's edits.
    expect((await guest.page.evaluate(() => (window as any).__app.editor.getSelection().head.offset))).toBeGreaterThan(0);

    // Undo on the guest takes back only the guest's typing.
    await guest.page.evaluate(() => (window as any).__app.session.undo.undo());
    await expect.poll(async () => (await texts(host.page)).join("\n")).not.toContain("Ben adds a line.");
    expect((await texts(host.page)).join("\n")).toContain("Ana keeps going.");
    expect(errors).toEqual([]);
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
  }
});

test("a read-only invite opens a script that follows the host and refuses typing", async () => {
  const host = await launch();
  const reader = await launch();
  try {
    await host.page.waitForSelector(".editor-pm");
    await host.page.evaluate(() => {
      const session = (window as any).__app.session;
      session.edit(() => session.doc.insertText(session.script().paragraphs[0].id, 0, "INT. HALL - DAY"));
    });
    const { read } = await share(host.page);
    await join(reader.page, read);
    await expect.poll(() => texts(reader.page)).toEqual(["sceneHeading:INT. HALL - DAY"]);
    await expect(reader.page.locator(".editor-banner")).toContainText("Read-only");
    await expect(reader.page.locator(".editor-pm")).toHaveAttribute("contenteditable", "false");
    expect(await reader.page.evaluate(() => (window as any).__app.session.readOnly)).toBe(true);

    // The reader cannot type, and nothing reaches the host.
    await caretAtEnd(reader.page);
    await reader.page.keyboard.type(" EDIT");
    await reader.page.keyboard.press("Enter");
    expect(await texts(reader.page)).toEqual(["sceneHeading:INT. HALL - DAY"]);

    // The host's typing reaches the reader's editor.
    await caretAtEnd(host.page);
    await host.page.keyboard.type(" - LATER");
    // The heading also holds the host's caret label, so compare the start of its text.
    await expect(reader.page.locator(".editor-pm .editor-t-sceneHeading")).toHaveText(/^INT\. HALL - DAY - LATER/);
    expect(await texts(host.page)).toEqual(["sceneHeading:INT. HALL - DAY - LATER"]);

    // Leaving keeps the script open and editable as the reader's own copy.
    await runCommand(reader.page, "collab.leave");
    await expect(reader.page.locator(".editor-banner")).toHaveCount(0);
    expect(await reader.page.evaluate(() => (window as any).__app.session.readOnly)).toBe(false);
  } finally {
    await quit(host.electronApp);
    await quit(reader.electronApp);
  }
});
