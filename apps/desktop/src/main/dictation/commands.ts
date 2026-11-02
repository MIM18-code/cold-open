// Spoken edit commands: "change Bob to Robert everywhere", "replace the window with the door". A sentence that
// is one of these is taken out of the take before formatting and offered as a suggestion; the writer accepts
// it or not. Only sentences that start with the command verb count, so "Maya replaces the battery with a fresh
// one" stays action.
import type { EditCommand } from "../../shared/channels/dictation.ts";

const SCRIPT_WORDS = "everywhere|throughout(?: the (?:whole |entire )?script)?|in (?:the |this )?(?:whole |entire )?script|in all (?:the )?scenes|all over|globally";
const SCENE_WORDS = "in (?:the|this) (?:current )?scene|in this one|here";
const QUOTE = "[\"“”']?";

// Each verb takes its own joining word: change X to Y, replace X with Y, rename X to Y, swap X for Y.
const FORMS = [
  { verb: "change", joiner: "to" },
  { verb: "replace", joiner: "with" },
  { verb: "rename", joiner: "to|as" },
  { verb: "swap", joiner: "for|with" },
];

const PATTERNS = FORMS.map(({ verb, joiner }) => new RegExp(
  `^(?:please\\s+)?(?:(${SCRIPT_WORDS}|${SCENE_WORDS}),?\\s+)?${verb}\\s+(?:all\\s+)?(?:the\\s+)?(?:(?:character|name|word|words|text|phrase)\\s+)?`
  + `${QUOTE}(.+?)${QUOTE}\\s+(?:${joiner})\\s+(?:the\\s+)?(?:name\\s+)?${QUOTE}(.+?)${QUOTE}`
  + `(?:\\s+(${SCRIPT_WORDS}|${SCENE_WORDS}))?$`, "i"));

const SCENE_ONLY = new RegExp(`^(?:${SCENE_WORDS})$`, "i");
const MAX_WORDS = 6;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function words(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/** The command a sentence speaks, or null when it is ordinary writing. */
export function parseEditCommand(sentence: string): EditCommand | null {
  const bare = sentence.trim().replace(/[.!?,;:\s]+$/, "");
  for (const pattern of PATTERNS) {
    const match = pattern.exec(bare);
    if (!match) continue;
    const find = clean(match[2]!);
    const replacement = clean(match[3]!);
    if (!find || !replacement || words(find) > MAX_WORDS || words(replacement) > MAX_WORDS) continue;
    if (find === replacement) continue;
    const qualifier = match[4] ?? match[1] ?? "";
    return { kind: "replace", find, replacement, scope: SCENE_ONLY.test(qualifier) ? "scene" : "script", spoken: sentence.trim() };
  }
  return null;
}

function clean(value: string): string {
  return value.trim().replace(/^["“”']+|["“”']+$/g, "").replace(/[.,;:\s]+$/, "").trim();
}

/** Split a transcript into its edit commands and the writing that is left. */
export function extractEditCommands(transcript: string): { commands: EditCommand[]; rest: string } {
  const commands: EditCommand[] = [];
  const kept: string[] = [];
  for (const sentence of sentences(transcript)) {
    const command = parseEditCommand(sentence);
    if (command) commands.push(command);
    else kept.push(sentence);
  }
  return { commands, rest: kept.join(" ") };
}
