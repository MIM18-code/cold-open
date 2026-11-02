import { tagDefinitions } from "./tags.ts";
import { fdxPositionAt } from "./fdx.ts";
// Detailed writing reports over the same paragraph IDs and printed page numbers as the editor.
import { NON_PRINTING, type ElementType, type Script, type XmlNode } from "./model.ts";
import type { Pagination } from "./pagination.ts";
import { characterName, countWords } from "./reports.ts";
import { spokenText } from "./read-plan.ts";
import { speechesOf } from "./speeches.ts";
export interface ReportLine { paragraphId: string; sceneId: string; scene: string; heading: string; page: string; }
export interface DialogueRow extends ReportLine { character: string; cue: string; parenthetical: string; dialogue: string; words: number; monologue: boolean; }
export interface NoteRow extends ReportLine { text: string; kind: string; }
export interface ElementRow extends ReportLine { type: ElementType; text: string; }
function locations(script: Script, pagination: Pagination): Map<string, ReportLine> {
  const map = new Map<string, ReportLine>(); let ordinal = 0, scene = "", sceneId = "", heading = "Before first scene";
  for (const p of script.paragraphs) {
    if (p.type === "sceneHeading") { ordinal++; scene = p.sceneNumber || String(ordinal); sceneId = p.sceneId ?? p.id; heading = spokenText(p); }
    const position = pagination.positions.get(p.id);
    map.set(p.id, { paragraphId: p.id, sceneId, scene, heading, page: position ? pagination.pages[position.page]?.number ?? "" : "" });
  }
  return map;
}
export function dialogueReport(script: Script, pagination: Pagination): DialogueRow[] {
  const loc = locations(script, pagination), rows: DialogueRow[] = [];
  for (const { cue, paragraphs } of speechesOf(script.paragraphs)) {
    const dialogue = paragraphs.filter((p) => p.type === "dialogue" || p.type === "lyrics");
    if (!dialogue.length) continue;
    const directions = paragraphs.filter((p) => p.type === "parenthetical").map(spokenText);
    const text = dialogue.map(spokenText).filter(Boolean).join("\n"), words = countWords(text);
    rows.push({ ...loc.get(dialogue[0]!.id)!, character: characterName(spokenText(cue)), cue: spokenText(cue),
      parenthetical: directions.join(" "), dialogue: text, words, monologue: words > 100 });
  }
  return rows;
}
function nodesNamed(roots: readonly XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [], pending = [...roots];
  while (pending.length) { const node = pending.pop()!; if (node.name === name) found.push(node); else pending.push(...node.children.filter((c): c is XmlNode => typeof c !== "string")); }
  return found.reverse();
}
const attr = (node: XmlNode, name: string) => node.attrs.find(([k]) => k === name)?.[1] ?? "";
function noteText(note: XmlNode): string {
  const paragraphs = nodesNamed([note], "Paragraph");
  return paragraphs.map((p) => nodesNamed([p], "Text").map((t) => t.children.filter((c): c is string => typeof c === "string").join("")).join("")).join("\n");
}
export function notesReport(script: Script, pagination: Pagination): NoteRow[] {
  const loc = locations(script, pagination), rows: NoteRow[] = [];
  for (const p of script.paragraphs) {
    if (p.type === "note") rows.push({ ...loc.get(p.id)!, text: p.runs.map((r) => r.text).join(""), kind: p.boneyard ? "Boneyard" : "Note" });
    else {
      let note = "";
      const flush = () => { if (note) rows.push({ ...loc.get(p.id)!, text: note, kind: "Inline note" }); note = ""; };
      for (const run of p.runs) { if (run.note) note += run.text; else flush(); } flush();
    }
    for (const note of nodesNamed([...(p.fdx?.before ?? []), ...(p.fdx?.after ?? [])], "ScriptNote")) {
      rows.push({ ...loc.get(p.id)!, text: noteText(note), kind: "Imported ScriptNote" });
    }
  }
  // ScreenplayDoc projects observed ranges to their current printed positions. Unknown encodings
  // and detached targets remain reportable without a guessed page.
  for (const note of nodesNamed([...(script.fdx?.before ?? []), ...(script.fdx?.after ?? [])], "ScriptNote")) {
    const range = /^(\d+),(\d+)$/.exec(attr(note, "Range") ?? "");
    const target = range && Number(range[1]) <= Number(range[2]) && !attr(note, "InklotUnresolvedNote")
      ? fdxPositionAt(script.paragraphs, Number(range[1])) : null;
    const place = target && loc.get(target.paragraphId);
    rows.push({ ...(place ?? { paragraphId: "", sceneId: "", scene: "", heading: attr(note, "InklotUnresolvedNote") ? "Detached ScriptNote" : "Imported range not anchored", page: "" }),
      kind: `Imported ScriptNote (range ${attr(note, "Range") || "unknown"})`, text: noteText(note) });
  }
  return rows;
}
export function elementReport(script: Script, pagination: Pagination, types: ReadonlySet<ElementType>): ElementRow[] {
  const loc = locations(script, pagination);
  return script.paragraphs.filter((p) => types.has(p.type) && !NON_PRINTING.has(p.type)).map((p) => ({ ...loc.get(p.id)!, type: p.type, text: spokenText(p) }));
}
export interface SceneSpeakerRow extends ReportLine { character: string; speeches: number; words: number; }
/** Speaking presence only. This deliberately does not invent silent appearances or shoot days. */
export function sceneSpeakerReport(script: Script, pagination: Pagination): SceneSpeakerRow[] {
  const rows = new Map<string, SceneSpeakerRow>();
  for (const speech of dialogueReport(script, pagination)) {
    const key = JSON.stringify([speech.sceneId, speech.character]);
    const row = rows.get(key) ?? { ...speech, speeches: 0, words: 0 };
    row.speeches++; row.words += speech.words; rows.set(key, row);
  }
  return [...rows.values()];
}
export function escapeReportHtml(text: unknown): string {
  return String(text).replace(/[&<>"']/g, (s) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[s]!);
}
export interface ReportLayout { paper?: "letter" | "a4"; landscape?: boolean; layout?: "table" | "speeches"; revision?: string; date?: string; widths?: number[]; }
export function reportHtml(title: string, columns: string[], rows: (string | number)[][], options: ReportLayout = {}): string {
  const e = escapeReportHtml, paper = options.paper === "a4" ? "A4" : "letter", orientation = options.landscape ? "landscape" : "portrait";
  const widths = columns.map((_, i) => Math.max(60, Math.min(600, options.widths?.[i] ?? 150))), total = widths.reduce((a,b) => a+b, 0);
  const body = options.layout === "speeches" ? rows.map(r => `<article class="speech">${r.map((value,i) => `<div><strong>${e(columns[i])}</strong><p>${e(value)}</p></div>`).join("")}</article>`).join("")
    : `<table><colgroup>${widths.map(w=>`<col style="width:${(w/total*100).toFixed(3)}%">`).join("")}</colgroup><thead><tr>${columns.map(c=>`<th>${e(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${e(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${e(title)}</title><style>@page{size:${paper} ${orientation};margin:0.6in}body{font:11px/1.5 -apple-system,Arial,sans-serif;color:#111}h1{font-size:20px}table{border-collapse:collapse;width:100%;table-layout:fixed}th{text-align:left;border-bottom:2px solid #333}td,th{padding:6px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}tr{break-inside:avoid}td{border-bottom:1px solid #ddd}thead{display:table-header-group}.speech{border-top:1px solid #999;padding:12px 0;break-inside:auto}.speech strong{break-after:avoid;color:#444}.speech p{margin:2px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;orphans:2;widows:2}</style></head><body><h1>${e(title)}</h1><p>${rows.length} entries · Source page numbers retained${options.revision?` · ${e(options.revision)}`:""}${options.date?` · ${e(options.date)}`:""}</p>${body}</body></html>`;
}

export interface TagOccurrence extends ReportLine { number: string; label: string; category: string; text: string; resolved: boolean; }
/** Reads existing FDX tags. Unknown definitions remain visible; they are never assigned a guessed category. */
export function tagReport(script: Script, pagination: Pagination): TagOccurrence[] {
  const definitions = new Map(tagDefinitions(script).map(d => [d.number, d]));
  const places = locations(script, pagination), result: TagOccurrence[] = [];
  for (const p of script.paragraphs) {
    let last: TagOccurrence | undefined;
    for (const run of p.runs) {
      const number = run.fdx?.TagNumber;
      if (!number || run.note || !run.text) { last = undefined; continue; }
      if (last?.number === number) { last.text += run.text; continue; }
      const definition = definitions.get(number);
      last = { ...places.get(p.id)!, number, label: definition?.label || `Tag ${number}`, category: definition?.category || "Unresolved category", resolved: !!definition?.category, text: run.text };
      result.push(last);
    }
  }
  return result;
}
export interface TagSummary { number: string; label: string; category: string; occurrences: number; scenes: string; pages: string; paragraphId: string; }
export function tagsByTag(rows: readonly TagOccurrence[]): TagSummary[] {
  const groups = new Map<string, TagOccurrence[]>();
  for (const r of rows) { const group = groups.get(r.number) ?? []; group.push(r); groups.set(r.number, group); }
  return [...groups.values()].map((group) => ({ number: group[0]!.number, label: group[0]!.label, category: group[0]!.category,
    occurrences: group.length, scenes: [...new Set(group.map((r) => r.scene).filter(Boolean))].join(", "),
    pages: [...new Set(group.map((r) => r.page).filter(Boolean))].join(", "), paragraphId: group[0]!.paragraphId }));
}
