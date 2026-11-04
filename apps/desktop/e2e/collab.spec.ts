// Co-writing and folder sync between hidden app instances: one shares, another joins with the invite, both edit,
// and the scripts match. Every test also checks that no window ever became visible on screen.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { confirmNextPrompt, launch, runCommand } from "./helpers.ts";
import type { HostInfo } from "../src/shared/channels/sync.ts";

/** Quit without the "Save changes?" sheet: a native sheet on a hidden window would show the window. */
async function quit(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app }) => void setTimeout(() => app.exit(0), 10)).catch(() => undefined);
  await electronApp.close().catch(() => undefined);
}

/** Tests must never put a window on the writer's screen. */
async function expectHidden(electronApp: ElectronApplication): Promise<void> {
  const visible = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length);
  expect(visible).toBe(0);
}

const paragraphs = (page: Page) => page.evaluate(() => JSON.stringify((window as any).__app.session.doc.toScript().paragraphs));
const wholeScript = (page: Page) => page.evaluate(() => JSON.stringify((window as any).__app.session.doc.toScript()));

async function appendParagraph(page: Page, type: string, text: string): Promise<void> {
  await page.evaluate(([type, text]) => {
    const session = (window as any).__app.session;
    const count = session.doc.toScript().paragraphs.length;
    session.edit(() => session.doc.insertParagraph(count, { type, runs: [{ text }] }));
  }, [type, text] as const);
}

async function share(page: Page): Promise<string> {
  await runCommand(page, "collab.share");
  await page.getByRole("radio", { name: "On this Mac only" }).check();
  const field = page.locator(".collab-invite-write");
  await expect(field).toHaveValue(/^screenplay:\/\/join\?/);
  return field.inputValue();
}

async function join(page: Page, invite: string): Promise<void> {
  await runCommand(page, "collab.join");
  await page.locator(".collab-join-input").fill(invite);
  await page.locator(".collab-join-submit").click();
}

test("two instances share, join, edit in both and converge", async () => {
  const host = await launch();
  const guest = await launch();
  try {
    const errors: string[] = [];
    for (const page of [host.page, guest.page]) page.on("pageerror", (error) => errors.push(error.message));

    // The host writes a heading, then shares.
    await host.page.evaluate(() => {
      const session = (window as any).__app.session;
      const id = session.doc.toScript().paragraphs[0].id;
      session.edit(() => session.doc.insertText(id, 0, "INT. WRITERS ROOM - NIGHT"));
    });
    const invite = await share(host.page);
    expect(invite).toMatch(/^screenplay:\/\/join\?host=127\.0\.0\.1%3A\d+&room=/);
    await expect(host.page.locator(".collab-invite-read")).toHaveValue(/&access=read$/);
    await expect(host.page.getByText("File › Join Co-writing Session…")).toBeVisible();
    await expect(host.page.locator(".collab-status-text")).toHaveText("Waiting for a co-writer");

    // The guest joins through the dialog and gets the host's script, not its own blank page.
    await join(guest.page, invite);
    await expect.poll(() => paragraphs(guest.page)).toBe(await paragraphs(host.page));
    expect(JSON.parse(await paragraphs(guest.page))).toHaveLength(1);

    // Both write at once.
    await Promise.all([
      appendParagraph(guest.page, "action", "Coffee cups everywhere."),
      appendParagraph(host.page, "character", "MAYA"),
    ]);
    await expect.poll(async () => {
      const [a, b] = await Promise.all([paragraphs(host.page), paragraphs(guest.page)]);
      return a === b && a.includes("Coffee cups everywhere.") && a.includes("MAYA");
    }, { timeout: 10_000 }).toBe(true);

    // Presence: two people in each status bar and panel.
    await expect(host.page.locator(".collab-statusbar .collab-count")).toHaveText("2");
    await expect(guest.page.locator(".collab-statusbar .collab-count")).toHaveText("2");
    await expect(guest.page.locator(".collab-person")).toHaveCount(2);
    await expect(guest.page.locator(".collab-status-text")).toHaveText("Connected");
    await expect(host.page.locator(".collab-status-text")).toHaveText("Connected");

    // Undo on the guest takes back only the guest's own line, never the host's.
    await guest.page.evaluate(() => (window as any).__app.session.undo.undo());
    await expect.poll(async () => {
      const [a, b] = await Promise.all([paragraphs(host.page), paragraphs(guest.page)]);
      return a === b && !a.includes("Coffee cups everywhere.") && a.includes("MAYA") && a.includes("INT. WRITERS ROOM");
    }, { timeout: 10_000 }).toBe(true);

    // Stopping ends the guest's session and leaves the script open there.
    await runCommand(host.page, "collab.stop");
    await expect(guest.page.locator(".collab-panel")).toContainText("Share for Co-writing");
    await expect(guest.page.locator(".collab-statusbar")).toHaveCount(0);
    expect(await paragraphs(guest.page)).toContain("MAYA");
    expect(errors).toEqual([]);
    await expectHidden(host.electronApp);
    await expectHidden(guest.electronApp);
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
  }
});

