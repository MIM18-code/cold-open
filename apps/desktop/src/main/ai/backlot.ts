// A compact, read-only summary of a Backlot project (project.json) for production-aware questions: per scene
// the number, heading, breakdown elements by category, cast and shoot day. Backlot is never written to.
import { stat } from "node:fs/promises";

import type { BacklotInfo } from "../../shared/channels/ai.ts";
import { readChosenFile } from "../safe-fs.ts";

const MAX_BYTES = 80 * 1024 * 1024;

interface Element { category?: string; text?: string; quantity?: number }
interface SceneRecord {
  id?: string; number?: string; heading?: string; setId?: string; status?: string; synopsis?: string;
  characterIds?: string[]; elements?: Element[]; pagesEighths?: number;
}
interface Item { kind?: string; id?: string; sceneId?: string; label?: string; date?: string; characterIds?: string[] }

export interface BacklotSummary {
  title: string;
  scenes: number;
  /** Prompt-ready text. */
  text: string;
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** Categories worth keeping when the summary has to shrink. */
const ESSENTIAL = new Set(["Stunts", "Special Effects", "Vehicles", "Animals", "Special Equipment", "Visual Effects", "Extras/Background", "Cast Members"]);

function eighths(count: number | undefined): string {
  if (!count) return "";
  const whole = Math.floor(count / 8);
  const rest = count % 8;
  return `${whole ? whole : ""}${rest ? `${whole ? " " : ""}${rest}/8` : ""}`;
}

export function summarizeBacklot(project: unknown, maxChars = 16_000): BacklotSummary {
  if (!isRecord(project) || !isRecord(project.script) || !Array.isArray(project.script.scenes)) throw new Error("This is not a Backlot project file.");
  const script = project.script;
  const scenes: SceneRecord[] = script.scenes;
  const characters = new Map<string, string>((script.characters ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const sets = new Map<string, string>((script.sets ?? []).map((s: { id: string; name: string }) => [s.id, s.name]));
  const items: Item[] = isRecord(project.schedule) && Array.isArray(project.schedule.items) ? project.schedule.items : [];

  // A shoot day is the run of strips up to the day break that ends it.
  const dayOf = new Map<string, { day: number; label?: string; date?: string }>();
  let day = 1;
  let pending: string[] = [];
  const close = (item: Item | null) => {
    for (const id of pending) dayOf.set(id, { day, ...(item?.label ? { label: item.label } : {}), ...(item?.date ? { date: item.date } : {}) });
    pending = [];
    if (item) day++;
  };
  for (const item of items) {
    if (item.kind === "strip" && item.sceneId) pending.push(item.sceneId);
    else if (item.kind === "dayBreak") close(item);
  }
  const trailing = pending.length > 0;
  close(null);
  const shootDays = items.filter((item) => item.kind === "dayBreak").length + (trailing ? 1 : 0);

  const render = (essentialOnly: boolean): string => {
    const lines = scenes.map((scene) => {
      const parts = [`${scene.number ?? "?"}. ${scene.heading ?? ""}${scene.status === "omitted" ? " (omitted)" : ""}`];
      const pages = eighths(scene.pagesEighths);
      if (pages) parts.push(`${pages} pages`);
      const cast = (scene.characterIds ?? []).map((id) => characters.get(id)).filter(Boolean);
      if (cast.length) parts.push(`cast: ${cast.join(", ")}`);
      const byCategory = new Map<string, string[]>();
      for (const element of scene.elements ?? []) {
        const category = element.category ?? "Other";
        if (!element.text || (essentialOnly && !ESSENTIAL.has(category)) || category === "Cast Members") continue;
        (byCategory.get(category) ?? byCategory.set(category, []).get(category)!).push(element.quantity && element.quantity > 1 ? `${element.text} x${element.quantity}` : element.text);
      }
      for (const [category, texts] of byCategory) parts.push(`${category.toLowerCase()}: ${texts.join("; ")}`);
      const scheduled = scene.id ? dayOf.get(scene.id) : undefined;
      parts.push(scheduled ? `scheduled day ${scheduled.day}${scheduled.date ? ` (${scheduled.date})` : ""}${scheduled.label ? ` ${scheduled.label}` : ""}` : "not scheduled");
      return `- ${parts.join(" | ")}`;
    });
    return lines.join("\n");
  };

  const title = String(project.meta?.title ?? project.meta?.scriptTitle ?? "Untitled");
  const header = [
    `Backlot project "${title}" (read-only): ${scenes.length} scenes, ${shootDays} shoot days on the board.`,
    `Characters: ${[...characters.values()].join(", ") || "none"}.`,
    "Scenes (number. heading | pages | cast | breakdown elements by category | shoot day):",
  ].join("\n");
  let body = render(false);
  if (header.length + body.length > maxChars) body = render(true);
  if (header.length + body.length > maxChars) body = body.slice(0, Math.max(0, maxChars - header.length - 40)).replace(/\n[^\n]*$/, "") + "\n(summary shortened)";
  return { title, scenes: scenes.length, text: `${header}\n${body}` };
}

/** Read a project file and summarize it. Fails with a plain message the settings screen can show. */
export async function readBacklot(path: string, maxChars?: number): Promise<BacklotSummary> {
  if (!/\.json$/i.test(path)) throw new Error("Choose a Backlot project.json file.");
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error("That file can't be found.");
  }
  if (size > MAX_BYTES) throw new Error("That file is too large to be a project.");
  let parsed: unknown;
  try {
    // Only a regular file: a FIFO put in its place (the project may sit in a shared folder) must not hang the app.
    parsed = JSON.parse(new TextDecoder().decode(await readChosenFile(path)));
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  return summarizeBacklot(parsed, maxChars);
}

export async function backlotInfo(path: string | undefined): Promise<BacklotInfo> {
  if (!path) return { ok: false };
  try {
    const summary = await readBacklot(path);
    return { ok: true, path, title: summary.title, scenes: summary.scenes };
  } catch (error) {
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolve production IDs through Backlot's imported paragraph identity, never through scene numbers. */
export function productionState(project: unknown): import("../../shared/channels/backlot.ts").BacklotProductionState {
  if (!isRecord(project) || typeof project.id !== "string" || !Array.isArray(project.script?.scenes)) throw new Error("This is not a Backlot project file.");
  const scheduled = new Set<string>(), issued = new Set<string>();
  const issuedDays = new Set((Array.isArray(project.callSheets) ? project.callSheets : [])
    .filter((s: any) => Array.isArray(s?.issues) && s.issues.length).map((s: any) => s.dayBreakId));
  let pending: string[] = [];
  for (const item of Array.isArray(project.schedule?.items) ? project.schedule.items : []) {
    if (item?.kind === "strip" && typeof item.sceneId === "string") { scheduled.add(item.sceneId); pending.push(item.sceneId); }
    else if (item?.kind === "dayBreak") {
      if (issuedDays.has(item.id)) for (const id of pending) issued.add(id);
      pending = [];
    }
  }
  return { projectId: project.id, scenes: project.script.scenes.filter((s: any) => typeof s?.id === "string").map((s: any) => ({
    sceneId: s.id, ...(typeof s.scriptKey?.paragraphId === "string" ? { headingId: s.scriptKey.paragraphId } : {}),
    scheduled: scheduled.has(s.id), issuedCallSheet: issued.has(s.id),
  })) };
}
export async function readProductionState(path: string): Promise<import("../../shared/channels/backlot.ts").BacklotProductionState> {
  if ((await stat(path)).size > MAX_BYTES) throw new Error("That file is too large to be a project.");
  const bytes = await readChosenFile(path);
  if (bytes.byteLength > MAX_BYTES) throw new Error("That file is too large to be a project.");
  return productionState(JSON.parse(new TextDecoder().decode(bytes)));
}
