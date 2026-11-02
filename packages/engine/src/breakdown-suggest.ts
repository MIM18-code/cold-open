import { NON_PRINTING, plainText, scenesOf, type Paragraph, type Script } from "./model.ts";
import { TAG_CATEGORIES, tagDefinitions } from "./tags.ts";

export interface BreakdownSuggestion {
  id: string;
  sceneIndex: number;
  category: string;
  label: string;
  paragraphId: string;
  start: number;
  end: number;
  quote: string;
  source: "script" | "model";
}
export type ElementSpan = Pick<BreakdownSuggestion, "paragraphId" | "start" | "end">;

const MARKS: Record<string, string> = { "‘": "'", "’": "'", "ʼ": "'", "“": '"', "”": '"', "–": "-", "—": "-", "\u00a0": " " };
const plainMarks = (text: string) => text.replace(/[‘’ʼ“”–—\u00a0]/g, mark => MARKS[mark]!);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = /[\p{L}\p{N}\p{M}_]/u;

function sceneParagraphs(script: Script, sceneIndex: number): Paragraph[] {
  const scene = scenesOf(script.paragraphs)[sceneIndex];
  return scene ? script.paragraphs.slice(scene.start, scene.end) : [];
}

function available(paragraph: Paragraph, start: number, end: number): boolean {
  let at = 0;
  for (const run of paragraph.runs) {
    const next = at + run.text.length;
    if (next > start && at < end && (run.note || run.fdx?.TagNumber)) return false;
    at = next;
  }
  return true;
}

function visible(paragraph: Paragraph): { text: string; offsets: number[] } {
  let text = "", at = 0;
  const offsets: number[] = [];
  for (const run of paragraph.runs) {
    if (!run.note) {
      text += run.text;
      for (let i = 0; i < run.text.length; i++) offsets.push(at + i);
    }
    at += run.text.length;
  }
  return { text, offsets };
}

function firstMatch(paragraphs: Paragraph[], texts: string[]): ElementSpan | null {
  const patterns = texts.filter(text => text.trim()).map(text => new RegExp(escape(plainMarks(text)), "giu"));
  for (const paragraph of paragraphs) {
    const shown = visible(paragraph), text = plainMarks(shown.text);
    const hits = patterns.flatMap(pattern => [...text.matchAll(pattern)]).sort((a, b) => a.index - b.index || b[0].length - a[0].length);
    for (const hit of hits) {
      const left = hit.index, right = left + hit[0].length;
      if ((left && word.test([...text.slice(0, left)].at(-1)!)) || (right < text.length && word.test([...text.slice(right)][0]!))) continue;
      const start = shown.offsets[left]!, end = shown.offsets[right - 1]! + 1;
      if (available(paragraph, start, end)) return { paragraphId: paragraph.id, start, end };
    }
  }
  return null;
}

export function locateElement(script: Script, sceneIndex: number, text: string): ElementSpan | null {
  // Action lines only: a thing mentioned in dialogue isn't on set (the screenwriting MCP tagger's rule).
  return firstMatch(sceneParagraphs(script, sceneIndex).filter(p => p.type === "action"), [text]);
}

function suggestion(script: Script, sceneIndex: number, category: string, label: string, span: ElementSpan, source: BreakdownSuggestion["source"]): BreakdownSuggestion {
  const paragraph = script.paragraphs.find(p => p.id === span.paragraphId)!;
  return { id: JSON.stringify([sceneIndex, category, label.toLowerCase(), span.paragraphId, span.start, span.end]), sceneIndex, category, label, ...span,
    quote: plainText(paragraph.runs).slice(span.start, span.end), source };
}