test("a clicked relay invite opens a separate preview and joins only after confirmation", async () => {
  const host = await launch(), guest = await launch();
  const { createRelay } = await import("@screenplay/relay");
  const relay = await createRelay({ host: "127.0.0.1", allowClaim: true });
  try {
    await host.page.evaluate(url => (window as any).__app.setSetting("collab.relayUrl", url), `ws://127.0.0.1:${relay.port}`);
    await appendParagraph(host.page, "action", "The relay’s shared draft.");
    await runCommand(host.page, "collab.share");
    const field = host.page.locator(".collab-invite-read");
    await expect(field).toHaveValue(/access=read/);
    await appendParagraph(guest.page, "action", "My unsaved draft.");
    const openInvite = async () => {
      const opened = guest.electronApp.waitForEvent("window");
      await guest.electronApp.evaluate(({ app }, link) => app.emit("open-url", { preventDefault() {} } as any, link), await field.inputValue());
      return opened;
    };
    const first = await openInvite();
    await expect(first.getByRole("dialog")).toContainText("invited to read");
    await expect(first.getByRole("dialog")).toContainText(`127.0.0.1:${relay.port}`);
    await first.getByRole("button", { name: "Cancel" }).click();
    expect(relay.stats().connections).toBe(1);
    const second = await openInvite();
    await second.getByRole("button", { name: "Join", exact: true }).click();
    await expect.poll(() => paragraphs(second)).toBe(await paragraphs(host.page));
    expect(await second.evaluate(() => (window as any).__app.session.readOnly)).toBe(true);
    expect(await paragraphs(guest.page)).toContain("My unsaved draft.");
    expect(await paragraphs(host.page)).not.toContain("My unsaved draft.");
    await confirmNextPrompt(host.electronApp);
    await host.page.getByRole("button", { name: "Leave Session" }).click();
    await expect(second.locator(".collab-status-text")).toHaveText("Connected");
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
    await relay.close();
  }
});

