// Runs axe-core (WCAG 2.0/2.1 A and AA) over every view, panel and common dialog, in light and dark appearance, writes
// the findings to a JSON file in the system temp folder, and fails on any violation or any state that would not open.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { close, launch, runCommand } from "./helpers.ts";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const THEMES = ["light", "dark"] as const;

interface NodeFinding { target: string[]; html: string; failureSummary?: string }
interface Violation { id: string; impact: string | null; help: string; helpUrl: string; nodes: NodeFinding[] }
interface StateResult { state: string; theme: string; status: "ran" | "could-not-open"; error?: string; violations: Violation[]; incomplete: string[]; passes: number }

const SCRIPT = { titlePage: [], paragraphs: [
  { id: "h1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
  { id: "a1", type: "action", runs: [{ text: "Rain on the window. MARA (30s) stirs cold coffee and watches the door." }] },
  { id: "c1", type: "character", runs: [{ text: "MARA" }] },
  { id: "d1", type: "dialogue", runs: [{ text: "You said ten o'clock. It's almost midnight." }] },
  { id: "c2", type: "character", runs: [{ text: "DEV" }] },
  { id: "d2", type: "dialogue", runs: [{ text: "I know. I brought the keys." }] },
  { id: "h2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "EXT. PARKING LOT - CONTINUOUS" }] },
  { id: "a2", type: "action", runs: [{ text: "A truck idles under the sodium light." }] },
] };

async function inject(page: Page): Promise<void> {
  if (await page.evaluate(() => Boolean((window as any).axe))) return;
  // The renderer's CSP (script-src 'self') blocks an injected <script> tag, but a DevTools-protocol evaluate is exempt.
  await page.evaluate(axeSource);
  if (!(await page.evaluate(() => Boolean((window as any).axe)))) throw new Error("axe-core did not load");
}

async function scan(page: Page, state: string, theme: string): Promise<StateResult> {
  await inject(page);
  const raw = await page.evaluate(async (tags) => {
    const r = await (window as any).axe.run(document, { runOnly: tags });
    return {
      passes: r.passes.length,
      incomplete: r.incomplete.map((i: any) => i.id),
      violations: r.violations.map((v: any) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        nodes: v.nodes.map((n: any) => ({ target: n.target.map(String), html: String(n.html).slice(0, 400), failureSummary: n.failureSummary })),
      })),
    };
  }, TAGS);
  return { state, theme, status: "ran", ...raw };
}

/** Back to the plain Write view: no dialog, no right panel, script view, find bar closed. */
async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const a = (window as any).__app;
    a.closeModal();
    if (a.ui.rightPanel) a.togglePanel(a.ui.rightPanel, false);
    a.setView("script");
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}

const settle = (page: Page) => page.waitForTimeout(500);

