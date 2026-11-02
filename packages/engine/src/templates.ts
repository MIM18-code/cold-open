// Document templates: the element geometry, page rules, scene-number convention and starting act structure for
// the script formats Final Draft ships. templateScript builds a new document; applyDocumentTemplate changes an
// existing one without touching its words. Both write FDX ElementSettings and PageLayout, so PDF, FDX and the
// editor all read the same layout.
import type { ScreenplayDoc } from "./doc.ts";
import { newId } from "./ids.ts";
import { ELEMENT_LAYOUT, PAGE } from "./layout.ts";
import { plainText, type ElementType, type Paragraph, type Script } from "./model.ts";
import { characterName } from "./reports.ts";
import { writeStyle, type DocumentStyle } from "./styles.ts";
import { isTemplateId, type TemplateId } from "./template-rules.ts";

const BASE_RETURNS: DocumentStyle["returns"] = {
  sceneHeading: "action", action: "action", character: "dialogue", parenthetical: "dialogue",
  dialogue: "action", transition: "sceneHeading", newAct: "sceneHeading", endOfAct: "newAct",
};

/** The layout a template applies. Each template starts from Final Draft's screenplay geometry. */
export function templateStyle(id: TemplateId): DocumentStyle {
  const style: DocumentStyle = {
    page: { ...PAGE },
    elements: structuredClone(ELEMENT_LAYOUT),
    returns: { ...BASE_RETURNS },
  };

  if (id === "oneHourDrama") {
    style.elements.newAct = { ...style.elements.newAct, spaceBefore: 0 };
    style.elements.endOfAct = { ...style.elements.endOfAct, spaceBefore: 2 };
  }

  if (id === "halfHourComedy") {
    style.elements.newAct = { ...style.elements.newAct, spaceBefore: 0 };
    style.elements.endOfAct = { ...style.elements.endOfAct, spaceBefore: 2 };
  }

  if (id === "multiCamera") {
    // Multi-camera pages are laid out for a rehearsal room: action and parentheticals in capitals, dialogue
    // double spaced, scene headings underlined, and a new cue after each speech.
    style.elements.action = { ...style.elements.action, caps: true };
    style.elements.sceneHeading = { ...style.elements.sceneHeading, underline: true };
    style.elements.parenthetical = { ...style.elements.parenthetical, left: 2.5, right: 6.0, caps: true, spacing: 2, firstIndent: 0 };
    style.elements.dialogue = { ...style.elements.dialogue, spacing: 2 };
    style.elements.newAct = { ...style.elements.newAct, spaceBefore: 0 };
    style.elements.endOfAct = { ...style.elements.endOfAct, spaceBefore: 2 };
    style.returns = { ...style.returns, dialogue: "character", action: "character" };
  }

  if (id === "stage") {
    // US stage play: names centered, speeches wide, stage directions indented and italic, no INT./EXT. headings.
    style.elements.character = { ...style.elements.character, left: 1.5, right: 7.0, align: "center" };
    style.elements.dialogue = { ...style.elements.dialogue, left: 1.5, right: 7.0 };
    style.elements.parenthetical = { ...style.elements.parenthetical, left: 2.0, right: 6.5, italic: true, firstIndent: 0 };
    style.elements.action = { ...style.elements.action, left: 1.75, right: 7.0, italic: true };
    style.elements.sceneHeading = { ...style.elements.sceneHeading, left: 1.0, right: 7.5, align: "center", underline: false };
    style.elements.newAct = { ...style.elements.newAct, bold: false, underline: true, spaceBefore: 0 };
    style.elements.endOfAct = { ...style.elements.endOfAct, bold: false, underline: true };
    style.elements.castList = { ...style.elements.castList, caps: true };
    style.returns = {
      ...style.returns, newAct: "sceneHeading", endOfAct: "newAct", sceneHeading: "action",
      action: "character", character: "dialogue", parenthetical: "dialogue", dialogue: "character",
    };
  }

  return style;
}

function paragraph(type: ElementType, text = "", scene = false): Paragraph {
  const id = newId();
  return { id, type, runs: text ? [{ text }] : [], ...(scene ? { sceneId: id } : {}) };
}

const scene = () => paragraph("sceneHeading", "", true);
// Later acts get an empty action line to type into, not an empty heading that would list as an untitled scene.
const slot = () => paragraph("action");
const act = (text: string) => paragraph("newAct", text);
const end = (text: string) => paragraph("endOfAct", text);

/**
 * The paragraphs a new script starts with. TV act counts follow what the Writers Guild Foundation documents as
 * current: a teaser and five acts for one-hour drama, a cold open, three acts and a tag for single-camera comedy,
 * and the classic cold open, two acts and a tag for multi-camera. A stage play starts with one act and one scene;
 * its act count is a writing choice, not a format rule.
 */