for (const lan of [true, false]) {
  test(`sharing offers a Tailscale invite ${lan ? "alongside the local-network invite" : "when no LAN address exists"}`, async () => {
    const host = await launch();
    try {
      const info: HostInfo = await host.page.evaluate(() => (window as any).desktop.invoke("sync:host-start"));
      const port = new URL(info.relay).port;
      const withAddress = (text: string, address: string) => {
        const url = new URL(text);
        url.searchParams.set("host", address);
        return url.href;
      };
      const tailscale = {
        address: `100.114.165.59:${port}`,
        invite: withAddress(info.invite, `100.114.165.59:${port}`),
        readOnlyInvite: withAddress(info.readOnlyInvite, `100.114.165.59:${port}`),
      };
      const address = lan ? `192.168.1.20:${port}` : tailscale.address;
      const advertised: HostInfo = { ...info, lan, tailscale, address,
        invite: withAddress(info.invite, address), readOnlyInvite: withAddress(info.readOnlyInvite, address) };
      // Keep the real loopback relay and room; replace only the advertised interfaces at the IPC boundary.
      await host.electronApp.evaluate(({ ipcMain }, info) => {
        ipcMain.removeHandler("sync:host-start");
        ipcMain.handle("sync:host-start", () => info);
      }, advertised);
      await runCommand(host.page, "collab.share");
      const local = host.page.getByRole("radio", { name: "On the same Wi-Fi or local network" });
      const remote = host.page.getByRole("radio", { name: "On a different network" });
      const writer = host.page.locator(".collab-invite-write");
      const reader = host.page.locator(".collab-invite-read");
      await expect(writer).toHaveCount(0);
      if (lan) {
        await local.check();
        await expect(writer).toHaveValue(advertised.invite);
        await expect(reader).toHaveValue(advertised.readOnlyInvite);
      } else await expect(local).toBeDisabled();
      await remote.check();
      await expect(writer).toHaveValue(tailscale.invite);
      await expect(reader).toHaveValue(tailscale.readOnlyInvite);
      await runCommand(host.page, "collab.copyInvite");
      await expect.poll(() => host.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(tailscale.invite);
      await runCommand(host.page, "collab.copyReadOnlyInvite");
      await expect.poll(() => host.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(tailscale.readOnlyInvite);
      await expect(host.page.getByText("Tailscale is connected on this Mac")).toBeVisible();
      await expectHidden(host.electronApp);
    } finally { await quit(host.electronApp); }
  });
}

test("remote setup withholds local invites and detects Tailscale when the host checks again", async () => {
  const host = await launch();
  try {
    await runCommand(host.page, "collab.share");
    await host.page.getByRole("radio", { name: "On a different network" }).check();
    await expect(host.page.getByRole("link", { name: "install Tailscale" })).toBeVisible();
    await expect(host.page.locator(".collab-invite-write, .collab-invite-read")).toHaveCount(0);
    const canCopy = () => host.page.evaluate(() => {
      const app = (window as any).__app;
      return app.commands.filter((c: { id: string }) => ["collab.copyInvite", "collab.copyReadOnlyInvite"].includes(c.id))
        .some((c: { enabled: (app: unknown) => boolean }) => c.enabled(app));
    });
    expect(await canCopy()).toBe(false);
    const info: HostInfo = await host.page.evaluate(() => (window as any).desktop.invoke("sync:host-start"));
    await host.electronApp.evaluate(({ ipcMain }, info) => {
      // Only the advertised interface changes. Keep the room and server from the real host.
      const address = "100.80.0.1:" + new URL(info.relay).port;
      const remote = (invite: string) => {
        const url = new URL(invite);
        url.searchParams.set("host", address);
        return url.href;
      };
      ipcMain.removeHandler("sync:host-start");
      ipcMain.handle("sync:host-start", () => ({ ...info, tailscale: { address, invite: remote(info.invite), readOnlyInvite: remote(info.readOnlyInvite) } }));
    }, info);
    await host.page.getByRole("button", { name: "Check Tailscale again" }).click();
    await expect(host.page.locator(".collab-invite-write")).toHaveValue(/host=100\.80\.0\.1/);
    expect(await canCopy()).toBe(true);
  } finally { await quit(host.electronApp); }
});

/** A stand-in editor: reports a caret the test sets and records the remote cursors it is asked to draw. */
async function fakeEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).__app;
    const listeners = new Set<(selection: unknown) => void>();
    const state = { selection: null as unknown, cursors: [] as unknown[] };
    (window as any).__editor = {
      state,
      move(paragraphId: string, offset: number) {
        state.selection = { anchor: { paragraphId, offset }, head: { paragraphId, offset } };
        for (const listener of listeners) listener(state.selection);
      },
    };
    const noop = () => undefined;
    app.setEditor({
      focus: noop, setSelection: noop, revealParagraph: noop, currentParagraphId: () => null, currentElementType: () => null,
      setElementType: noop, toggleMark: noop, activeMarks: () => ({}), insertParagraphs: () => [], replaceText: noop, setDecorations: noop, setPageBreaks: noop,
      getSelection: () => state.selection,
      setRemoteCursors: (cursors: unknown[]) => void (state.cursors = cursors),
      onSelectionChange: (listener: (selection: unknown) => void) => (listeners.add(listener), () => listeners.delete(listener)),
      onPlainTextPaste: () => noop,
    });
  });
}