export function castSuggestions(script: Script, sceneIndex: number): BreakdownSuggestion[] {
  const paragraphs = sceneParagraphs(script, sceneIndex), action = paragraphs.filter(p => p.type === "action");
  const seen = new Set<string>(), out: BreakdownSuggestion[] = [];
  const cueName = (p: Paragraph) => visible(p).text.replace(/\s*\([^)]*\)/g, "").trim();
  const cues = new Set(script.paragraphs.filter(p => p.type === "character").map(cueName));
  // A first name stands for a character only when no other two-word cue shares it (JOHN SMITH and JOHN DOE).
  const firsts = new Map<string, number>();
  for (const name of new Set([...cues].map(cue => cue.toLowerCase()))) {
    // A one-word cue (JOHN) claims its name too, so JOHN SMITH's first name is ambiguous beside it.
    const words = name.split(/\s+/);
    if (words.length <= 2) firsts.set(words[0]!, (firsts.get(words[0]!) ?? 0) + 1);
  }
  const firstName = (name: string) => { const words = name.split(/\s+/); return words.length === 2 && firsts.get(words[0]!.toLowerCase()) === 1 ? words[0]! : null; };
  // Cast already tagged in this scene, by tagged words and by tag name, so a tagged character isn't offered again.
  const definitions = new Map(tagDefinitions(script).map(d => [d.number, d]));
  // Formatting splits a tagged name into runs ("Ma" in bold, "ya"), so adjacent runs with one tag are read together.
  const tagged = new Set<string>();
  for (const p of paragraphs) {
    // A tagged line turned into a note no longer prints, so its tag doesn't cover anyone (the .sex export agrees).
    if (NON_PRINTING.has(p.type)) continue;
    let number = "", text = "";
    const flush = () => {
      const d = definitions.get(number);
      // A tagged cue reads "MAYA SANTOS (V.O.)"; the extension isn't part of the name.
      if (d?.category === "Cast Members") tagged.add(text.replace(/\s*\([^)]*\)/g, "").trim().toLowerCase()).add(d.label.trim().toLowerCase());
      number = ""; text = "";
    };
    for (const r of p.runs) {
      if (r.note) continue;
      const tag = r.fdx?.TagNumber ?? "";
      if (tag !== number) flush();
      number = tag; text += r.text;
    }
    flush();
  }
  const offer = (name: string, cue: Paragraph | null) => {
    if (!name || name.length > 200 || seen.has(name.toLowerCase())) return;
    const first = firstName(name);
    if (tagged.has(name.toLowerCase()) || (first && tagged.has(first.toLowerCase()))) { seen.add(name.toLowerCase()); return; }
    // The full name wins over a first-name mention; the cue is the last resort for someone who speaks.
    const span = firstMatch(action, [name]) ?? (first ? firstMatch(action, [first]) : null) ?? (cue ? firstMatch([cue], [name]) : null);
    if (!span && !cue) return;
    seen.add(name.toLowerCase());
    if (span) out.push(suggestion(script, sceneIndex, "Cast Members", name, span, "script"));
  };
  for (const cue of paragraphs.filter(p => p.type === "character")) offer(cueName(cue), cue);
  // Characters who are in the scene without speaking: their name in capitals in an action line, as when a character is
  // introduced ("TOMMY MULLEN (18) beside her"). Only names that have a cue somewhere in the script count.
  const capitals = (text: string) => action.some(p => new RegExp(`(?<![\\p{L}\\p{N}])${escape(text)}(?![\\p{L}\\p{N}])`, "u").test(visible(p).text));
  for (const name of cues) {
    const first = firstName(name);
    if (!seen.has(name.toLowerCase()) && (capitals(name) || (first && capitals(first)))) offer(name, null);
  }
  return out;
}

const categories = new Map<string, string>(TAG_CATEGORIES.map(([name]) => [name.toLowerCase(), name]));
for (const [alias, name] of Object.entries({ extras: "Background Actors", sfx: "Special Effects", vfx: "Visual Effects", "hair/makeup": "Makeup/Hair", "hair / makeup": "Makeup/Hair", "makeup / hair": "Makeup/Hair", costumes: "Wardrobe", "sound effects": "Sound" })) categories.set(alias, name);

export function normalizeSuggestions(raw: unknown, script: Script, sceneIndex: number): BreakdownSuggestion[] {
  const out = castSuggestions(script, sceneIndex).slice(0, 30), seen = new Set<string>();
  const elements = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "elements" in raw ? raw.elements : [];
  if (!Array.isArray(elements)) return out;
  for (const item of elements) {
    if (out.length >= 30) break;
    if (!item || typeof item !== "object" || typeof item.category !== "string" || typeof item.text !== "string") continue;
    // Small models sometimes drop the label or call it name; the quoted words still make a usable one.
    const named = typeof item.label === "string" ? item.label : typeof item.name === "string" ? item.name : item.text;
    const category = categories.get(item.category.trim().toLowerCase()), label = named.trim().replace(/[.,;:]+$/, "");
    if (!category || category === "Cast Members" || !label || label.length > 200) continue;
    const key = JSON.stringify([category, label.toLowerCase()]);
    if (seen.has(key)) continue;
    // A small model often quotes the whole sentence; the element's own name makes a tighter highlight when it's there.
    const long = item.text.trim().split(/\s+/).length > 6;
    // A sentence that can't be narrowed is dropped rather than highlighted whole; the writer can tag it by hand.
    const span = long ? locateElement(script, sceneIndex, label) : locateElement(script, sceneIndex, item.text);
    if (!span) continue;
    seen.add(key);
    out.push(suggestion(script, sceneIndex, category, label, span, "model"));
  }
  return out;
}
