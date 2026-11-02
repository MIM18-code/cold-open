// Everything proofreading runs on a script, as plain functions: the engine's checks plus spelling through an
// injected checker (the macOS one in the app, a fake in tests), minus ignored findings and learned words.
import {
  type Finding, type FindingKind, type Paragraph, commonTypo, findingId, proofread, scriptVocabulary, spellingWords,
} from "@screenplay/engine";

export interface SpellChecker {
  isMisspelled(word: string): boolean;
  suggestions(word: string): string[];
}

/** Remembers answers per word; the checker is called once for each distinct word. */
export class SpellCache {
  private readonly bad = new Map<string, boolean>();
  private readonly options = new Map<string, string[]>();
  private readonly checker: SpellChecker;

  constructor(checker: SpellChecker) {
    this.checker = checker;
  }

  isMisspelled(word: string): boolean {
    let answer = this.bad.get(word);
    if (answer === undefined) {
      answer = this.checker.isMisspelled(word);
      this.bad.set(word, answer);
    }
    return answer;
  }

  suggestions(word: string): string[] {
    let answer = this.options.get(word);
    if (!answer) {
      answer = this.checker.suggestions(word).slice(0, 5);
      this.options.set(word, answer);
    }
    return answer;
  }

  /** Call after the checker's dictionary changes. */
  clear(): void {
    this.bad.clear();
    this.options.clear();
  }
}

/** Match a suggestion's capitals to the word it replaces ("Teh" gives "The"). */
function matchCase(word: string, suggestion: string): string {
  if (word.length > 1 && word === word.toUpperCase()) return suggestion.toUpperCase();
  if (word[0] === word[0]!.toUpperCase() && word[0] !== word[0]!.toLowerCase()) return suggestion[0]!.toUpperCase() + suggestion.slice(1);
  return suggestion;
}

// Checks that look at one paragraph only, cached per paragraph object. The document hands out the same object
// until a paragraph changes, so after typing only the edited paragraph is checked again.
const LOCAL_KINDS: readonly FindingKind[] = ["punctuation", "spacing", "repeat", "capital"];
const GLOBAL_KINDS: readonly FindingKind[] = ["name", "structure"];
const localCache = new WeakMap<Paragraph, Map<string, Finding[]>>();
const wordCache = new WeakMap<Paragraph, ReturnType<typeof spellingWords>>();

function localFindings(paragraph: Paragraph, kinds: readonly FindingKind[]): Finding[] {
  const key = kinds.join(" ");
  let byKinds = localCache.get(paragraph);
  if (!byKinds) localCache.set(paragraph, (byKinds = new Map()));
  let found = byKinds.get(key);
  if (!found) byKinds.set(key, (found = proofread([paragraph], { kinds })));
  return found;
}

function wordsOf(paragraph: Paragraph): ReturnType<typeof spellingWords> {
  let words = wordCache.get(paragraph);
  if (!words) wordCache.set(paragraph, (words = spellingWords(paragraph)));
  return words;
}

/** The engine's checks: names and dialogue structure across the script, the rest paragraph by paragraph. */
export function scriptFindings(paragraphs: readonly Paragraph[], kinds: ReadonlySet<FindingKind>): Finding[] {
  const global = GLOBAL_KINDS.filter((kind) => kinds.has(kind));
  const local = LOCAL_KINDS.filter((kind) => kinds.has(kind));
  const found = global.length ? proofread(paragraphs, { kinds: global }) : [];
  if (local.length) for (const paragraph of paragraphs) found.push(...localFindings(paragraph, local));
  return found;
}

/** Spelling findings for paragraphs. The vocabulary is the whole script's, so a slice of it can be checked alone. */
export function spellingFindings(paragraphs: readonly Paragraph[], spell: SpellCache, learned: ReadonlySet<string>, vocabulary = scriptVocabulary(paragraphs)): Finding[] {
  const known = (word: string) => {
    const lower = word.toLowerCase();
    return vocabulary.has(lower) || learned.has(lower) || vocabulary.has(lower.replace(/'s$/, "")) || learned.has(lower.replace(/'s$/, ""));
  };
  const findings: Finding[] = [];
  for (const paragraph of paragraphs) {
    const seen = new Map<string, number>();
    for (const span of wordsOf(paragraph)) {
      if (known(span.word)) continue;
      const slip = commonTypo(span.word);
      if (!slip && !spell.isMisspelled(span.word)) continue;
      const n = seen.get(span.word) ?? 0;
      seen.set(span.word, n + 1);
      const suggested = slip ? [slip, ...spell.suggestions(span.word).filter((word) => word !== slip)] : spell.suggestions(span.word);
      const options = suggested.filter(Boolean).map((suggestion) => matchCase(span.word, suggestion));
      findings.push({
        id: findingId("spelling.word", paragraph.id, span.word, n), paragraphId: paragraph.id, from: span.from, to: span.to, kind: "spelling",
        rule: "spelling.word", message: `"${span.word}" may be misspelled.`,
        ...(options.length ? { replacement: options[0]!, alternatives: options } : {}),
      });
    }
  }
  return findings;
}

export interface CheckOptions {
  /** Kinds switched on. */
  kinds: ReadonlySet<FindingKind>;
  spell: SpellCache;
  learned: ReadonlySet<string>;
}

/** Findings in script order. */
export function inScriptOrder(paragraphs: readonly Paragraph[], findings: Finding[]): Finding[] {
  const order = new Map(paragraphs.map((paragraph, index) => [paragraph.id, index]));
  return findings.sort((a, b) => (order.get(a.paragraphId)! - order.get(b.paragraphId)!) || a.from - b.from);
}

/** All findings for a script, in script order, ignored or not. */
export function computeFindings(paragraphs: readonly Paragraph[], options: CheckOptions): Finding[] {
  const found = scriptFindings(paragraphs, options.kinds);
  if (options.kinds.has("spelling")) found.push(...spellingFindings(paragraphs, options.spell, options.learned));
  return inScriptOrder(paragraphs, found);
}