test("carets reach the other writer's editor, including an editor that mounts after joining", async () => {
  const host = await launch();
  const guest = await launch();
  try {
    await host.page.evaluate(() => (window as any).__app.setSetting("collab.name", "Ana Host"));
    await fakeEditor(host.page);
    const invite = await share(host.page);
    await join(guest.page, invite);
    await expect.poll(() => paragraphs(guest.page)).toBe(await paragraphs(host.page));
    const id = await host.page.evaluate(() => (window as any).__app.session.doc.toScript().paragraphs[0].id);
    await host.page.evaluate((paragraphId) => (window as any).__editor.move(paragraphId, 0), id);
    // The guest's editor mounts late and still gets the host's caret, with the host's chosen name.
    await fakeEditor(guest.page);
    await expect.poll(() => guest.page.evaluate(() => JSON.stringify((window as any).__editor.state.cursors))).toContain("Ana Host");
    await guest.page.evaluate((paragraphId) => (window as any).__editor.move(paragraphId, 0), id);
    await expect.poll(() => host.page.evaluate(() => (window as any).__editor.state.cursors.length)).toBe(1);
    // Leaving clears the cursors on both sides.
    await runCommand(guest.page, "collab.leave");
    await expect.poll(() => host.page.evaluate(() => (window as any).__editor.state.cursors.length)).toBe(0);
    expect(await guest.page.evaluate(() => (window as any).__editor.state.cursors.length)).toBe(0);
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
  }
});

test("a refused or closed invite is reported in the dialog and leaves the guest's script alone", async () => {
  const host = await launch();
  const guest = await launch();
  try {
    const before = await paragraphs(guest.page);
    const invite = await share(host.page);
    const forged = invite.replace(/key=[\w-]+/, "key=AAAAAAAAAAAAAAAAAAAAAA");
    await join(guest.page, forged);
    await expect(guest.page.locator(".collab-error")).toContainText(/refused/);
    expect(await paragraphs(guest.page)).toBe(before);
    await expect(host.page.locator(".collab-person")).toHaveCount(1);

    // The host stops, so its relay stops listening; the old invite gives up after a while and says why.
    await runCommand(host.page, "collab.stop");
    await guest.page.locator(".collab-join-input").fill(invite);
    await guest.page.locator(".collab-join-submit").click();
    await expect(guest.page.locator(".collab-join-submit")).toHaveText("Connecting…");
    await expect(guest.page.locator(".collab-error")).toContainText(/send an invite for your location/, { timeout: 20_000 });
    expect(await paragraphs(guest.page)).toBe(before);
    expect(await guest.page.evaluate(() => (window as any).__app.session.pristine)).toBe(true);
    await expectHidden(guest.electronApp);
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
  }
});

test("when the host quits or opens another script, the guest's session ends and keeps the script", async () => {
  const host = await launch();
  const guest = await launch();
  const third = await launch();
  try {
    await appendParagraph(host.page, "action", "The last line before the host leaves.");
    await join(guest.page, await share(host.page));
    await expect.poll(() => paragraphs(guest.page)).toContain("The last line before the host leaves.");

    // Opening another script in the host's window stops sharing.
    await host.page.evaluate(() => {
      const app = (window as any).__app;
      app.setSession(app.session.constructor.untitled());
    });
    await expect(guest.page.locator(".collab-statusbar")).toHaveCount(0);
    await expect(host.page.locator(".collab-statusbar")).toHaveCount(0);
    expect(await paragraphs(guest.page)).toContain("The last line before the host leaves.");

    // Share again and quit the host's app: the guest stops instead of reconnecting forever.
    await appendParagraph(host.page, "action", "Second session.");
    await join(third.page, await share(host.page));
    await expect.poll(() => paragraphs(third.page)).toContain("Second session.");
    await quit(host.electronApp);
    await expect(third.page.locator(".collab-statusbar")).toHaveCount(0, { timeout: 10_000 });
    expect(await paragraphs(third.page)).toContain("Second session.");
    await expectHidden(guest.electronApp);
    await expectHidden(third.electronApp);
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
    await quit(third.electronApp);
  }
});

test("a guest receives an FDX script whole, with its kept Final Draft data", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "screenplay-collab-"));
  const fdx = joinPath(dir, "Synthetic.fdx");
  copyFileSync(joinPath(import.meta.dirname, "../../../packages/engine/test/fixtures/synthetic.fdx"), fdx);
  const host = await launch([fdx]);
  const guest = await launch();
  try {
    await expect(host.page.locator(".titlebar-name")).toHaveText("Synthetic");
    await join(guest.page, await share(host.page));
    await expect.poll(() => wholeScript(guest.page)).toBe(await wholeScript(host.page));
    expect(await guest.page.evaluate(() => !!(window as any).__app.session.doc.toScript().fdx)).toBe(true);
    // The guest's window takes the host's document name.
    await expect(guest.page.locator(".titlebar-name")).toHaveText(/Synthetic/);
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
  }
});

