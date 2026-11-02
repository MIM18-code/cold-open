import { expect, test, _electron as electron, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, launch, runCommand } from "./helpers.ts";
async function draft(page: Page) {
    await page.evaluate(() => {
        const a = (window as any).__app;
        a.session.edit(() => a.session.doc.load({ titlePage: [], paragraphs: [
                { id: "h", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. KITCHEN - DAY" }] },
                { id: "a", type: "action", runs: [{ text: "A brass key rests on the table." }] },
                { id: "c", type: "character", runs: [{ text: "MARA" }] },
                { id: "d", type: "dialogue", runs: [{ text: "Leave the key here." }] },
                { id: "h2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "EXT. ROAD - NIGHT" }] },
                { id: "a2", type: "action", runs: [{ text: "The car stops." }] },
            ] }));
        a.session.undo.clear();
        a.editor.setSelection({ paragraphId: "a", offset: 2 }, { paragraphId: "a", offset: 11 });
        a.editor.focus();
    });
}
const words = (page: Page, id: string) => page.evaluate(id => (window as any).__app.session.doc.paragraph(id).runs.map((r: any) => r.text).join(""), id);
const script = (page: Page) => page.evaluate(() => (window as any).__app.session.script());
test("Smart Paste shows removable PDF furniture, keeps unchecked lines, and Undo restores selected source", async () => { const r = await launch(); try {
    await draft(r.page);
    const before = await script(r.page);
    await r.electronApp.evaluate(async ({ clipboard }) => { await clipboard.writeText("23.\nMARA\nOpen the door.\n(MORE)"); });
    await runCommand(r.page, "paste.smart");
    await expect(r.page.getByLabel("Paste source")).toHaveValue("23.\nMARA\nOpen the door.\n(MORE)");
    await r.page.getByLabel("Paste mode").selectOption("plain");
    await r.page.getByText(/Review possible PDF page furniture/).click();
    await r.page.getByLabel(/Possible page number/).check();
    await r.page.getByRole("button", { name: "Paste reviewed text", exact: true }).click();
    await expect.poll(() => words(r.page, "a")).toContain("(MORE)");
    expect(await words(r.page, "a")).not.toContain("23.");
    await r.page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await script(r.page)).toEqual(before);
}
finally {
    await close(r.electronApp, r.page);
} });
test("layout changes survive FDX export, affect actual element settings and undo independently", async () => { const r = await launch(); try {
    await draft(r.page);
    const before = await script(r.page);
    await runCommand(r.page, "layout.edit");
    await r.page.getByLabel("Layout element", { exact: true }).selectOption("action");
    await r.page.getByLabel("Element left", { exact: true }).fill("1.75");
    await r.page.getByRole("button", { name: "Apply document layout" }).click();
    const changed = await script(r.page);
    expect(JSON.stringify(changed.fdx)).toContain("1.75");
    const path = join(r.userData, "style.fdx");
    await r.electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any; (globalThis as any).e2eMessageBox = () => 0; }, path);
    await runCommand(r.page, "file.exportFdx");
    await expect.poll(() => existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('LeftIndent="1.75"');
    await r.page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await script(r.page)).toEqual(before);
}
finally {
    await close(r.electronApp, r.page);
} });
test("authored ScriptNote follows edits and is exported as a non-printing FDX note", async () => { const r = await launch(); try {
    await draft(r.page);
    await runCommand(r.page, "fdxNotes.new");
    await r.page.getByLabel("Script note text").fill("Check the brass key before shooting.");
    await r.page.getByLabel("Script note author").fill("Josh");
    await r.page.getByRole("button", { name: "Save note", exact: true }).click();
    await r.page.evaluate(() => { const s = (window as any).__app.session; s.edit(() => s.doc.insertText("a", 0, "Now ")); });
    await runCommand(r.page, "fdxNotes.open");
    await expect(r.page.getByRole("region", { name: "Script notes" })).toContainText("Pinned to a passage");
    await r.page.getByRole("region", { name: "Script notes" }).getByRole("button", { name: "Locate", exact: true }).click();
    await expect.poll(() => r.page.evaluate(() => (window as any).__app.editor.getSelection()?.anchor.offset)).toBe(6);
    const path = join(r.userData, "notes.fdx");
    await r.electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any; (globalThis as any).e2eMessageBox = () => 0; }, path);
    await runCommand(r.page, "file.exportFdx");
    await expect.poll(() => existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Check the brass key before shooting.");
    expect(await words(r.page, "a")).toBe("Now A brass key rests on the table.");
}
finally {
    await close(r.electronApp, r.page);
} });
test("breakdown authoring reaches tag reports and FDX without changing screenplay words", async () => { const r = await launch(); try {
    await draft(r.page);
    await runCommand(r.page, "tags.selection");
    await r.page.getByLabel("Breakdown element name").fill("BRASS KEY");
    await r.page.getByRole("button", { name: "Apply breakdown tag" }).click();
    expect(await words(r.page, "a")).toBe("A brass key rests on the table.");
    await runCommand(r.page, "reports.open");
    await r.page.getByRole("tab", { name: "Tags by tag", exact: true }).click();
    await expect(r.page.locator(".reports-table")).toContainText("BRASS KEY");
    await expect(r.page.locator(".reports-table")).toContainText("Props");
    await r.page.keyboard.press("Escape");
    const path = join(r.userData, "tagged.fdx");
    await r.electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any; (globalThis as any).e2eMessageBox = () => 0; }, path);
    await runCommand(r.page, "file.exportFdx");
    await expect.poll(() => existsSync(path)).toBe(true);
    const xml = readFileSync(path, "utf8");
    expect(xml).toContain('Label="BRASS KEY"');
    expect(xml).toContain("<DefId>");
    expect(xml).not.toContain("InklotTagId");
}
finally {
    await close(r.electronApp, r.page);
} });
test("canvas supports keyboard movement and list editing without moving screenplay scenes", async () => { const r = await launch(); try {
    await draft(r.page);
    const before = await script(r.page);
    await runCommand(r.page, "canvas.open");
    await r.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 700));
    await expect.poll(() => r.page.evaluate(() => innerWidth)).toBe(900);
    await r.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await expect.poll(() => r.page.locator(".shell-main").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(900);
    await expect.poll(() => r.page.locator(".beat-canvas-scroll").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await r.page.getByRole("button", { name: "New beat", exact: true }).click();
    await r.page.getByLabel("Project item name").fill("Opening image");
    await r.page.getByLabel("Project item text").fill("An empty road.");
    await r.page.getByRole("button", { name: "Keep beat", exact: true }).click();
    await runCommand(r.page, "canvas.open");
    const handle = r.page.getByRole("button", { name: "Move beat Opening image", exact: true });
    await handle.focus();
    await r.page.keyboard.press("Shift+ArrowRight");
    await r.page.getByRole("button", { name: "Accessible list", exact: true }).click();
    await expect(r.page.getByLabel("x position of Opening image")).toHaveValue("34");
    expect(await script(r.page)).toEqual(before);
    await r.page.getByLabel("Scene for Opening image").selectOption("s1");
    await r.page.getByRole("button", { name: "Go to linked scene" }).click();
    await expect(r.page.locator(".editor-pm")).toBeVisible();
}
finally {
    await close(r.electronApp, r.page);
} });
test("scene duplicate preview creates a distinct scene and one Undo restores the whole draft", async () => { const r = await launch(); try {
    await draft(r.page);
    const before = await script(r.page);
    await runCommand(r.page, "scenes.operations");
    await r.page.getByLabel("Scene operation", { exact: true }).selectOption("duplicate");
    await r.page.getByRole("button", { name: "Apply reviewed scene operation" }).click();
    await expect.poll(async () => (await script(r.page)).paragraphs.filter((p: any) => p.type === "sceneHeading").length).toBe(3);
    await r.page.evaluate(() => (window as any).__app.session.undo.undo());
    expect(await script(r.page)).toEqual(before);
}
finally {
    await close(r.electronApp, r.page);
} });
test("report presets retain hidden columns and flow preview, and CSV follows visible columns", async () => { const r = await launch(); try {
    await draft(r.page);
    await runCommand(r.page, "reports.open");
    await r.page.getByRole("tab", { name: "Dialogue", exact: true }).click();
    await r.page.getByText("Columns, print layout and report presets", { exact: true }).click();
    await r.page.getByLabel("Report paper").selectOption("a4");
    await r.page.getByLabel("Report print layout").selectOption("speeches");
    await r.page.getByLabel("Show Words column", { exact: true }).uncheck();
    await r.page.getByLabel("Report revision label").fill("Blue draft");
    await r.page.getByLabel("Report preset name").fill("Reader dialogue");
    await r.page.getByRole("button", { name: "Save report preset", exact: true }).click();
    await r.page.getByRole("button", { name: "Preview report pages" }).click();
    await expect(r.page.getByTitle("Report print preview")).toBeVisible();
    expect(await r.page.getByTitle("Report print preview").getAttribute("srcdoc")).toContain("Blue draft");
    expect(await r.page.getByTitle("Report print preview").getAttribute("srcdoc")).toContain("size:A4 portrait");
    const path = join(r.userData, "dialogue.csv");
    await r.electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any; }, path);
    await r.page.getByRole("button", { name: "Export CSV…" }).click();
    await expect.poll(() => existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").split("\n")[0]).not.toContain("Words");
    await r.page.keyboard.press("Escape");
    await runCommand(r.page, "reports.open");
    await expect(r.page.getByRole("tab", { name: "Dialogue", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(r.page.getByLabel("Load report preset")).toContainText("Reader dialogue");
}
finally {
    await close(r.electronApp, r.page);
} });
test("cross-project search reads only selected files and searches saved content", async () => { const r = await launch(); try {
    const paths = [join(r.userData, "one.fountain"), join(r.userData, "two.fountain")];
    writeFileSync(paths[0]!, "INT. ROOM - DAY\n\nA unique brass key.");
    writeFileSync(paths[1]!, "EXT. ROAD - NIGHT\n\nAn empty road.");
    await r.electronApp.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as any; }, paths);
    await runCommand(r.page, "search.projects");
    await r.page.getByRole("button", { name: "Choose script files…" }).click();
    await r.page.getByRole("textbox", { name: "Search across scripts" }).fill("brass key");
    await r.page.getByRole("button", { name: "Search saved scripts" }).click();
    await expect(r.page.getByText("1 matching paragraphs", { exact: true })).toBeVisible();
    await expect(r.page.getByText("A unique brass key.", { exact: true })).toBeVisible();
    // A searched file is readable, not writable, and asking for a window on it does not change that unless the
    // writer confirms the main process's own dialog.
    const tryWrite = () => r.page.evaluate(async (path) => { try {
        await (window as any).desktop.invoke("files:write", path, "OVERWRITTEN");
        return "written";
    }
    catch {
        return "refused";
    } }, paths[1]!);
    expect(await tryWrite()).toBe("refused");
    await r.page.evaluate((path) => (window as any).desktop.invoke("shell:new-window", path), paths[1]!);
    expect(await tryWrite()).toBe("refused");
    expect(readFileSync(paths[1]!, "utf8")).toContain("An empty road.");
    await r.electronApp.evaluate(() => { (globalThis as any).e2eMessageBox = (o: any) => (/for editing/.test(o.message) ? 0 : o.cancelId ?? 0); });
    await r.page.evaluate((path) => (window as any).desktop.invoke("shell:new-window", path), paths[1]!);
    expect(await tryWrite()).toBe("written");
    expect(await r.page.evaluate(async () => { try {
        await (window as any).desktop.invoke("project-search:run", "x".repeat(301), false);
        return "accepted";
    }
    catch {
        return "rejected";
    } })).toBe("rejected");
}
finally {
    await close(r.electronApp, r.page);
} });
test("native autosave updates an existing master but an external write pauses it without overwriting", async () => { const r = await launch(); try {
    await draft(r.page);
    const path = join(r.userData, "master.screenplay");
    await r.electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any; }, path);
    await runCommand(r.page, "file.saveAs");
    await expect.poll(() => existsSync(path)).toBe(true);
    const before = readFileSync(path);
    await r.page.evaluate(() => { const a = (window as any).__app; a.session.edit(() => a.session.doc.insertText("d", 0, "Please ")); a.openModal("workspace.settings", { section: "autosave" }); });
    await r.page.getByRole("button", { name: "Retry native autosave" }).click();
    await expect.poll(() => readFileSync(path).equals(before)).toBe(false);
    await expect.poll(() => r.page.evaluate(() => (window as any).__app.session.dirty)).toBe(false);
    writeFileSync(path, "EXTERNAL FILE CHANGE");
    await r.page.evaluate(() => { const s = (window as any).__app.session; s.edit(() => s.doc.insertText("d", 0, "Really ")); });
    await r.page.getByRole("button", { name: "Retry native autosave" }).click();
    await expect(r.page.getByRole("dialog").getByRole("alert")).toContainText("FILE_CHANGED:");
    expect(readFileSync(path, "utf8")).toBe("EXTERNAL FILE CHANGE");
    expect(await r.page.evaluate(() => (window as any).__app.session.dirty)).toBe(true);
}
finally {
    await close(r.electronApp, r.page);
} });
test("explicit location navigation survives a source edit and supports Back and Forward", async () => { const r = await launch(); try {
    await draft(r.page);
    await r.page.evaluate(() => { const a = (window as any).__app; a.editor.setSelection({ paragraphId: "a", offset: 2 }); a.editor.revealParagraph("a2", { select: true, offset: 4 }); a.session.edit(() => a.session.doc.insertText("a", 0, "Now ")); });
    await runCommand(r.page, "locations.back");
    await expect.poll(() => r.page.evaluate(() => (window as any).__app.editor.getSelection()?.head)).toEqual({ paragraphId: "a", offset: 6 });
    await runCommand(r.page, "locations.forward");
    await expect.poll(() => r.page.evaluate(() => (window as any).__app.editor.getSelection()?.head)).toEqual({ paragraphId: "a2", offset: 4 });
}
finally {
    await close(r.electronApp, r.page);
} });
test("error history outlives toast dismissal, and workspace presets do not change script data", async () => { const r = await launch(); try {
    await draft(r.page);
    const before = await script(r.page);
    await r.page.evaluate(() => { const a = (window as any).__app; a.toast("A recoverable test failure.", "error"); a.toasts = []; });
    await runCommand(r.page, "activity.open");
    await expect(r.page.getByRole("dialog")).toContainText("A recoverable test failure.");
    await r.page.getByRole("button", { name: "Clear error history" }).click();
    await expect(r.page.getByRole("dialog")).toContainText("No recorded errors.");
    await r.page.keyboard.press("Escape");
    await runCommand(r.page, "workspace.preset.rehearsal");
    await expect(r.page.getByLabel("Voice engine")).toBeVisible();
    await runCommand(r.page, "workspace.preset.writing");
    await expect(r.page.getByLabel("Voice engine")).toHaveCount(0);
    expect(await script(r.page)).toEqual(before);
}
finally {
    await close(r.electronApp, r.page);
} });
test("saved phone inbox survives a stopped connection; accepting a note leaves script text untouched", async () => {
    const r = await launch();
    try {
        await draft(r.page);
        await runCommand(r.page, "phone.open");
        await expect(r.page.getByRole("combobox", { name: "Phone connection protection" })).toHaveValue("https");
        // Opening the panel writes nothing into the script; an untitled one is keyed by its session.
        expect(await r.page.evaluate(() => (window as any).__app.session.doc.meta.get("history.documentId"))).toBeUndefined();
        const key = await r.page.evaluate(() => (window as any).__app.session.id);
        const folder = join(r.userData, "phone-inbox");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, key + ".json"), JSON.stringify([{ id: "phone-message-0001", kind: "note", text: "Hold on the key.", cueId: "captured-cue", paragraphId: "a", revision: "older-draft", created: "2026-10-31T00:00:00Z", sourceText: "A brass key rests on the table." }]));
        await r.page.evaluate(() => { const s = (window as any).__app.session; s.edit(() => s.doc.insertText("a", 0, "Now ")); });
        const before = await script(r.page);
        await r.page.getByRole("button", { name: "Refresh connection" }).click();
        await expect(r.page.getByText("Hold on the key.", { exact: true })).toBeVisible();
        await r.page.getByRole("button", { name: "Accept as project note" }).click();
        await expect(r.page.getByText("Hold on the key.", { exact: true })).toHaveCount(0);
        const notes = await r.page.evaluate(() => [...(window as any).__app.session.doc.meta.entries()].filter(([k]: [
            string
        ]) => k.startsWith("workbench.record.")).map(([, v]: [
            string,
            any
        ]) => v));
        expect(notes).toHaveLength(1);
        expect(notes[0].anchor.from).toBe(4);
        expect(notes[0].text).toBe("Hold on the key.");
        expect(await script(r.page)).toEqual(before);
        const status = await r.page.evaluate(() => (window as any).desktop.invoke("phone:status"));
        expect(status.active).toBe(false);
        expect(status.url).toBe("");
        await r.page.screenshot({ path: "test-results/roadmap-phone.png" });
    }
    finally {
        await close(r.electronApp, r.page);
    }
});
test("multiple saved windows reopen on opted-in restart without treating their disk files as unsaved recovery", async () => { const r = await launch(); let next: Awaited<ReturnType<typeof electron.launch>> | undefined; try {
    const paths = [join(r.userData, "first.fountain"), join(r.userData, "second.fountain")];
    writeFileSync(paths[0]!, "INT. FIRST - DAY\n\nFirst scene.");
    writeFileSync(paths[1]!, "EXT. SECOND - NIGHT\n\nSecond scene.");
    await r.electronApp.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as any; }, paths);
    await r.page.evaluate(async () => { const a = (window as any).__app; await a.setSetting("workspace.restoreWindows", true); await (window as any).desktop.invoke("project-search:choose"); });
    // Search grants read access only; the writer confirms opening each result for editing.
    await r.electronApp.evaluate(() => { (globalThis as any).e2eMessageBox = (o: any) => (/for editing/.test(o.message) ? 0 : o.cancelId ?? 0); });
    for (const path of paths)
        await r.page.evaluate(path => (window as any).desktop.invoke("shell:new-window", path), path);
    await expect.poll(() => r.electronApp.windows().length).toBe(3);
    for (const page of r.electronApp.windows()) {
        await page.waitForSelector(".shell");
        await page.evaluate(() => (window as any).__app.session.dirty = false);
    }
    await expect.poll(async () => { const settings = await r.page.evaluate(() => (window as any).desktop.invoke("settings:get")); return settings["files.openWindows.v1"]?.length; }).toBe(2);
    await r.electronApp.close();
    next = await electron.launch({ args: [join(import.meta.dirname, ".."), `--user-data-dir=${r.userData}`], env: { ...process.env, SCREENPLAY_E2E: "1" } });
    await expect.poll(() => next!.windows().length).toBe(2);
    const restored = [];
    for (const page of next.windows()) {
        await page.waitForSelector(".shell");
        restored.push(await page.evaluate(() => (window as any).__app.session.path));
    }
    expect(restored.sort()).toEqual(paths.sort());
}
finally {
    if (next) {
        for (const page of next.windows())
            await page.evaluate(() => (window as any).__app.session.dirty = false).catch(() => { });
        await next.close();
    }
    else
        await close(r.electronApp, r.page).catch(() => { });
} });
test("a window cannot read, claim or move another script's phone inbox by its key", async () => { const r = await launch(); try {
    await runCommand(r.page, "phone.open");
    await expect(r.page.getByRole("combobox", { name: "Phone connection protection" })).toHaveValue("https");
    const folder = join(r.userData, "phone-inbox");
    mkdirSync(folder, { recursive: true });
    const other = "a".repeat(64);
    writeFileSync(join(folder, other + ".json"), JSON.stringify([{ id: "phone-message-0002", kind: "note", text: "Private note.", cueId: "c", paragraphId: "p", revision: "r", created: "2026-10-31T00:00:00Z", sourceText: "x" }]));
    const result = await r.page.evaluate(async (other) => {
        const d = (window as any).desktop, mine = (window as any).__app.session.id;
        const attempt = async (f: () => Promise<unknown>) => { try { await f(); return "allowed"; } catch { return "refused"; } };
        return {
            status: ((await d.invoke("phone:status", other)).inbox as unknown[]).length,
            claim: await attempt(() => d.invoke("phone:claim-key", other)),
            move: await attempt(() => d.invoke("phone:move-inbox", other, mine)),
            acknowledge: await attempt(() => d.invoke("phone:acknowledge", other, "phone-message-0002")),
        };
    }, other);
    expect(result).toEqual({ status: 0, claim: "refused", move: "refused", acknowledge: "refused" });
    // A path hash cannot be claimed while its inbox is still empty, either.
    const empty = "b".repeat(64);
    expect(await r.page.evaluate(async (k) => { try { await (window as any).desktop.invoke("phone:claim-key", k); return "allowed"; } catch { return "refused"; } }, empty)).toBe("refused");
    expect(readFileSync(join(folder, other + ".json"), "utf8")).toContain("Private note.");
}
finally {
    await close(r.electronApp, r.page);
} });
