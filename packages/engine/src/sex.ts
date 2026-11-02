// Movie Magic Scheduling export (.sex, Final Draft's "Scheduling Export").
//
// The file is a tiny big-endian record stream:
//
//   "SSI*" 00
//   { '#' u32be bodyLength body 00 }
//
// The final 00 belongs to the record stream, not to the record's length: every sample writes one
// between records and leaves it off after the last record. The first record is the category table.
// Later records are scenes (type 1), scene lengths (type 3) and tagged elements (type 2).
//
// Text is Mac Roman, not ASCII, Latin-1 or UTF-8. The Screenwriter sample spells an em dash as 0xD1
// and a right single quote as 0xD5; those bytes are nonsense as Latin-1 and invalid as UTF-8.
import { normalizeCharacterName } from "./characters.ts";
import { NON_PRINTING, type Script, plainText, scenesOf } from "./model.ts";
import { tagDefinitions } from "./tags.ts";

/** The category table every sample writes, in category-index order. */
export const SEX_CATEGORIES = [
  "Cast Members", "Extras", "Stunts", "Vehicles", "Props", "Special Effects", "Costumes", "Makeup",
  "Livestock", "Animal Handler", "Music", "Sound", "Set Dressing", "Greenery", "Special Equipment",
  "Security", "Additional Labor", "Optical FX", "Mechanical FX", "Miscellaneous", "Notes",
] as const;

const CAST_CATEGORY = 0;
const MISCELLANEOUS_CATEGORY = 19;

/** Final Draft's tag categories, mapped onto the .sex category indexes. */
const TAG_CATEGORY_INDEX: Readonly<Record<string, number>> = {
  "Cast Members": 0,
  "Background Actors": 1,
  "Stunts": 2,
  "Vehicles": 3,
  "Props": 4,
  "Special Effects": 5,
  "Wardrobe": 6,
  "Makeup/Hair": 7,
  "Animals": 8,
  "Music": 10,
  "Sound": 11,
  "Set Dressing": 12,
  "Visual Effects": 17,
  "Miscellaneous": MISCELLANEOUS_CATEGORY,
};

export interface SexHeader {
  type: "header";
  /**
   * Zero bytes before the first category name. Final Draft writes two; Movie Magic Screenwriter 6
   * writes four. Nothing else in the body distinguishes the two, so keep the prefix verbatim.
   */
  prefix: Uint8Array;
  categories: string[];
}

export interface SexSceneRecord {
  type: "scene";
  sequence: number;
  /** Page label where the scene starts, such as "1" or "12A". */
  page: string;
  /** Scene number as printed, such as "1" or "12A". */
  number: string;
  heading: string;
  /** How the text ends: Final Draft and Gorilla write a tab, Screenwriter 6 writes a NUL byte. */
  terminator: "tab" | "nul" | "none";
}

export interface SexLengthRecord {
  type: "length";
  sequence: number;
  /** Whole pages in the scene's length. */
  pages: number;
  /** Eighths on the last page, 0 to 8. Screenwriter writes 8 instead of carrying it into pages. */
  eighths: number;
}

export interface SexElementRecord {
  type: "element";
  sequence: number;
  /** Zero-based index into the file's category table. */
  category: number;
  name: string;
}

/** A record this parser does not understand, kept whole so writing the file back loses nothing. */
export interface SexUnknownRecord {
  type: "unknown";
  code: number;
  body: Uint8Array;
}

export type SexRecord = SexHeader | SexSceneRecord | SexLengthRecord | SexElementRecord | SexUnknownRecord;

export interface SexFile {
  records: SexRecord[];
  /** True when a parsed file ended with the record separator after its last record. */
  trailingSeparator?: boolean;
}

export interface SexScene {
  scene: SexSceneRecord;
  length?: SexLengthRecord;
  elements: SexElementRecord[];
}

const decoder = new TextDecoder("macintosh");
let encoder: Map<string, number> | undefined;

function macRomanEncoder(): Map<string, number> {
  if (encoder) return encoder;
  const table = new Map<string, number>();
  for (let byte = 0; byte < 0x80; byte++) table.set(String.fromCharCode(byte), byte);
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const character = decoder.decode(Uint8Array.of(byte));
    if (!table.has(character)) table.set(character, byte);
  }
  encoder = table;
  return table;
}

// Safety net for characters a platform's Mac Roman table may not hold. Curly quotes and em dashes are
// in Mac Roman, so normally the table encodes them directly; these spellings keep a missing one readable.
const TEXT_FALLBACKS: Readonly<Record<string, string>> = {
  "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "--",
  "\u2026": "...", "\u00a0": " ", "\u00ad": "-", "\u2022": "*",
};