test("a 3,000-paragraph script: joining and live edits stay quick", async () => {
  const host = await launch();
  const guest = await launch();
  try {
    await host.page.evaluate(() => {
      const session = (window as any).__app.session;
      const kinds = ["sceneHeading", "action", "character", "dialogue", "action", "character", "parenthetical", "dialogue"];
      session.edit(() => {
        for (let i = 0; i < 3000; i++) {
          const type = kinds[i % kinds.length];
          const text = type === "sceneHeading" ? `INT. ROOM ${i} - DAY` : type === "character" ? "MAYA" : `Line ${i} of a long script that runs for a while.`;
          session.doc.insertParagraph(i + 1, { type, runs: [{ text }] });
        }
      });
    });
    const invite = await share(host.page);
    const started = Date.now();
    await join(guest.page, invite);
    await expect.poll(() => guest.page.evaluate(() => (window as any).__app.session.doc.toScript().paragraphs.length)).toBe(3001);
    const joinMs = Date.now() - started;

    // Fifty single-character edits on the host, then wait for the guest to have them all.
    const editStart = Date.now();
    await host.page.evaluate(() => {
      const session = (window as any).__app.session;
      const id = session.doc.toScript().paragraphs[1500].id;
      for (let i = 0; i < 50; i++) session.edit(() => session.doc.insertText(id, 0, "x"));
    });
    await expect.poll(() => guest.page.evaluate(() => {
      const session = (window as any).__app.session;
      return session.doc.toScript().paragraphs[1500].runs[0].text.startsWith("x".repeat(50));
    })).toBe(true);
    const editMs = Date.now() - editStart;
    console.log(`3,000 paragraphs: join ${joinMs} ms, 50 edits delivered in ${editMs} ms`);
    expect(joinMs).toBeLessThan(8000);
    expect(editMs).toBeLessThan(3000);
    expect(await wholeScript(guest.page)).toBe(await wholeScript(host.page));
  } finally {
    await quit(host.electronApp);
    await quit(guest.electronApp);
  }
});

test("two Macs sync a saved script through a shared folder", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "screenplay-folder-"));
  const path = joinPath(dir, "Shared Draft.screenplay");
  const a = await launch();
  let b: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    await a.page.evaluate(() => {
      const session = (window as any).__app.session;
      const id = session.doc.toScript().paragraphs[0].id;
      session.edit(() => session.doc.insertText(id, 0, "EXT. HARBOR - NIGHT"));
    });
    await a.electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as any;
    }, path);
    await runCommand(a.page, "file.saveAs");
    await expect.poll(() => existsSync(path)).toBe(true);
    await runCommand(a.page, "collab.folderSync");
    await expect(a.page.locator(".collab-statusbar")).toHaveText("Folder sync on");

    // The second Mac (its own settings, so its own device ID) opens the same file and picks up the folder.
    b = await launch([path]);
    await expect(b.page.locator(".collab-statusbar")).toHaveText("Folder sync on");
    await appendParagraph(b.page, "action", "Written on the second Mac.");
    await appendParagraph(a.page, "action", "Written on the first Mac.");
    await expect.poll(async () => {
      const [x, y] = await Promise.all([paragraphs(a.page), paragraphs(b!.page)]);
      return x === y && x.includes("second Mac") && x.includes("first Mac");
    }, { timeout: 15_000 }).toBe(true);
    // Remote changes are not undoable: undo on the first Mac removes only its own line.
    await a.page.evaluate(() => (window as any).__app.session.undo.undo());
    await expect.poll(async () => {
      const [x, y] = await Promise.all([paragraphs(a.page), paragraphs(b!.page)]);
      return x === y && x.includes("second Mac") && !x.includes("first Mac");
    }, { timeout: 15_000 }).toBe(true);
    const logs = readdirSync(joinPath(dir, "Shared Draft.screenplay-sync")).filter((name) => name.endsWith(".ylog"));
    expect(logs).toHaveLength(2);
    await expectHidden(a.electronApp);
    await expectHidden(b.electronApp);
  } finally {
    await quit(a.electronApp);
    if (b) await quit(b.electronApp);
  }
});

