import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { close, confirmNextPrompt, launch, runCommand } from "./helpers.ts";
import { decodePairing } from "../../mobile/src/pairing.ts";
import { connect, type Presence, type Row } from "../../mobile/src/live.ts";
import { deliver, syncReceipts, type Take } from "../../mobile/src/outbox.ts";

test("phone production changes follow the Mac and scene suggestions require a decision", async () => {
  const { page, electronApp } = await launch();
  let leave: (() => void) | undefined;
  try {
    await electronApp.evaluate(({ dialog, ipcMain }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      ipcMain.removeHandler("dictation:format");
      ipcMain.handle("dictation:format", (_event, request) => ({ elements: [
        { type: "sceneHeading", text: "INT. BOAT - NIGHT", uncertainty: "" },
        { type: "action", text: request.text, uncertainty: "" },
      ] }));
    });
    await page.evaluate(() => {
      const a = (window as any).__app, s = a.session;
      s.edit(() => {
        for (const p of [...s.doc.paragraphs()]) s.doc.deleteParagraph(p.id);
        s.doc.insertParagraph(0, { id: "heading-1", type: "sceneHeading", sceneId: "scene-1", sceneNumber: "1", runs: [{ text: "INT. ROOM - DAY" }] });
        s.doc.insertParagraph(1, { id: "action-1", type: "action", runs: [{ text: "A cup." }] });
        s.doc.insertParagraph(2, { id: "heading-2", type: "sceneHeading", sceneId: "scene-2", sceneNumber: "1A", runs: [{ text: "EXT. ROAD - DAY" }] });
        s.doc.meta.set("revisions", { sets: [{ id: "1", name: "Blue", color: "#6699cc", mark: "*", date: "11/01/26", style: "" }], currentSetId: "1", tracking: true, showMarks: true });
      });
    });
    await runCommand(page, "phone.open");
    const addresses = await page.evaluate(async () => (await (window as any).desktop.invoke("phone:status")).addresses);
    const lan = addresses.find((a: { tailscale?: boolean }) => !a.tailscale);
    test.skip(!lan, "Requires a private LAN interface.");
    await page.getByLabel("Phone network address").selectOption(lan.address);
    await page.getByLabel("Phone connection protection").selectOption("http");
    await page.getByRole("button", { name: "Start phone pairing…" }).click();
    const pair = decodePairing(await page.evaluate(async () => (await (window as any).desktop.invoke("phone:status")).pairing));
    let rows: Row[] = [], presence: Presence | null = null;
    leave = connect(pair, r => { rows = r; }, p => { presence = p; }, () => {});
    await expect.poll(() => presence?.production?.active?.name).toBe("Blue");
    await page.evaluate(() => {
      const s = (window as any).__app.session;
      s.edit(() => s.doc.formatRuns("action-1", 0, 5, { "fdx:RevisionID": "1", "fdx:TagNumber": "1" }));
    });
    await expect.poll(() => presence?.production?.marks["action-1"]?.color).toBe("#6699cc");
    await expect.poll(() => presence?.production?.scenes.find(s => s.id === "heading-1")?.changes).toContain("Breakdown tags changed");
    const signal = new AbortController().signal;
    const take: Take = { id: randomUUID(), room: pair.invite.room, kind: "scene-after", text: "The boat rocks.",
      paragraphId: "heading-1", sourceText: "INT. ROOM - DAY", scene: "1", created: Date.now(), outcome: "pending" };
    await deliver(pair, take, signal);
    await expect(page.getByRole("button", { name: "Accept scene", exact: true })).toBeEnabled();
    expect(rows.some(r => r.text === take.text)).toBe(false);
    await page.getByRole("button", { name: "Accept scene", exact: true }).click();
    await expect.poll(() => rows.map(r => r.text).indexOf(take.text)).toBe(3);
    await expect.poll(async () => (await syncReceipts(pair, signal, [take])).get(take.id)).toBe("accepted");
    await deliver(pair, take, signal);
    expect(rows.filter(r => r.text === take.text)).toHaveLength(1);
    const rejected: Take = { ...take, id: randomUUID(), kind: "scene-end", text: "Rejected ending." };
    await deliver(pair, rejected, signal);
    await expect(page.getByText(rejected.text, { exact: true })).toBeVisible();
    await confirmNextPrompt(electronApp);
    await page.getByRole("button", { name: "Discard inbox item" }).click();
    await expect.poll(async () => (await syncReceipts(pair, signal, [rejected])).get(rejected.id)).toBe("ignored");
    expect(rows.some(r => r.text === rejected.text)).toBe(false);
    const ending: Take = { ...rejected, id: randomUUID(), text: "Accepted ending." };
    await deliver(pair, ending, signal);
    await expect(page.getByRole("button", { name: "Accept scene", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Accept scene", exact: true }).click();
    await expect.poll(() => rows.at(-1)?.text).toBe(ending.text);
    const stale: Take = { ...take, id: randomUUID(), paragraphId: "heading-2", sourceText: "EXT. ROAD - DAY", text: "Choose my destination." };
    await page.evaluate(() => {
      const s = (window as any).__app.session;
      s.edit(() => {
        s.doc.insertParagraph(s.doc.paragraphs().length, { id: "duplicate-heading", type: "sceneHeading", sceneId: "duplicate-scene",
          runs: [{ text: "EXT. ROAD - DAY" }] });
        s.doc.deleteParagraph("heading-2");
      });
    });
    await deliver(pair, stale, signal);
    await expect(page.getByText("The destination scene was removed.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept scene", exact: true })).toBeDisabled();
    expect(rows.some(r => r.text === stale.text)).toBe(false);
    await page.getByLabel("Scene suggestion destination").selectOption("duplicate-heading");
    await expect(page.getByRole("button", { name: "Accept scene", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Accept scene", exact: true }).click();
    await expect.poll(() => rows.at(-1)?.text).toBe(stale.text);
    await expect.poll(async () => (await syncReceipts(pair, signal, [stale])).get(stale.id)).toBe("accepted");
  } finally { leave?.(); await close(electronApp, page); }
});