export function templateParagraphs(id: TemplateId): Paragraph[] {
  if (id === "feature") return [scene()];
  if (id === "oneHourDrama") {
    const parts = [act("TEASER"), scene(), end("END OF TEASER")];
    for (const name of ["ONE", "TWO", "THREE", "FOUR", "FIVE"]) parts.push(act(`ACT ${name}`), slot(), end(`END OF ACT ${name}`));
    return parts;
  }
  if (id === "halfHourComedy") {
    const parts = [act("COLD OPEN"), scene(), end("END OF COLD OPEN")];
    for (const name of ["ONE", "TWO", "THREE"]) parts.push(act(`ACT ${name}`), slot(), end(`END OF ACT ${name}`));
    parts.push(act("TAG"), slot(), end("END OF TAG"));
    return parts;
  }
  if (id === "multiCamera") {
    return [
      act("COLD OPEN"), scene(), end("END OF COLD OPEN"),
      act("ACT ONE"), slot(), end("END OF ACT ONE"),
      act("ACT TWO"), slot(), end("END OF ACT TWO"),
      act("TAG"), slot(), end("END OF TAG"),
    ];
  }
  return [act("ACT ONE"), paragraph("sceneHeading", "SCENE 1", true)];
}

/** A new script for a template, with its layout stored as FDX data so it survives a save and export. */
export function templateScript(id: TemplateId): Script {
  const script: Script = { titlePage: [], paragraphs: templateParagraphs(id), ...(id === "feature" ? {} : { template: id }) };
  if (id !== "feature") script.fdx = writeStyle(script, templateStyle(id));
  return script;
}

/** The move a multi-camera script underlines: who comes on or goes off, and the verb. */
const ENTRANCE = /\b(?:enters|exits|entering|exiting|enter|exit)\b/i;
const CLAUSE = /^(?:BEFORE|AFTER|WHEN|WHILE|AS|UNTIL|THEN|AND|SO|BUT|ONCE|SINCE)$/;
const DETERMINER = /^(?:A|AN|THE|OF|HIS|HER|ITS|THEIR|OUR|MY|YOUR|SOME|EVERY|ANOTHER)$/;
const NOT_A_NAME = /^(?:A|AN|THE|AND|OR|BUT|THEN|SO|AS|&|I|WE|YOU|HE|SHE|IT|THEY|HIM|HER|THEM|WHO|ONE|SOMEONE|EVERYONE|NOBODY|ALL|BOTH|EACH|THIS|THAT)$/;

/**
 * Character ranges to underline for each entrance or exit: a capitalized name matching a cue through the verb
 * ("MAYA ENTERS", "MAYA AND ELI EXIT" style), or from the sentence start when no capitalized name precedes it.
 */