/** Launch with a given userData folder: the same Mac (same device ID) across launches. */
async function launchAs(userData: string, args: string[] = []): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const electronApp = await electron.launch({
    args: [joinPath(import.meta.dirname, ".."), `--user-data-dir=${userData}`, ...args],
    env: { ...process.env, SCREENPLAY_E2E: "1" },
  });
  const page = await electronApp.firstWindow();
  await page.waitForSelector(".shell");
  return { electronApp, page };
}

async function saveAs(app: { electronApp: ElectronApplication; page: Page }, heading: string, path: string): Promise<void> {
  await app.page.evaluate((text) => {
    const session = (window as any).__app.session;
    const id = session.doc.toScript().paragraphs[0].id;
    session.edit(() => session.doc.insertText(id, 0, text));
  }, heading);
  await app.electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as any;
  }, path);
  await runCommand(app.page, "file.saveAs");
  await expect.poll(() => existsSync(path)).toBe(true);
}

test("links a co-writer puts in a shared sync folder never bring another script's text in", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "screenplay-folder-links-"));
  const userData = mkdtempSync(joinPath(tmpdir(), "screenplay-e2e-"));
  const privateDir = joinPath(dir, "Private");
  const sharedDir = joinPath(dir, "Shared");
  mkdirSync(privateDir);
  mkdirSync(sharedDir);
  // This Mac folder-syncs a private script, so its log sits in Private/Secret.screenplay-sync/.
  const first = await launchAs(userData);
  const secretPath = joinPath(privateDir, "Secret.screenplay");
  try {
    await saveAs(first, "INT. SECRET PAGES - NIGHT", secretPath);
    await runCommand(first.page, "collab.folderSync");
    await expect(first.page.locator(".collab-statusbar")).toHaveText("Folder sync on");
    await expect.poll(() => readdirSync(joinPath(privateDir, "Secret.screenplay-sync")).filter((name) => name.endsWith(".ylog")).length).toBe(1);
  } finally {
    await quit(first.electronApp);
  }
  const deviceId = JSON.parse(readFileSync(joinPath(userData, "settings.json"), "utf8"))["sync.deviceId"] as string;
  const privateLog = `../../Private/Secret.screenplay-sync/${deviceId}.ylog`;

  const second = await launchAs(userData);
  try {
    // A shared script whose sync folder holds a co-writer's "log" that is a link to the private one.
    const draftPath = joinPath(sharedDir, "Draft.screenplay");
    await saveAs(second, "INT. SHARED ROOM - DAY", draftPath);
    mkdirSync(joinPath(sharedDir, "Draft.screenplay-sync"));
    symlinkSync(privateLog, joinPath(sharedDir, "Draft.screenplay-sync", "cowriter.ylog"));
    await runCommand(second.page, "collab.folderSync");
    await expect(second.page.locator(".collab-statusbar")).toHaveText("Folder sync on");
    // Give a rescan time to run too.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await wholeScript(second.page)).toContain("SHARED ROOM");
    expect(await wholeScript(second.page)).not.toContain("SECRET PAGES");

    // Another shared script whose sync folder is itself a link to the private one: sync does not turn on by
    // itself, and turning it on fails without reading or writing there.
    const otherPath = joinPath(sharedDir, "Other.screenplay");
    copyFileSync(draftPath, otherPath);
    symlinkSync("../Private/Secret.screenplay-sync", joinPath(sharedDir, "Other.screenplay-sync"));
    const third = await launchAs(mkdtempSync(joinPath(tmpdir(), "screenplay-e2e-")), [otherPath]);
    try {
      await expect.poll(() => third.page.evaluate(() => (window as any).__app.session.path)).toBe(otherPath);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await expect(third.page.locator(".collab-statusbar")).toHaveCount(0);
      await runCommand(third.page, "collab.folderSync");
      await expect(third.page.locator(".toast", { hasText: "is a link" })).toHaveCount(1);
      expect(await wholeScript(third.page)).not.toContain("SECRET PAGES");
      expect(readdirSync(joinPath(privateDir, "Secret.screenplay-sync"))).toEqual([`${deviceId}.ylog`]);
      await expectHidden(third.electronApp);
    } finally {
      await quit(third.electronApp);
    }
    await expectHidden(second.electronApp);
  } finally {
    await quit(second.electronApp);
  }
});

