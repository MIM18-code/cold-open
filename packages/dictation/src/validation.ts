// Schema validation is not semantic accuracy: surface separate fidelity checks.
//
// A line-for-line port of Writers Block's validation.py. The rules, thresholds
// and messages are unchanged; test/parity checks the two against each other.

import {
  type Diagnostic, type Element, type ElementType, type Omission, type Proposal,
  ValidationError, copyProposal, makeElement, parseProposalObject, setElements,
} from "./models.ts";
import {
  ALNUM, B_END, B_START, Counter, PY_END, W, arraysEqual, capitalizeFirst, escape, head, rstrip,
  sorted, split, strip,
} from "./pyshim.ts";

// A placeholder cue means the model gave up on attribution: fix before committing.
// A pronoun cue is a fixable slip on the page; it pastes with a note.
// VOICE is not in the list: it is the standard cue for an unseen speaker.
export const UNRESOLVED_CUES = new Set(["UNKNOWN", "UNCLEAR", "TBD", "?"]);
export const PRONOUN_CUES = new Set(["HE", "SHE", "THEY", "HIM", "HER", "IT", "I", "YOU", "WE", "SOMEONE", "SOMEBODY"]);
// Checks that never stop an automatic paste; the helper shows them after pasting.
const CHECK_AFTER_PASTE = ["correction_unapplied", "correction_scope", "correction_in_dialogue",
  "missing_speech", "pronoun_speaker", "word_order", "cue_mismatch"];
const CUE_EXTENSION = new RegExp(String.raw`\s*\([^)]*\)\s*` + PY_END, "u");
// Small wording drift happens on almost every take, so a dropped or invented word
// is only worth a note after the paste once this many of them have piled up.
const NOTE_NEW_WORDS = 3;
const NOTE_OMITTED_WORDS = 4;
// A model's doubt about who speaks still stops an automatic paste. Doubt about a
// heading, an action line, a transition or a shot is a word to fix on the page.
const SPEECH_TYPES = new Set<ElementType>(["character", "dialogue", "parenthetical"]);
const CORRECTION_SOURCE = B_START + String.raw`(scratch that|no,? wait|no,? make that|correction|i mean)` + B_END;
const correctionTrigger = (flags = "") => new RegExp(CORRECTION_SOURCE, "iu" + flags);
// "scratch that last line" names what is retracted; those words are not a replacement.
const CORRECTION_SCOPE = /^[\s,:-]*(?:the\s+)?(?:last|previous|that|whole)?\s*(?:action|line|sentence|bit|part|thing|word)?[.,!?]?\s*/iu;
const SAYS_AT_END = new RegExp(B_START + "(says|said|say)" + PY_END, "u");
const SAYS_AT_END_I = new RegExp(B_START + "(says|said|say)" + PY_END, "iu");

const diagnostic = (code: string, severity: "warning" | "error", message: string, element_index: number | null = null): Diagnostic =>
  ({ code, severity, message, element_index });

/** Accept a complete JSON object, optionally fenced. Never salvage fragments. */
export function parseProposal(raw: string): Proposal {
  let text = strip(raw);
  // Some local chat templates emit this wrapper in content rather than metadata.
  if (text.startsWith("<think>")) {
    const end = text.indexOf("</think>");
    if (end < 0) throw new ValidationError("Incomplete thinking wrapper; no complete proposal received.");
    text = strip(text.slice(end + "</think>".length));
  }
  if (text.startsWith("```")) {
    const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u.exec(text);
    if (!match) throw new ValidationError("Incomplete JSON code fence.");
    text = strip(match[1]!);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("The model did not return valid JSON: " + String(error));
  }
  return parseProposalObject(data);
}

const WORD = new RegExp(ALNUM + "+(?:'" + ALNUM + "+)*", "gu");

export function words(text: string): string[] {
  return text.toLowerCase().replaceAll("’", "'").match(WORD) ?? [];
}

export function normalized(text: string): string {
  return split(text).join(" ");
}

/**
 * One spelling of a speaker cue: upper case, no extension, no stray marks.
 *
 * "UNKNOWN(V.O.)" and "TBD:" give up on the speaker exactly as plainly as
 * "UNKNOWN" does, so every cue check compares this instead of the raw text.
 */
export function cueKey(text: string): string {
  const cue = split(text.toUpperCase().replace(CUE_EXTENSION, "")).join(" ");
  return strip(cue, " \t.,:;-!?'\"*");
}

/** An omission note the model cannot anchor is dropped, not fatal. */
export function dropUnanchoredOmissions(proposal: Proposal, transcript: string): Proposal {
  const haystack = normalized(transcript);
  const anchored = (o: Omission) => haystack.includes(normalized(o.source_quote));
  const kept = proposal.omissions.filter(anchored);
  if (kept.length === proposal.omissions.length) return proposal;
  const copy = copyProposal(proposal);
  const dropped = proposal.omissions.filter((o) => !anchored(o)).map((o) => o.source_quote);
  copy.omissions = kept;
  copy.warnings = [...copy.warnings, "The model noted removed words it could not quote exactly: "
    + head(dropped.join("; "), 200)].slice(0, 50);
  return copy;
}