export function entranceRanges(text: string, characterCues: Iterable<string> = []): [number, number][] {
  const names = new Set(Array.from(characterCues, characterName));
  const ranges: [number, number][] = [];
  const sentence = /[^.!?\n]+[.!?]*/g;
  for (let match = sentence.exec(text); match; match = sentence.exec(text)) {
    const verb = ENTRANCE.exec(match[0]);
    if (!verb) continue;
    const before = match[0].slice(0, verb.index);
    // Character names in action are in capitals ("MAYA", "DR. O'NEIL"); "AND" and "&" join two of them. Multi-camera
    // action is all capitals, so look for the longest run of known names that ends right before the verb.
    const caps = /((?:\p{Lu}[\p{Lu}\p{N}'’.-]*|&)\s+)+$/u.exec(before);
    let name: { index: number } | null = null;
    if (caps) {
      const words = [...caps[0].matchAll(/\S+/g)];
      for (let k = 0; k < words.length && !name; k++) {
        const parts = caps[0].slice(words[k]!.index).trim().split(/\s+(?:AND|&)\s+/);
        if (!/^(?:AND|&)$/.test(words[k]![0]) && parts.every((part) => names.has(characterName(part))))
          name = { index: caps.index + words[k]!.index! };
      }
      // A first entrance often comes before the character's first line: then the capitalized word right before the
      // verb is the name, unless it is a pronoun or a function word.
      // A known name joined by AND or & comes along ("MARY JANE AND STRANGER EXIT"). Bare "enter" and "exit" after a
      // lone unknown word are usually nouns ("FIRE EXIT"), so they need that joined, plural subject.
      let first = words.length - 1;
      // A word just after an article, possessive or "OF" is a common noun ("THE DOOR", "SOUND OF TRAFFIC"), not a name.
      // Look at the two words before it in the whole sentence, ignoring case ("THE BROKEN DOOR", "The DOOR exits").
      // A conjunction or preposition right before the name starts a new clause, so words before it do not count
      // ("WE HEAR HER BEFORE MARY ENTERS"). When it is still unclear ("THEIR DAUGHTER MARY"), it is left to the writer.
      let lead = first >= 0 ? before.slice(0, caps.index + words[first]!.index!).trim().split(/\s+/).slice(-2) : [];
      if (lead.length === 2 && CLAUSE.test(lead[1]!.toUpperCase().replace(/[,;:]$/, ""))) lead = [];
      if (!name && first >= 0 && !NOT_A_NAME.test(words[first]![0]) && !lead.some((word) => DETERMINER.test(word.toUpperCase()))) {
        while (first >= 2 && /^(?:AND|&)$/.test(words[first - 1]![0])) {
          const span = Array.from({ length: first - 1 }, (_, k) => first - 1 - k).find((length) =>
            names.has(characterName(words.slice(first - 1 - length, first - 1).map((word) => word[0]).join(" "))));
          if (!span) break;
          first -= 1 + span;
        }
        if (first < words.length - 1 || !/^(?:enter|exit)$/i.test(verb[0])) name = { index: caps.index + words[first]!.index! };
      }
      if (!name) continue;
    }
    if (/^exit$/i.test(verb[0]) && /^\s+sign\b/i.test(match[0].slice(verb.index + verb[0].length))) continue;
    // Plain "enter"/"exit" is a verb only after a name ("MAYA AND ELI EXIT"); otherwise it is the noun ("exit sign").
    if (!name && /^(?:enter|exit)$/i.test(verb[0])) continue;
    let from = match.index + (name ? name.index : 0);
    const to = match.index + verb.index + verb[0].length;
    while (from < to && /\s/.test(text[from]!)) from++;
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

/** Underline every action sentence that brings a character on or takes one off. */
export function underlineEntrances(doc: ScreenplayDoc): number {
  let changed = 0;
  const names = doc.paragraphs().filter((paragraph) => paragraph.type === "character").map((paragraph) => plainText(paragraph.runs));
  for (const paragraph of doc.paragraphs()) {
    if (paragraph.type !== "action") continue;
    const text = plainText(paragraph.runs);
    for (const [from, to] of entranceRanges(text, names)) {
      let at = 0;
      if (paragraph.runs.every((run) => { const start = at; at += run.text.length; return at <= from || start >= to || run.underline; })) continue;
      doc.format(paragraph.id, from, to - from, { underline: true });
      changed++;
    }
  }
  return changed;
}

/** Put stage directions in parentheses. Only action paragraphs that are not already wrapped are changed. */
export function parenthesizeStageDirections(doc: ScreenplayDoc): number {
  let changed = 0;
  for (const paragraph of doc.paragraphs()) {
    if (paragraph.type !== "action") continue;
    const text = plainText(paragraph.runs.filter((run) => !run.note)).trim();
    if (!text || (text.startsWith("(") && text.endsWith(")")) || (text.startsWith("[") && text.endsWith("]"))) continue;
    const length = plainText(paragraph.runs).length;
    doc.insertFormatted(paragraph.id, length, ")", {});
    doc.insertFormatted(paragraph.id, 0, "(", {});
    changed++;
  }
  return changed;
}

export interface ApplyTemplateOptions {
  /** Multi-camera: underline action sentences that say a character enters or exits. Default true. */
  underlineEntrances?: boolean;
  /** Stage: put action paragraphs in parentheses. Default off; the template picker offers it. */
  parenthesizeStageDirections?: boolean;
  /** A style the writer adjusted in the layout dialog. Defaults to the template's own. */
  style?: DocumentStyle;
}

/**
 * Apply a template's layout and rules to an open document, in the caller's transaction. Existing words are kept;
 * only the optional entrance underline and stage-direction parentheses change runs. One undo takes all of it back.
 */
export function applyDocumentTemplate(doc: ScreenplayDoc, id: TemplateId, options: ApplyTemplateOptions = {}): void {
  if (!isTemplateId(id)) throw new Error("Unknown template.");
  const fdx = writeStyle(doc.toScript(), options.style ?? templateStyle(id));
  doc.ydoc.transact(() => {
    doc.meta.set("fdx", fdx);
    doc.meta.set("template", id);
    if (id === "multiCamera" && options.underlineEntrances !== false) underlineEntrances(doc);
    if (id === "stage" && options.parenthesizeStageDirections) parenthesizeStageDirections(doc);
  });
}

/** The template recorded on a document, if it still has one. */
export function documentTemplate(doc: ScreenplayDoc): TemplateId | undefined {
  const value = doc.meta.get("template");
  return isTemplateId(value) ? value : undefined;
}