test("a guest who drops offline and reconnects keeps everyone's work: stranded typing is flagged and A-numbers stay unique", async () => {
  const host = await launch();
  const guest = await launch();
  const script = (page: Page) => page.evaluate(() => (window as any).__app.session.doc.toScript());
  const texts = (s: any) => JSON.stringify(s.paragraphs.map((p: any) => [p.type, p.sceneNumber ?? "", p.runs.map((r: any) => r.text).join("")]));
  const converge = () => expect.poll(async () => texts(await script(guest.page)) === texts(await script(host.page)), { timeout: 60000 }).toBe(true);
  // While offline, the guest's sockets go nowhere, as if the network dropped; the client keeps retrying.
  const offline = (on: boolean) => guest.page.evaluate((on) => { const w = window as any; w.__offline = on; if (on) for (const s of w.__sockets) s.close(); }, on);
  const notice = /left behind by a co-writer/;
  try {
    await guest.page.evaluate(() => {
      const W = window.WebSocket, w = window as any; w.__sockets = []; w.__offline = false;
      w.WebSocket = class extends W { constructor(url: string | URL, p?: string | string[]) { super(w.__offline ? "ws://127.0.0.1:9/" : url, p); w.__sockets.push(this); } };
    });
    await host.page.evaluate(() => {
      const a = (window as any).__app, p = (id: string, type: string, text: string, sceneId?: string) => ({ id, type, runs: [{ text }], ...(sceneId ? { sceneId } : {}) });
      a.session.edit(() => a.session.doc.load({ titlePage: [], paragraphs: [
        p("h1", "sceneHeading", "INT. GARAGE - MORNING", "s1"), p("a1", "action", "Derek checks the van."),
        p("h2", "sceneHeading", "EXT. POND - DAY", "s2"), p("c2", "character", "MAYA"), p("d2", "dialogue", "Do not touch the water."),
        p("h3", "sceneHeading", "INT. KITCHEN - MORNING", "s3"), p("a3", "action", "Toast burns."),
      ] }));
    });
    await join(guest.page, await share(host.page));
    await converge();

    await offline(true);
    await expect(guest.page.locator(".collab-statusbar")).toContainText("Reconnecting");
    await runCommand(host.page, "scenes.operations");
    await host.page.getByLabel("Scene operation source").selectOption("s2");
    await host.page.getByLabel("Scene operation", { exact: true }).selectOption("move");
    await host.page.getByLabel("Move scene before").selectOption("");
    await host.page.getByRole("button", { name: "Apply reviewed scene operation" }).click();
    await host.page.evaluate(() => { const s = (window as any).__app.session; s.edit(() => s.doc.insertText("a1", 0, "HOST EDIT ")); });
    await guest.page.evaluate(() => { const s = (window as any).__app.session; s.edit(() => s.doc.insertText("d2", 0, "GUEST TYPED ")); });
    await offline(false);
    await converge();
    const merged = texts(await script(host.page));
    expect(merged).toContain("HOST EDIT ");
    expect(merged).toContain("GUEST TYPED ");
    await expect(guest.page.getByRole("button", { name: notice })).toBeVisible();
    await expect(host.page.getByRole("button", { name: notice })).toHaveCount(0);

    await runCommand(host.page, "structure.numberScenes");
    await runCommand(host.page, "revisions.lockScenes");
    await converge();
    await offline(true);
    for (const [page, name] of [[host.page, "INT. HALLWAY - DAY"], [guest.page, "INT. ATTIC - DAY"]] as const) {
      await page.evaluate((name) => { const s = (window as any).__app.session, ps = s.doc.toScript().paragraphs; const second = ps.findIndex((p: any, i: number) => p.type === "sceneHeading" && i > 0);
        s.edit(() => { s.doc.insertParagraph(second, { type: "sceneHeading", runs: [{ text: name }] }); s.doc.insertParagraph(second + 1, { type: "action", runs: [{ text: "New." }] }); }); }, name);
    }
    await offline(false);
    await converge();
    const numbers = (await script(host.page)).paragraphs.filter((p: any) => p.type === "sceneHeading").map((p: any) => p.sceneNumber);
    expect(numbers).toEqual(["1", "1A", "1B", "2", "3"]);
    await expect(guest.page.getByText("Scene numbers adjusted · Review")).toBeVisible();
    await expect(host.page.getByText("Scene numbers adjusted · Review")).toBeVisible();
    await expectHidden(host.electronApp);
    await expectHidden(guest.electronApp);
  } finally { await quit(host.electronApp); await quit(guest.electronApp); }
});