function encodeText(text: string): Uint8Array {
  const table = macRomanEncoder();
  const bytes: number[] = [];
  for (const character of text) {
    const byte = table.get(character);
    if (byte !== undefined) {
      bytes.push(byte);
      continue;
    }
    const fallback = TEXT_FALLBACKS[character];
    if (fallback !== undefined) {
      for (const replaced of fallback) bytes.push(table.get(replaced) ?? 0x3f);
    } else {
      bytes.push(0x3f); // "?" for a character this format cannot spell.
    }
  }
  return Uint8Array.from(bytes);
}

function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function u16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
}

function pushU16(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`The .sex format cannot store ${value} as a 16-bit value.`);
  out.push((value >>> 8) & 0xff, value & 0xff);
}

function pushU32(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`The .sex format cannot store ${value} as a 32-bit length.`);
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function parseHeader(body: Uint8Array): SexHeader {
  let start = 0;
  while (start < body.length && body[start] === 0) start++;
  const categories: string[] = [];
  let field = start;
  for (let index = start; index < body.length; index++) {
    if (body[index] !== 0) continue;
    if (index > field) categories.push(decodeText(body.subarray(field, index)));
    field = index + 1;
  }
  if (field < body.length) categories.push(decodeText(body.subarray(field)));
  return { type: "header", prefix: body.slice(0, start), categories };
}

function parseScene(sequence: number, body: Uint8Array): SexSceneRecord {
  let end = body.length;
  let terminator: SexSceneRecord["terminator"] = "none";
  if (end > 0 && body[end - 1] === 0) {
    terminator = "nul";
    end--;
  } else if (end > 0 && body[end - 1] === 0x09) {
    terminator = "tab";
    end--;
  }
  const text = decodeText(body.subarray(0, end));
  const first = text.indexOf("\t");
  const second = first < 0 ? -1 : text.indexOf("\t", first + 1);
  if (second < 0) return { type: "scene", sequence, page: "", number: "", heading: text, terminator };
  return {
    type: "scene", sequence,
    page: text.slice(0, first),
    number: text.slice(first + 1, second),
    heading: text.slice(second + 1),
    terminator,
  };
}

function parseRecord(body: Uint8Array): SexRecord {
  if (body.length < 2) {
    return { type: "unknown", code: 0, body: body.slice() };
  }
  const code = u16(body, 0);
  if (code === 0) return parseHeader(body);
  if (code === 1 && body.length >= 4) return parseScene(u16(body, 2), body.subarray(4));
  if (code === 3 && body.length === 8) return { type: "length", sequence: u16(body, 2), pages: u16(body, 4), eighths: u16(body, 6) };
  if (code === 2 && body.length >= 6) return { type: "element", sequence: u16(body, 2), category: u16(body, 4), name: decodeText(body.subarray(6)) };
  return { type: "unknown", code, body: body.slice() };
}

export function parseSex(bytes: Uint8Array): SexFile {
  if (bytes.length < 5 || bytes[0] !== 0x53 || bytes[1] !== 0x53 || bytes[2] !== 0x49 || bytes[3] !== 0x2a) {
    throw new Error("Not a Movie Magic Scheduling export: the file does not start with SSI*.");
  }
  if (bytes[4] !== 0) throw new Error("Not a Movie Magic Scheduling export: the SSI* header is not followed by a zero byte.");
  const records: SexRecord[] = [];
  let offset = 5;
  let trailingSeparator = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0x23) throw new Error(`Invalid .sex record at byte ${offset}: expected #.`);
    offset++;
    if (offset + 4 > bytes.length) throw new Error("The .sex file ends in the middle of a record length.");
    const length = u32(bytes, offset);
    offset += 4;
    const end = offset + length;
    if (end > bytes.length) throw new Error("The .sex file ends in the middle of a record.");
    records.push(parseRecord(bytes.subarray(offset, end)));
    offset = end;
    trailingSeparator = false;
    if (offset < bytes.length) {
      if (bytes[offset] !== 0) throw new Error(`Invalid .sex record separator at byte ${offset}.`);
      offset++;
      trailingSeparator = true;
    }
  }
  return { records, ...(trailingSeparator ? { trailingSeparator } : {}) };
}

function recordBody(record: SexRecord): Uint8Array {
  if (record.type === "unknown") return record.body;
  const out: number[] = [];
  if (record.type === "header") {
    out.push(...record.prefix);
    for (const category of record.categories) {
      out.push(...encodeText(category), 0);
    }
    return Uint8Array.from(out);
  }
  if (record.type === "scene") {
    pushU16(out, 1);
    pushU16(out, record.sequence);
    const terminator = record.terminator === "tab" ? "\t" : record.terminator === "nul" ? "\u0000" : "";
    out.push(...encodeText(`${record.page}\t${record.number}\t${record.heading}${terminator}`));
    return Uint8Array.from(out);
  }
  if (record.type === "length") {
    pushU16(out, 3);
    pushU16(out, record.sequence);
    pushU16(out, record.pages);
    pushU16(out, record.eighths);
    return Uint8Array.from(out);
  }
  pushU16(out, 2);
  pushU16(out, record.sequence);
  pushU16(out, record.category);
  out.push(...encodeText(record.name));
  return Uint8Array.from(out);
}

