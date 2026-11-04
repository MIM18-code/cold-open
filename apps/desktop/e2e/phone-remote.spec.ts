import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { close, confirmNextPrompt, launch, runCommand } from "./helpers.ts";
import { decodePairing } from "../../mobile/src/pairing.ts";
import { deliver, folderItem, syncReceipts, type Take } from "../../mobile/src/outbox.ts";
import { connect, type Row } from "../../mobile/src/live.ts";

test("pair the iPhone reader, follow typing and review an anchored suggestion", async () => {
  const { page, electronApp } = await launch();
  let leave: (() => void) | undefined;
  try {
    await electronApp.evaluate(({ dialog, ipcMain, clipboard }) => {
      // Exercise the real review flow without starting a model or changing the system clipboard.
      clipboard.writeText = value => { (globalThis as any).__copiedCode = value; };
      ipcMain.removeHandler("dictation:format");
      ipcMain.handle("dictation:format", (_event, request) => ({
        elements: [{ type: "dialogue", text: request.text.toUpperCase(), uncertainty: "" }],
      }));
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await page.evaluate(() => (window as any).__app.setSetting("collab.name", "Jo"));
    await runCommand(page, "phone.open");
    const address = page.getByLabel("Phone network address");
    const addresses = await page.evaluate(async () => (await (window as any).desktop.invoke("phone:status")).addresses);
    const lan = addresses.find((a: { tailscale?: boolean }) => !a.tailscale);
    test.skip(!lan, "The Phone panel requires a private LAN interface for this HTTP test.");
    await address.selectOption(lan.address);
    await page.getByLabel("Phone connection protection").selectOption("http");
    await page.getByRole("button", { name: "Start phone pairing…" }).click();
    await expect(page.locator("figure svg")).toHaveCount(1);
    const payload = await page.evaluate(async () => (await (window as any).desktop.invoke("phone:status")).pairing);
    await page.getByRole("button", { name: "Copy app pairing code" }).click();
    expect(await electronApp.evaluate((_, expected) =>
      (globalThis as any).__copiedCode === expected, payload)).toBe(true);
    const pair = decodePairing(payload);
    let status = "", rows: Row[] = [], writers: string[] = [];
    leave = connect(pair, r => { rows = r; }, p => { writers = p?.writers ?? []; }, s => { status = s; });
    await expect.poll(() => writers).toContain("Jo");
    await expect.poll(() => status).toBe("Live");
    const text = "A red thermos on the counter.";
    const id = await page.evaluate(text => {
      const s = (window as any).__app.session;
      s.edit(() => s.doc.insertParagraph(1, { type: "action", runs: [{ text }] }));
      return s.doc.paragraphs()[1].id;
    }, text);
    await expect.poll(() => rows.find(r => r.id === id)?.text).toBe(text);
    const take: Take = { kind: "note", id: randomUUID(), room: pair.invite.room, paragraphId: id, sourceText: text,
      text: "Keep the thermos.", created: Date.now(), scene: "Scene 1", outcome: "pending" };
    const signal = new AbortController().signal;
    await deliver(pair, take, signal);
    await expect(page.getByText(take.text, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept as project note" }).click();
    await expect.poll(async () => (await syncReceipts(pair, signal, [take])).get(take.id)).toBe("accepted");
    await deliver(pair, take, signal);
    await expect(page.getByText(take.text, { exact: true })).toHaveCount(0);
    expect(rows.find(r => r.id === id)?.text).toBe(text);
    const dictation: Take = { ...take, id: randomUUID(), kind: "dictation", text: "Take the last boat." };
    await deliver(pair, dictation, signal);
    await expect(page.locator("article p").filter({ hasText: /dialogue TAKE THE LAST BOAT\./ })).toBeVisible();
    expect(rows.some(r => r.text === "TAKE THE LAST BOAT.")).toBe(false);
    await page.getByRole("button", { name: "Save to Cuts for review" }).click();
    await expect.poll(async () => (await syncReceipts(pair, signal, [dictation])).get(dictation.id)).toBe("accepted");
    const cut = await page.evaluate(id => {
      const meta = (window as any).__app.session.doc.meta;
      return [...meta.values()].find(v => (v as any)?.phoneReceipt?.endsWith(":" + id));
    }, dictation.id);
    expect(cut).toMatchObject({ paragraphs: [{ type: "dialogue", runs: [{ text: "TAKE THE LAST BOAT." }] }] });
    const draft: Take = { ...take, id: randomUUID(), kind: "draft",
      text: "INT. FERRY - NIGHT\n\nMARA\n(quietly)\nKeep the last boat." };
    await deliver(pair, draft, signal);
    await expect(page.locator("article p").filter({ hasText: /^sceneHeading INT. FERRY - NIGHT$/ })).toBeVisible();
    expect(rows.some(r => r.text === "Keep the last boat.")).toBe(false);
    await page.getByRole("button", { name: "Accept draft", exact: true }).click();
    await expect.poll(async () => (await syncReceipts(pair, signal, [draft])).get(draft.id)).toBe("accepted");
    await expect.poll(() => rows.slice(rows.findIndex(r => r.id === id) + 1).slice(0, 4)
      .map(r => [r.type, r.text])).toEqual([
        ["sceneHeading", "INT. FERRY - NIGHT"], ["character", "MARA"],
        ["parenthetical", "(quietly)"], ["dialogue", "Keep the last boat."],
      ]);
    await deliver(pair, draft, signal);
    expect(rows.filter(r => r.text === "Keep the last boat.")).toHaveLength(1);
    const ignored: Take = { ...draft, id: randomUUID(), text: "This draft is ignored." };
    await deliver(pair, ignored, signal);
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Ignore draft", exact: true }).click();
    await expect.poll(async () => (await syncReceipts(pair, signal, [ignored])).get(ignored.id)).toBe("ignored");
    expect(rows.some(r => r.text === ignored.text)).toBe(false);
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Stop sharing / revoke link" }).click();
    await expect.poll(() => status).toBe("Host stopped sharing");
  } finally { leave?.(); await close(electronApp, page); }
});

test("remember an iPhone on a saved script and revoke it from the Phone panel", async () => {
  // Electron's evaluate cannot import modules, so file work happens here in the test process.
  const { page, electronApp, userData } = await launch();
  let leave: (() => void) | undefined;
  try {
    const path = join(userData, "Remembered.screenplay");
    await electronApp.evaluate(async ({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, path);
    await runCommand(page, "file.save");
    await expect.poll(() => page.evaluate(() => (window as any).__app.session.path)).toBe(path);
    await runCommand(page, "phone.open");
    const addresses = await page.evaluate(async () => (await (window as any).desktop.invoke("phone:status")).addresses);
    const lan = addresses.find((a: { tailscale?: boolean }) => !a.tailscale);
    test.skip(!lan, "This test requires a private LAN interface.");
    await page.getByLabel("Phone network address").selectOption(lan.address);
    await page.getByLabel("Phone connection protection").selectOption("http");
    await page.getByLabel("Remember this iPhone", { exact: true }).check();
    await page.getByRole("button", { name: "Start phone pairing…" }).click();
    await expect(page.locator("figure svg")).toHaveCount(1);
    const raw = await page.evaluate(async () => (await (window as any).desktop.invoke("phone:status")).pairing);
    const pair = decodePairing(raw);
    expect(pair.remembered).toBe(true);
    expect(new URL(pair.origin).port).toBe("4456");
    await fetch(pair.origin + "/api/device", { method: "POST", headers: {
      authorization: `Bearer ${pair.token}`, "content-type": "application/json",
    }, body: JSON.stringify({ name: "Maya’s iPhone" }) });
    await page.getByRole("button", { name: "Refresh connection" }).click();
    let status = "", rows: Row[] = [];
    leave = connect(pair, value => { rows = value; }, () => {}, value => { status = value; });
    await expect.poll(() => status).toBe("Live");
    await expect.poll(() => rows.length).toBeGreaterThan(0);
    const cloud = join(userData, "phone-cloud");
    await mkdir(cloud);
    await electronApp.evaluate(async ({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, cloud);
    await page.getByRole("button", { name: "Choose iCloud Drive fallback folder…" }).click();
    await expect(page.getByRole("button", { name: "Change iCloud Drive fallback folder…" })).toBeVisible();
    const take: Take = { id: randomUUID(), room: pair.invite.room, kind: "note", text: "A note saved on the road.",
      paragraphId: rows[0]!.id, sourceText: rows[0]!.text.slice(0, 1500), scene: rows[0]!.scene,
      created: Date.now(), outcome: "saved" };
    const inbox = join(cloud, "Inklot Phone Inbox", pair.deviceId!);
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, ".phone-item.tmp"), await folderItem(pair, take));
    await rename(join(inbox, ".phone-item.tmp"), join(inbox, take.id + ".json"));
    await expect(page.getByText(take.text, { exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Accept as project note" }).click();
    const signal = new AbortController().signal;
    await expect.poll(async () => (await syncReceipts(pair, signal, [take])).get(take.id)).toBe("accepted");
    await deliver(pair, take, signal);
    await expect(page.getByText(take.text, { exact: true })).toHaveCount(0);
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Revoke Maya’s iPhone" }).click();
    await expect.poll(() => status).toBe("Refused");
    await expect(page.getByRole("button", { name: "Revoke Maya’s iPhone" })).toHaveCount(0);
  } finally { leave?.(); await close(electronApp, page); }
});