/** Generation must provide real source anchors. Human review can add text. */
export function sourceErrors(proposal: Proposal, transcript: string): string[] {
  const haystack = normalized(transcript);
  const errors: string[] = [];
  proposal.elements.forEach((element, index) => {
    const quote = normalized(element.source_quote);
    if (!quote || !haystack.includes(quote)) {
      errors.push(`Element ${index + 1}: source_quote must be an exact substring of current_transcript.`);
    }
  });
  proposal.omissions.forEach((omission, index) => {
    if (!haystack.includes(normalized(omission.source_quote))) {
      errors.push(`Omission ${index + 1}: source_quote is not in current_transcript.`);
    }
  });
  return errors;
}

export function structureDiagnostics(elements: Element[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  let inSpeech = false;
  let needsDialogueAt: number | null = null;
  elements.forEach((element, i) => {
    const t = element.type;
    if ((t === "character" || t === "scene_heading" || t === "transition" || t === "shot") && element.text.includes("\n")) {
      result.push(diagnostic("multiline_cue", "error", "A heading, cue, shot or transition must be one line.", i));
    }
    if (t === "character") {
      if (needsDialogueAt !== null) {
        result.push(diagnostic("empty_speech", "error", "Character cue has no dialogue.", needsDialogueAt));
      }
      inSpeech = true;
      needsDialogueAt = i;
      const cue = cueKey(element.text);
      if (!cue || UNRESOLVED_CUES.has(cue)) {
        result.push(diagnostic("unknown_speaker", "error", "Choose the speaker before committing or exporting.", i));
      } else if (PRONOUN_CUES.has(cue)) {
        result.push(diagnostic("pronoun_speaker", "warning",
          `The cue '${element.text}' is a pronoun. Replace it with the character's name.`, i));
      }
    } else if (t === "dialogue" || t === "parenthetical") {
      if (!inSpeech) {
        result.push(diagnostic("orphan_speech", "error", "Dialogue/parenthetical needs a character cue after the last action.", i));
      }
      needsDialogueAt = t === "dialogue" ? null : i;
    } else {
      if (needsDialogueAt !== null) {
        result.push(diagnostic("empty_speech", "error", "Character/parenthetical has no following dialogue.", needsDialogueAt));
      }
      inSpeech = false;
      needsDialogueAt = null;
    }
    if (element.uncertainty) result.push(diagnostic("uncertain", "warning", element.uncertainty, i));
  });
  if (needsDialogueAt !== null) {
    result.push(diagnostic("empty_speech", "error", "Character/parenthetical has no following dialogue.", needsDialogueAt));
  }
  return result;
}

/** Python's re.split(pattern, text, maxsplit=1)[0]. */
function firstPiece(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/** A recorded correction must have happened, and must not eat its replacement. */
export function correctionDiagnostics(proposal: Proposal, transcript = ""): Diagnostic[] {
  const result: Diagnostic[] = [];
  const texts = proposal.elements.map((e) => normalized(e.text).toLowerCase());
  const haystack = normalized(transcript).toLowerCase();
  for (const omission of proposal.omissions) {
    if (omission.reason !== "explicit_correction") continue;
    const quote = normalized(omission.source_quote).toLowerCase();
    const trigger = correctionTrigger().exec(quote);
    const position = quote ? haystack.indexOf(quote) : -1;
    const before = position >= 0 ? rstrip(haystack.slice(0, position), " ,:;-") : "";
    if (trigger && SAYS_AT_END.test(before)) {
      result.push(diagnostic("correction_in_dialogue", "warning",
        `'${omission.source_quote}' opens a character's line, so it is probably spoken `
        + "dialogue that was removed as a correction."));
    } else if (texts.some((text) => text.includes(quote))) {
      result.push(diagnostic("correction_unapplied", "warning",
        `The correction '${omission.source_quote}' was recorded but its words are still in the scene.`));
    } else if (trigger && strip(quote.slice(trigger.index + trigger[0].length).replace(CORRECTION_SCOPE, ""))) {
      result.push(diagnostic("correction_scope", "warning",
        `The correction '${omission.source_quote}' removed the words spoken after it. `
        + "Check that the retracted wording, not the replacement, was dropped."));
    }
  }
  proposal.elements.forEach((element, i) => {
    if ((element.type === "action" || element.type === "parenthetical") && correctionTrigger().test(element.text)) {
      result.push(diagnostic("correction_unapplied", "warning", "This paragraph still contains a dictation correction phrase.", i));
    }
  });
  // The words spoken after a correction are the replacement. If they are gone,
  // the model deleted the wrong side, and the sentence on the page is the one
  // the writer retracted.
  const output = new Counter(words(proposal.elements.map((e) => e.text).join(" ")));
  const skip = new Set(["and", "so", "um", "uh", "says", "said"]);
  for (const trigger of transcript.matchAll(correctionTrigger("g"))) {
    const before = rstrip(transcript.slice(0, trigger.index), " ,:;-");
    if (SAYS_AT_END_I.test(before)) continue; // a character's own words; handled above
    const rest = transcript.slice(trigger.index + trigger[0].length).replace(CORRECTION_SCOPE, "");
    const replacement = firstPiece(rest, /(?<=[.!?])\s/u);
    const missing = words(replacement).filter((w) => !skip.has(w) && output.get(w) < 1);
    if (strip(replacement) && missing.length) {
      result.push(diagnostic("correction_scope", "warning",
        `The words after '${trigger[1]}' are missing from the scene: `
        + head(missing.join(" "), 120) + ". The retracted wording, not the replacement, should go."));
      break;
    }
  }
  return result;
}

const NAME = `[A-Z]${W.slice(0, -1)}'-]*`;
const attribution = () => new RegExp(
  B_START + `(?<name>${NAME}(?:\\s+${NAME})?)\\s+(?:says|said)` + B_END + String.raw`(?<rest>[^.!?\n]*)`, "gu");
// "Nobody says a word." names no speaker; a cue for it would be an invented one.
const NOT_A_SPEAKER = new Set(["nobody", "noone", "somebody", "someone", "anybody", "anyone", "everybody",
  "everyone", "nothing", "something", "it", "that", "this", "there", "one"]);
// "She says nothing." and "Maya said otherwise." are narration about silence.
const SAYS_NOTHING = /^(?:[\s,:-]*(?:nothing(?:\s+at\s+all)?|not\s+a\s+word|a\s+word|so|otherwise|as\s+much|the\s+same|little|no\s+more)\s*)$/iu;

function plural(count: number, word: string): string {
  return count === 1 ? word : word + "s";
}

function namesNobody(name: string, rest: string): boolean {
  const lowered = name.toLowerCase();
  return NOT_A_SPEAKER.has(lowered) || NOT_A_SPEAKER.has(split(lowered).at(-1)!) || SAYS_NOTHING.test(rest);
}

/** Count the '[Name] says' attributions that should each produce a cue. */
export function spokenLines(transcript: string): number {
  let total = 0;
  for (const match of transcript.matchAll(attribution())) {
    if (!namesNobody(match.groups!.name!, match.groups!.rest!)) total += 1;
  }
  return total;
}

/** Every spoken '[Name] says' must have produced a character cue. */
export function missingSpeechDiagnostics(proposal: Proposal, transcript: string): Diagnostic[] {
  const spoken = spokenLines(transcript);
  const cues = proposal.elements.filter((e) => e.type === "character").length + mergedCues(proposal.elements).length;
  if (spoken > cues) {
    return [diagnostic("missing_speech", "warning",
      `The transcript attributes ${spoken} ${plural(spoken, "line")} with 'says' but the scene `
      + `has ${cues} character ${plural(cues, "cue")}. A line of dialogue may have been dropped.`)];
  }
  return [];
}

/** The names a quote spells out with 'says', skipping pronouns and idioms. */
export function attributedSpeakers(quote: string): string[] {
  const found: string[] = [];
  for (const match of quote.matchAll(attribution())) {
    const name = match.groups!.name!;
    if (namesNobody(name, match.groups!.rest!)) continue;
    if (PRONOUN_CUES.has(cueKey(name))) continue;
    found.push(name);
  }
  return found;
}

/** A cue may extend the spoken name or keep only the part that is the name. */
export function cueMatchesAttribution(cue: string, name: string): boolean {
  const cueParts = split(cue);
  const nameParts = split(name);
  if (arraysEqual(cueParts.slice(0, 1), nameParts.slice(0, 1))) return true;
  const cueSet = new Set(cueParts);
  const nameSet = new Set(nameParts);
  return [...cueSet].every((p) => nameSet.has(p)) || [...nameSet].every((p) => cueSet.has(p));
}

/** A cue that contradicts its own quote puts the line in the wrong mouth. */
export function cueMismatchDiagnostics(elements: Element[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  elements.forEach((element, i) => {
    if (element.type !== "character") return;
    const cue = cueKey(element.text);
    if (!cue || UNRESOLVED_CUES.has(cue) || PRONOUN_CUES.has(cue)) return;
    const spoken = attributedSpeakers(element.source_quote);
    if (!spoken.length || cueMatchesAttribution(cue, castKey(spoken[0]!))) return;
    result.push(diagnostic("cue_mismatch", "warning",
      `The cue ${element.text} does not match the spoken attribution ${spoken[0]}.`, i));
  });
  return result;
}

const FIDELITY_TYPES = new Set<ElementType>(["action", "dialogue", "parenthetical", "note"]);

/** Words this element added to its own source quote, and words it dropped. */
export function quoteDrift(element: Element): [Counter, Counter] {
  const spoken = new Counter(words(element.source_quote));
  const written = new Counter(words(element.text));
  return [written.minus(spoken), spoken.minus(written)];
}

// An omission pays for the words it names when the writer spoke a correction, or
// when it is a short formatting aside. A "formatting_instruction" that swallows a
// whole sentence is a lost line dressed up as a control phrase.
const MAX_FORMATTING_OMISSION_WORDS = 4;

function omissionIsCredited(omission: Omission): boolean {
  if (omission.reason === "explicit_correction") return true;
  const spoken = words(omission.source_quote);
  return spoken.every((word) => CONTROL_WORDS.has(word)) || spoken.length <= MAX_FORMATTING_OMISSION_WORDS;
}

export function audit(proposal: Proposal, transcript: string): Diagnostic[] {
  const result = [
    ...structureDiagnostics(proposal.elements), ...cueMismatchDiagnostics(proposal.elements),
    ...correctionDiagnostics(proposal, transcript), ...missingSpeechDiagnostics(proposal, transcript),
  ];
  for (const message of proposal.warnings) result.push(diagnostic("model_warning", "warning", message));
  for (const message of sourceErrors(proposal, transcript)) result.push(diagnostic("source_changed", "warning", message));
  proposal.elements.forEach((e, i) => {
    if (!FIDELITY_TYPES.has(e.type) || !e.source_quote) return;
    const [added, removed] = quoteDrift(e);
    if (added.size) {
      result.push(diagnostic("new_words", "warning",
        "Words that are not in the spoken source: " + head(added.keys().join(", "), 300), i));
    }
    if (removed.size) {
      result.push(diagnostic("removed_from_quote", "warning",
        "Spoken words left out here (often dictation cues, but check): " + head(removed.keys().join(", "), 300), i));
    }
    if (!added.size && !removed.size && !arraysEqual(words(e.text), words(e.source_quote))) {
      result.push(diagnostic("word_order", "warning", "The word order differs from what was spoken. Check for an unwanted rewrite.", i));
    }
  });
  // Deliberately a warning, not a fidelity score/guarantee. Cue/heading conversion
  // consumes speech controls, so exact word accounting would create false errors.
  const original = new Counter(words(transcript));
  const accounted = new Counter(words(proposal.elements.map((e) => e.text).join(" ")));
  accounted.update(words(proposal.omissions.filter(omissionIsCredited).map((o) => o.source_quote).join(" ")));
  const missing = original.minus(accounted);
  const count = missing.total();
  if (count >= 4) {
    result.push(diagnostic("omitted_words", "warning",
      `${count} spoken words are not in the result. Dictation cues such as `
      + "'interior' or 'says' are expected to go; compare the rest with your transcript. "
      + "Missing: " + missing.keys().slice(0, 16).join(", ")));
  }
  return result;
}

export function requireStructure(elements: Element[]): void {
  const errors = structureDiagnostics(elements).filter((d) => d.severity === "error").map((d) => d.message);
  if (errors.length) throw new ValidationError(errors.join(" "));
}

const TIME_OF_DAY = "(DAY|NIGHT|MORNING|EVENING|AFTERNOON|DAWN|DUSK|LATER|CONTINUOUS)";
// "all afternoon" and "the next day" are durations in a sentence, not a slug time.
const NOT_A_SLUG_TIME_AFTER = new Set(["ALL", "EVERY", "EACH", "THIS", "THAT", "WHOLE", "ENTIRE", "NEXT", "LAST",
  "UNTIL", "TILL", "BY", "BEFORE", "AFTER", "SINCE", "A", "AN", "THE", "PER"]);
const HEADING = /^(?:(interior|exterior|int\.?|ext\.?)\s+(?:of\s+)?([^.!?\n]+)[.!]?)$/iu;
const SLUG_TIME = new RegExp(String.raw`^(?:(.+?)\s+(?:-\s*)?` + TIME_OF_DAY + ")$", "u");

/** Normalize one explicit spoken heading without supplying a missing time. */
export function spokenHeading(quote: string): string | null {
  const match = HEADING.exec(strip(quote));
  if (!match) return null;
  const prefix = match[1]!.toLowerCase().startsWith("int") ? "INT." : "EXT.";
  // Punctuating ASR puts a comma before the time: "Interior kitchen, day".
  let location = strip(match[2]!).replace(/[\s,;:-]+$/u, "").toUpperCase();
  if (!location) return null;
  const time = SLUG_TIME.exec(location);
  if (time) {
    const place = time[1]!.replace(/[\s,;:-]+$/u, "");
    if (place && !NOT_A_SLUG_TIME_AFTER.has(split(place).at(-1)!)) location = place + " - " + time[2];
  }
  return prefix + " " + location;
}

/** '[Name] says' as it was spoken, at the start of a quote or inside one. */
function speakerCue(speaker: string, flags = ""): RegExp {
  const name = split(speaker).map(escape).join(String.raw`\s+`);
  return new RegExp(String.raw`(?:^|(?<=[\s,;:.!?]))(?:and\s+)?` + name + String.raw`\s+(?:says|said|say)` + B_END + String.raw`[\s,:-]*`, "iu" + flags);
}

/** Drop the attribution. A merged same-speaker line carries one per part. */
export function dialogueSource(quote: string, speaker: string): string {
  if (!speaker) return quote;
  return quote.replace(speakerCue(speaker, "g"), "");
}

/** The repeated '[Name] says' cues that mergeSplitLines folded into a line. */
export function mergedCues(elements: Element[]): string[] {
  const found: string[] = [];
  let speaker = "";
  for (const element of elements) {
    if (element.type === "character") {
      speaker = element.text;
    } else if (element.type === "dialogue" && speaker) {
      for (const m of element.source_quote.matchAll(speakerCue(speaker, "g"))) {
        if (m.index > 0) found.push(m[0]);
      }
    }
  }
  return found;
}

// A spoken "interior"/"exterior" that the writer ran into the preceding action
// beat ("Maya walks into a room exterior Maya's bedroom") starts a scene heading.
// The same words are ordinary adjectives in "every interior corridor" or "paints
// exterior trim", so the cue is only honored when the words around it look like a slugline.
const HEADING_CUE = /(?:^|(?<=[\s,;:.!?]))(interior|exterior)\s/giu;
// A determiner, possessive or preposition before the cue makes it an adjective.
const ADJECTIVE_LEAD = new Set(["the", "a", "an", "its", "his", "her", "their", "my", "your", "our", "of", "on", "at",
  "in", "from", "into", "onto", "to", "every", "each", "some", "any", "no", "this", "that", "these", "those", "all",
  "both", "another", "other", "same", "whole", "entire", "which", "what", "whose", "one", "and", "or"]);
// Nouns that follow the adjective and never name a place on their own.
const ADJECTIVE_TAIL = new Set(["shot", "shots", "scene", "scenes", "footage", "wall", "walls", "door", "doors",
  "window", "windows", "trim", "paint", "damage", "surface", "surfaces", "light", "lights", "lighting", "view",
  "views", "angle", "angles", "finish", "panel", "panels", "glass", "brick", "siding", "decor", "design",
  "monologue", "life", "world", "space", "voice", "shell", "frame"]);
const MAX_SLUG_WORDS_WITHOUT_TIME = 4;
const token = () => new RegExp(ALNUM + "+(?:'" + ALNUM + "+)*", "gu");

/** A curly apostrophe is one character, so this keeps every offset intact. */
function straight(text: string): string {
  return text.replaceAll("’", "'");
}

/** Dictation names a place with a proper noun or a possessive. */
function namesAPlace(tail: string): boolean {
  return (straight(tail).match(token()) ?? []).some((t) => /^\p{Lu}/u.test(t) || t.toLowerCase().endsWith("'s"));
}

/** Split "Maya walks in exterior Maya's bedroom" into action plus heading. */
export function splitBuriedHeading(element: Element): Element[] {
  if (element.type !== "action") return [element];
  for (const match of element.text.matchAll(HEADING_CUE)) {
    const start = match.index;
    let headText = rstrip(element.text.slice(0, start), " ,;:-");
    const tail = strip(element.text.slice(start));
    if (!headText) continue; // An action that is entirely a heading is the model's call.
    const lead = words(headText).slice(-1);
    if (lead.length && (ADJECTIVE_LEAD.has(lead[0]!) || lead[0]!.endsWith("'s") || headText.endsWith("'"))) continue;
    const heading = spokenHeading(tail);
    if (!heading) continue;
    const afterCue = tail.replace(/^(?:interior|exterior)\s+(?:of\s+)?/iu, "");
    const tailWords = words(afterCue);
    if (!tailWords.length || ADJECTIVE_TAIL.has(tailWords[0]!)) continue;
    const hasTime = heading.includes(" - ");
    // A denylist of adjective words cannot prove a scene boundary, so the
    // split needs evidence of its own: a spoken time of day, or a named place.
    if (!hasTime && !namesAPlace(afterCue)) continue;
    // After a full stop the model saw the boundary and still chose action;
    // only a time of day is strong enough evidence to overrule it.
    if (".!?".includes(headText.at(-1)!) && !hasTime) continue;
    if (!hasTime && tailWords.length > MAX_SLUG_WORDS_WITHOUT_TIME) continue;
    // The heading must anchor to the same spoken cue; a rephrased quote gets no invented anchor.
    const quote = element.source_quote;
    const cue = new RegExp(String.raw`(?:^|(?<=[\s,;:.!?]))(` + match[1] + String.raw`)\s`, "giu");
    const cuts = [...quote.matchAll(cue)];
    const matching = cuts.filter((c) => arraysEqual(words(quote.slice(c.index + c[0].length)).slice(0, 1), tailWords.slice(0, 1)));
    const cut = (matching.length ? matching : cuts)[0];
    if (!cut) continue;
    headText = ".!?".includes(headText.at(-1)!) ? headText : headText + ".";
    const headQuote = strip(quote.slice(0, cut.index));
    // The heading's quote covers the cue and its words, not the rest of the quote.
    const rest = quote.slice(cut.index);
    const tokens = [...straight(rest).matchAll(token())].slice(0, words(tail).length);
    const last = tokens.at(-1);
    let stop = last ? last.index + last[0].length : rest.length;
    stop += /^[.!]?/u.exec(rest.slice(stop))![0].length;
    const tailQuote = strip(rest.slice(0, stop));
    // Whatever the counting did, the quote has to carry the heading it anchors.
    const located = heading.includes(" ") ? heading.slice(heading.indexOf(" ") + 1) : "";
    if (new Counter(words(located)).minus(new Counter(words(tailQuote))).size) continue;
    return [makeElement("action", headText, headQuote || quote, element.uncertainty),
      makeElement("scene_heading", heading, tailQuote, "")];
  }
  return [element];
}

/** "Tommy says, whispering, get down" arrives as dialogue then parenthetical. */
export function reorderTrailingParentheticals(input: Element[]): Element[] {
  const elements = [...input];
  for (let i = 1; i < elements.length; i++) {
    const followsDialogue = elements[i]!.type === "parenthetical" && elements[i - 1]!.type === "dialogue";
    const nothingAfter = i + 1 >= elements.length || elements[i + 1]!.type !== "dialogue";
    if (followsDialogue && nothingAfter) [elements[i - 1], elements[i]] = [elements[i]!, elements[i - 1]!];
  }
  return elements;
}

/** JO / I, I don't know. / JO / I don't know. is one line, not two. */
export function mergeSplitLines(elements: Element[], transcript: string): Element[] {
  const haystack = normalized(transcript);
  const out: Element[] = [];
  for (const element of elements) {
    const at = (n: number) => out[out.length - n]!;
    if (element.type === "character" && out.length >= 2 && at(2).type === "character"
      && at(1).type === "dialogue" && at(2).text === element.text) {
      out.push(element);
      continue;
    }
    if (element.type === "dialogue" && out.length >= 3 && at(1).type === "character"
      && at(2).type === "dialogue" && at(3).type === "character" && at(1).text === at(3).text) {
      const first = at(2), second = element, cue = at(1);
      const firstQuote = normalized(first.source_quote);
      const start = haystack.indexOf(firstQuote);
      const end = haystack.indexOf(normalized(second.source_quote), start >= 0 ? start + firstQuote.length : 0);
      if (start >= 0 && end >= start) {
        const joined = haystack.slice(start, end + normalized(second.source_quote).length);
        // The dropped cue's doubts are about this line, and dropping them
        // would paste an attribution the model itself questioned.
        const flags: string[] = [];
        for (const note of [first.uncertainty, second.uncertainty, cue.uncertainty]) {
          if (note && !flags.includes(note)) flags.push(note);
        }
        out.pop(); // the repeated cue
        out[out.length - 1] = makeElement("dialogue", first.text + " " + second.text, joined, flags.join(" "));
        continue;
      }
    }
    out.push(element);
  }
  return out;
}

// "Maya walks to the window and sighs and says, Well, ..." The "and" matters:
// "the sign that says, Keep out" is narration, and so is "Maya says nothing".
const BURIED_LINE = /^(?<head>.*?[^\s,;:])[\s,;:]+and\s+(?:then\s+)?(?:says|said|asks|asked|replies|replied|whispers|whispered|yells|yelled|shouts|shouted)\s*[,:]\s*(?<line>\S.*)$/isu;
const SENTENCE_BREAK = /(?<=[.!?])\s+/u;

function lastSentence(text: string): string {
  return text.split(SENTENCE_BREAK).at(-1)!;
}

/** Split an action that ends with a known character speaking into action, cue and line. */
export function splitBuriedLine(element: Element, cast: string[]): Element[] {
  if (element.type !== "action") return [element];
  const text = BURIED_LINE.exec(element.text)?.groups;
  const quote = BURIED_LINE.exec(element.source_quote)?.groups;
  if (!text || !quote) return [element];
  const sentence = straight(lastSentence(text.head!));
  const speaker = cast.find((c) => new RegExp("^" + escape(c) + `(?!${W.slice(0, -1)}'])`, "iu").test(sentence));
  if (!speaker || !arraysEqual(words(text.line!), words(quote.line!))) return [element];
  const headText = ".!?".includes(text.head!.at(-1)!) ? text.head! : text.head! + ".";
  const line = capitalizeFirst(text.line!);
  const spokenFrom = quote.head!.lastIndexOf(lastSentence(quote.head!));
  return [makeElement("action", headText, quote.head!, element.uncertainty),
    makeElement("character", speaker, element.source_quote.slice(spokenFrom), ""),
    makeElement("dialogue", line, quote.line!, "")];
}

/** A bare cue with no line under it is a stray the model left behind. */
function dropEmptyCues(proposal: Proposal): void {
  const kept: Element[] = [];
  proposal.elements.forEach((element, i) => {
    const following = proposal.elements[i + 1]?.type;
    if (element.type === "character" && following !== "dialogue" && following !== "parenthetical" && !element.uncertainty) {
      proposal.warnings.push(`Removed a ${element.text} cue that had no line after it.`);
      return;
    }
    kept.push(element);
  });
  setElements(proposal, kept.length ? kept : proposal.elements);
}

/** Deterministic repairs of shapes small models get wrong in known ways. */
export function normalizeProposal(input: Proposal, transcript = ""): Proposal {
  const proposal = copyProposal(input);
  setElements(proposal, proposal.elements.flatMap(splitBuriedHeading));
  const cast = [...new Set(proposal.elements
    .filter((e) => e.type === "character")
    .map((e) => cueKey(e.text))
    .filter((cue) => cue && !UNRESOLVED_CUES.has(cue) && !PRONOUN_CUES.has(cue)))];
  setElements(proposal, proposal.elements.flatMap((e) => splitBuriedLine(e, cast)));
  setElements(proposal, reorderTrailingParentheticals(proposal.elements));
  if (transcript) setElements(proposal, mergeSplitLines(proposal.elements, transcript));
  dropEmptyCues(proposal);
  for (const element of proposal.elements) {
    if (element.type === "scene_heading") {
      const heading = spokenHeading(element.source_quote);
      if (heading) element.text = heading;
    } else if (element.type === "note") {
      const stripped = strip(element.text.replace(/^note to self[\s,:.-]*/iu, ""));
      if (stripped) element.text = capitalizeFirst(stripped);
    }
  }
  return proposal;
}

/** One spelling per character, so "Old  Man Jenkins" and "old man jenkins" match. */
export function castKey(name: string): string {
  return split(name).join(" ").toUpperCase();
}

/** Named speakers this take introduces, skipping placeholders and pronouns. */
export function characterCues(elements: Element[]): string[] {
  const found: string[] = [];
  for (const element of elements) {
    if (element.type !== "character") continue;
    const cue = cueKey(element.text);
    if (cue && !UNRESOLVED_CUES.has(cue) && !PRONOUN_CUES.has(cue)) found.push(cue);
  }
  return found;
}

/** Whole-word, case-insensitive, longest name first so a phrase beats its parts. */
function castPattern(names: string[]): RegExp {
  const ordered = [...names].sort((a, b) => {
    const byWords = split(b).length - split(a).length;
    if (byWords) return byWords;
    const byLength = Array.from(b).length - Array.from(a).length;
    if (byLength) return byLength;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const body = ordered.map((name) => split(name).map(escape).join(String.raw`\s+`)).join("|");
  return new RegExp(`(?<!${W.slice(0, -1)}'-])(?:` + body + `)(?!${W.slice(0, -1)}-])`, "giu");
}

/** Shout each character's name the first time an action line brings them on. */
export function capitalizeIntroductions(input: Proposal, cast: string[], introduced: Iterable<string>): Proposal {
  const proposal = copyProposal(input);
  const names = new Map<string, string>();
  for (const name of [...cast, ...characterCues(proposal.elements)]) {
    const key = castKey(name);
    if (key && !names.has(key)) names.set(key, split(name).join(" "));
  }
  if (!names.size) return proposal;
  const pattern = castPattern([...names.values()]);
  const seen = new Set([...introduced].map(castKey));
  const shout = (found: string) => {
    const key = castKey(found);
    if (seen.has(key)) return found;
    seen.add(key);
    return found.toUpperCase();
  };
  for (const element of proposal.elements) {
    if (element.type === "action") element.text = element.text.replace(pattern, shout);
  }
  return proposal;
}

// Cue repetition is valid; lost story words are not. Spoken format labels,
// hesitation sounds, the pronoun a resolved cue replaces and the "note to self"
// prefix normalizeProposal strips may all disappear without a review dialog.
const CONTROL_WORDS = new Set(["says", "said", "say", "scene", "heading", "action", "dialogue", "parenthetical",
  "transition", "shot", "um", "uh", "erm", "so", "and", "quote", "unquote", "note", "to", "self",
  ...[...PRONOUN_CUES].map((cue) => cue.toLowerCase())]);
const ALIASES: Record<string, string> = { interior: "int", exterior: "ext" };

/** Words as the strict check counts them: a spoken 'interior' is an 'INT.'. */
function controlTokens(text: string): string[] {
  return words(text).map((word) => ALIASES[word] ?? word);
}

/** Remove every explicitly corrected span from a quote before comparing words. */
function withoutCorrections(quote: string, omissions: Omission[]): string {
  for (const omission of omissions) {
    const span = normalized(omission.source_quote);
    if (omission.reason !== "explicit_correction" || !span) continue;
    quote = quote.replace(new RegExp(span.split(" ").map(escape).join(String.raw`\s+`), "iu"), " ");
  }
  return quote;
}

/** Dictated words the scene does not account for, ignoring dictation controls. */
export function droppedSpeech(proposal: Proposal, transcript: string): Counter {
  const original = new Counter(controlTokens(transcript));
  const output = new Counter(controlTokens(proposal.elements.map((e) => e.text).join(" ")));
  const consumed = new Counter();
  for (const element of proposal.elements) {
    if (element.type !== "scene_heading") continue;
    const heading = spokenHeading(element.source_quote);
    if (heading) consumed.update(new Counter(controlTokens(element.source_quote)).minus(new Counter(controlTokens(heading))));
  }
  for (const cue of mergedCues(proposal.elements)) consumed.update(controlTokens(cue));
  for (const omission of proposal.omissions) {
    if (omission.reason === "explicit_correction" && correctionTrigger().test(omission.source_quote)) {
      consumed.update(controlTokens(omission.source_quote));
    }
  }
  const missing = original.minus(output).minus(consumed);
  for (const word of CONTROL_WORDS) missing.delete(word);
  return missing;
}

/** Automatic delivery permits formatting controls, but not unsupported prose. */
export function shortcutErrors(proposal: Proposal, transcript: string): string[] {
  const blocking = new Set(["uncertain", "new_words", "word_order", "source_changed", "model_warning", "cue_mismatch"]);
  const errors = audit(proposal, transcript)
    .filter((d) => d.severity === "error" || blocking.has(d.code)).map((d) => d.message);
  let speaker: string[] = [];
  for (const element of proposal.elements) {
    if (element.type === "character") {
      speaker = controlTokens(element.text);
      continue;
    }
    if (!["action", "dialogue", "parenthetical", "transition", "shot"].includes(element.type)) continue;
    let sources = [element.source_quote];
    const trimmed = withoutCorrections(element.source_quote, proposal.omissions);
    if (trimmed !== element.source_quote) sources.push(trimmed);
    if (element.type === "dialogue") sources = sources.map((source) => dialogueSource(source, speaker.join(" ")));
    const candidates: string[][] = [];
    for (const source of sources) {
      const quoted = controlTokens(source);
      candidates.push(quoted);
      if (element.type === "action") {
        let lead = quoted;
        while (lead.length && ["so", "and", "um", "uh", "erm"].includes(lead[0]!)) {
          lead = lead.slice(1);
          candidates.push(lead);
        }
      }
      if (quoted[0] === element.type && quoted.length) candidates.push(quoted.slice(1));
      if (element.type === "dialogue" && speaker.length && arraysEqual(quoted.slice(0, speaker.length), speaker)) {
        const rest = quoted.slice(speaker.length);
        candidates.push(["says", "said", "say"].includes(rest[0]!) && rest.length ? rest.slice(1) : rest);
      }
    }
    const written = controlTokens(element.text);
    if (!candidates.some((candidate) => arraysEqual(candidate, written))) {
      errors.push("The formatter changed words inside a screenplay paragraph.");
    }
  }
  for (const element of proposal.elements) {
    if (element.type !== "scene_heading") continue;
    const heading = spokenHeading(element.source_quote);
    if (heading && !arraysEqual(controlTokens(element.text), controlTokens(heading))) {
      errors.push("The heading differs from its dictated location or time.");
    }
  }
  const original = new Counter(controlTokens(transcript));
  const output = new Counter(controlTokens(proposal.elements.map((e) => e.text).join(" ")));
  const added = output.keys().filter((key) => original.get(key) === 0);
  if (added.length) errors.push("The formatter added unsupported words: " + sorted(added).join(", "));
  const body = new Counter(controlTokens(proposal.elements.filter((e) => FIDELITY_TYPES.has(e.type)).map((e) => e.text).join(" ")));
  if (body.minus(original).size) errors.push("The formatter repeated words beyond the dictated occurrences.");
  let position = 0;
  const source = normalized(transcript);
  for (const element of proposal.elements) {
    const anchor = source.indexOf(normalized(element.source_quote), position);
    if (anchor < 0) {
      errors.push("The formatter changed the order of the dictated scene.");
      break;
    }
    position = anchor;
  }
  const missing = droppedSpeech(proposal, transcript);
  if (missing.size) errors.push("Some dictated words were omitted: " + sorted(missing.keys()).join(", "));
  return errors;
}

/** An uncertainty flag that may be about the speaker rather than a word. */
function speechDoubt(d: Diagnostic, elements: Element[]): boolean {
  const index = d.element_index;
  return index === null || !(index >= 0 && index < elements.length) || SPEECH_TYPES.has(elements[index]!.type);
}

export function automaticInsertionErrors(proposal: Proposal, transcript: string, { strict = false } = {}): string[] {
  if (strict) return shortcutErrors(proposal, transcript);
  return audit(proposal, transcript)
    .filter((d) => d.severity === "error" || d.code === "source_changed" || (d.code === "uncertain" && speechDoubt(d, proposal.elements)))
    .map((d) => d.message);
}

/** What to tell the writer after an automatic paste, without having stopped it. */
export function pasteNotes(proposal: Proposal, transcript: string): string[] {
  const codes = new Set(CHECK_AFTER_PASTE);
  let invented = 0;
  for (const e of proposal.elements) {
    if (FIDELITY_TYPES.has(e.type) && e.source_quote) invented += quoteDrift(e)[0].total();
  }
  if (invented >= NOTE_NEW_WORDS) codes.add("new_words");
  const missing = droppedSpeech(proposal, transcript);
  const count = missing.total();
  if (count >= NOTE_OMITTED_WORDS) codes.add("omitted_words");
  const found = audit(proposal, transcript);
  const notes = found
    .filter((d) => d.code === "uncertain" && !speechDoubt(d, proposal.elements))
    .map((d) => `Check the ${proposal.elements[d.element_index!]!.type.replaceAll("_", " ")}: ${d.message}`);
  notes.push(...found.filter((d) => codes.has(d.code)).map((d) => d.message));
  // The threshold reads droppedSpeech and the message comes from audit. When
  // only one of the two sees the loss, say it anyway rather than paste in silence.
  if (count >= NOTE_OMITTED_WORDS && !found.some((d) => d.code === "omitted_words")) {
    notes.push(`${count} spoken ${plural(count, "word")} are not in the result. Missing: `
      + head(sorted(missing.keys()).join(", "), 300));
  }
  return notes.slice(0, 4);
}