export function writeSex(file: SexFile): Uint8Array {
  const out: number[] = [0x53, 0x53, 0x49, 0x2a, 0];
  file.records.forEach((record, index) => {
    const body = recordBody(record);
    out.push(0x23);
    pushU32(out, body.length);
    out.push(...body);
    if (index < file.records.length - 1 || file.trailingSeparator) out.push(0);
  });
  return Uint8Array.from(out);
}

/** Group the flat record stream into scenes, each with its length and elements. */
export function sexScenes(file: SexFile): SexScene[] {
  const scenes: SexScene[] = [];
  let current: SexScene | undefined;
  for (const record of file.records) {
    if (record.type === "scene") {
      current = { scene: record, elements: [] };
      scenes.push(current);
      continue;
    }
    if (!current) continue;
    if (record.type === "length") current.length = record;
    else if (record.type === "element") current.elements.push(record);
  }
  return scenes;
}

export interface SexFromScriptOptions {
  /** Printed page label for each scene, usually from pagination. Defaults to the scene's 1-based ordinal. */
  pages?: ReadonlyMap<string, string>;
  /** Scene lengths in eighths, when the caller knows them. Omitted lengths are written as zero. */
  lengths?: ReadonlyMap<string, number>;
}

function cleanField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build a breakdown sheet from a Cold Open script.
 *
 * Pass a Script that has already been through projectTags (ScreenplayDoc.toScript does this):
 * tags authored in the app keep their definitions in document meta until projection, and without it
 * their run TagNumbers have nothing to resolve to.
 */
export function sexFromScript(script: Script, options: SexFromScriptOptions = {}): SexFile {
  const records: SexRecord[] = [{ type: "header", prefix: Uint8Array.of(0, 0), categories: [...SEX_CATEGORIES] }];
  const definitions = new Map(tagDefinitions(script).map((definition) => [definition.number, definition]));
  const scenes = scenesOf(script.paragraphs);

  // Scene numbers must stay unique: an unnumbered scene added to a numbered draft takes the next free
  // "A" number after the scene before it (12A, 12B), the way locked drafts number inserts.
  const used = new Set(scenes.map((scene) => cleanField(scene.number ?? "").toUpperCase()).filter(Boolean));
  let previous = ""; // the last number the script itself gave, so a run of inserts reads 10A, 10B
  const visibleText = (paragraph: Script["paragraphs"][number]) => plainText(paragraph.runs.filter((run) => !run.note));
  scenes.forEach((scene, index) => {
    const sequence = index + 1;
    const page = cleanField(options.pages?.get(scene.sceneId) ?? "") || String(sequence);
    let number = cleanField(scene.number ?? "");
    if (number) previous = number;
    else {
      // In a numbered draft an insert follows the scene before it (10, 10A, 11); an unnumbered draft keeps ordinals.
      const base = used.size && previous ? previous : String(sequence);
      const letters = (n: number) => String.fromCharCode(65 + (n % 26)).repeat(Math.floor(n / 26) + 1);
      number = base === previous ? `${base}A` : base;
      for (let letter = base === previous ? 1 : 0; used.has(number.toUpperCase()); letter++) number = `${base}${letters(letter)}`;
      used.add(number.toUpperCase());
    }
    // Inline notes don't print, so they stay out of headings and cast names.
    const heading = cleanField(visibleText(script.paragraphs[scene.start]!));
    records.push({ type: "scene", sequence, page, number, heading, terminator: "tab" });

    const eighths = options.lengths?.get(scene.sceneId);
    const pages = eighths === undefined ? 0 : Math.floor(Math.max(0, eighths) / 8);
    records.push({ type: "length", sequence, pages, eighths: eighths === undefined ? 0 : Math.max(0, eighths) % 8 });

    const seen = new Set<string>();
    const add = (category: number, rawName: string) => {
      const name = cleanField(rawName);
      if (!name) return;
      const key = `${category}\u0000${name.toLocaleUpperCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      records.push({ type: "element", sequence, category, name });
    };

    for (const paragraph of script.paragraphs.slice(scene.start, scene.end)) {
      // A tagged line turned into a note or synopsis no longer prints, so it's no longer a production need.
      if (NON_PRINTING.has(paragraph.type)) continue;
      if (paragraph.type === "character") add(CAST_CATEGORY, normalizeCharacterName(visibleText(paragraph)));
      for (const run of paragraph.runs) {
        if (run.note) continue;
        const tagNumber = run.fdx?.TagNumber;
        if (!tagNumber) continue;
        const definition = definitions.get(tagNumber);
        if (!definition) continue;
        add(TAG_CATEGORY_INDEX[definition.category] ?? MISCELLANEOUS_CATEGORY, definition.label);
      }
    }
  });

  return { records };
}