test("axe-core WCAG 2.x A/AA scan of every view, panel and common dialog", async () => {
  test.setTimeout(600_000);
  const { electronApp, page } = await launch();
  const results: StateResult[] = [];
  try {
    await page.evaluate((script) => {
      const a = (window as any).__app;
      a.session.edit(() => a.session.doc.load(script));
    }, SCRIPT as any);
    await page.waitForSelector(".ProseMirror");

    const catalog = await page.evaluate(() => {
      const a = (window as any).__app;
      return {
        panels: a.panels.map((p: any) => ({ id: p.id, side: p.side })) as { id: string; side: string }[],
        views: a.views.map((v: any) => v.id) as string[],
        settings: a.settingsSections.map((s: any) => s.id) as string[],
      };
    });
    console.log("panels:", catalog.panels.map((p) => p.id).join(", "));
    console.log("views:", catalog.views.join(", "));
    console.log("settings sections:", catalog.settings.join(", "));

    // Each state is [name, open, optional pre-step]. `open` must leave the state on screen; reset() undoes it.
    type Opener = { name: string; open: () => Promise<void> };
    const states: Opener[] = [];

    states.push({ name: "write-view-editor-focused", open: async () => { await page.locator(".ProseMirror").first().click(); await page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "d1", offset: 4 })); } });
    states.push({ name: "find-replace-bar", open: async () => { await runCommand(page, "editor.replace"); } });
    for (const p of catalog.panels) {
      states.push({ name: `panel:${p.id}`, open: async () => {
        await page.evaluate(({ id }) => (window as any).__app.togglePanel(id, true), { id: p.id });
      } });
    }
    for (const v of catalog.views) {
      if (v === "script") continue;
      states.push({ name: `view:${v}`, open: async () => { await page.evaluate((id) => (window as any).__app.setView(id), v); } });
    }
    for (const id of ["template.new", "layout.edit", "title-page.edit", "backlot.handoff"]) {
      states.push({ name: `dialog:${id}`, open: async () => { await runCommand(page, id).catch(() => undefined); await page.evaluate((m) => { const a = (window as any).__app; if (a.ui.modal?.id !== m) a.openModal(m); }, id); } });
    }
    states.push({ name: "dialog:localFeatures.open", open: async () => { await runCommand(page, "localFeatures.open"); } });
    states.push({ name: "dialog:fdxNotes.new", open: async () => {
      await page.evaluate(() => (window as any).__app.editor.setSelection({ paragraphId: "a1", offset: 0 }, { paragraphId: "a1", offset: 9 }));
      await runCommand(page, "fdxNotes.new");
    } });
    for (const s of catalog.settings) {
      states.push({ name: `settings:${s}`, open: async () => { await page.evaluate((section) => (window as any).__app.openModal("workspace.settings", { section }), s); } });
    }

    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(async (t) => {
        const a = (window as any).__app;
        document.documentElement.dataset.theme = t;
        await a.setSetting("appearance.theme", t);
      }, theme);
      await page.waitForTimeout(300);
      for (const s of states) {
        try {
          await reset(page);
          await s.open();
          await settle(page);
          const modalWanted = s.name.startsWith("dialog:") || s.name.startsWith("settings:");
          if (modalWanted) {
            const open = await page.evaluate(() => (window as any).__app.ui.modal?.id ?? null);
            if (!open) throw new Error("dialog did not open (command refused or disabled)");
          }
          const r = await scan(page, s.name, theme);
          results.push(r);
          console.log(`[${theme}] ${s.name}: ${r.violations.length} rule(s), ${r.violations.reduce((n, v) => n + v.nodes.length, 0)} node(s)`);
        } catch (error) {
          results.push({ state: s.name, theme, status: "could-not-open", error: String((error as Error).message ?? error).slice(0, 300), violations: [], incomplete: [], passes: 0 });
          console.log(`[${theme}] ${s.name}: COULD NOT OPEN: ${(error as Error).message}`);
        }
      }
      await reset(page);
    }
  } finally {
    const out = join(tmpdir(), `cold-open-axe-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify({ axe: (await page.evaluate(() => (window as any).axe?.version).catch(() => null)), tags: TAGS, results }, null, 2));
    const ran = results.filter((r) => r.status === "ran");
    const clean = ran.filter((r) => r.violations.length === 0);
    console.log(`\nResults written to ${out}`);
    console.log(`States scanned: ${ran.length}, clean: ${clean.length}, could not open: ${results.length - ran.length}`);
    const byRule = new Map<string, { impact: string | null; nodes: number; states: Set<string> }>();
    for (const r of ran) for (const v of r.violations) {
      const e = byRule.get(v.id) ?? { impact: v.impact, nodes: 0, states: new Set() };
      e.nodes += v.nodes.length; e.states.add(`${r.state}@${r.theme}`); byRule.set(v.id, e);
    }
    for (const [id, e] of byRule) console.log(`  ${id} (${e.impact}): ${e.nodes} nodes in ${e.states.size} states`);
    await close(electronApp, page);
  }
  expect(results.length).toBeGreaterThan(0);
  expect(results.filter((r) => r.status !== "ran").map((r) => `${r.theme}:${r.state}`)).toEqual([]);
  expect(results.flatMap((r) => r.violations.map((v) => `${r.theme}:${r.state}: ${v.id} (${v.nodes.length})`))).toEqual([]);
});
