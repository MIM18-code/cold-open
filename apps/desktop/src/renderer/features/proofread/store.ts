// Proofreading state for the open document: findings from the engine, the spell checker and the AI check, the
// writer's ignored findings and learned words (kept in the document so co-writers share them), and the marks
// drawn in the script. The checks run a moment after the document stops changing, whether or not the panel is open.
import { type Finding, type FindingKind, type Paragraph, FINDING_KINDS, plainText, scriptVocabulary } from "@screenplay/engine";

import { AI_SETTINGS, type AiStatus } from "../../../shared/channels/ai.ts";
import { AI_CHANNELS } from "../../../shared/channels/ai.ts";
import type { App } from "../../core/app.ts";
import type { DocumentSession } from "../../core/session.ts";
import { desktop } from "../../core/platform.ts";
import { runAi, type AiRun } from "../assistant/client.ts";
import { replaceInParagraph } from "./apply.ts";
import { AI_CHECK_SYSTEM, type Chunk, characterNames, checkPrompt, chunkParagraphs, isReadable, parseAiFindings, sceneParagraphs } from "./aicheck.ts";
import { SpellCache, computeFindings, inScriptOrder, scriptFindings, spellingFindings, type CheckOptions } from "./check.ts";

export const IGNORED_KEY = "proofread.ignored";
export const LEARNED_KEY = "proofread.learned";
const DEBOUNCE_MS = 500;
/** Paragraphs spell checked per task while recomputing in the background. */
const SPELLING_SLICE = 48;
/** Meta edits that are not the writer's typing: not part of undo. */
const META_ORIGIN = "proofread";

export type AiScope = "scene" | "script";

export interface AiState {
  running: boolean;
  progress?: string;
  error?: string;
  /** How many findings the last run kept. */
  kept?: number;
}

export function kindOn(app: App, kind: FindingKind): boolean {
  return app.setting<boolean>(AI_SETTINGS.proofreadKind(kind), true) !== false;
}

function readList(session: DocumentSession, key: string): string[] {
  const value = session.doc.meta.get(key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sameFinding(a: Finding, b: Finding): boolean {
  return a.id === b.id && a.from === b.from && a.to === b.to && a.kind === b.kind && a.message === b.message && a.replacement === b.replacement
    && (a.alternatives ?? []).join("\n") === (b.alternatives ?? []).join("\n");
}

function writeList(session: DocumentSession, key: string, list: string[]): void {
  session.doc.ydoc.transact(() => session.doc.meta.set(key, list), META_ORIGIN);
}

export class ProofreadStore {
  /** Findings to show: not ignored, in script order, engine and spelling and AI together. */
  findings: Finding[] = [];
  ignoredCount = 0;
  selectedId: string | null = null;
  ai: AiState = { running: false };
  version = 0;
  /** The script the findings were computed from. */
  paragraphs = new Map<string, Paragraph>();
  /** What the shown findings were drawn from: each one's paragraph, and the selected finding. */
  private shownParagraphs: (Paragraph | undefined)[] = [];
  private shownSelected: string | null = null;
  private base: Finding[] = [];
  private aiFindings: Finding[] = [];
  private aiQuotes = new Map<string, string>();
  private aiRun: AiRun | null = null;
  private aiToken = 0;
  private readonly spell: SpellCache;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checkWorker: Worker | null = null;
  private checkWorkerBroken = false;
  private nextAnalysisId = 0;
  private readonly pendingAnalysis = new Map<number, {
    resolve(value: { findings: Finding[]; vocabulary: string[] }): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Bumped by each recompute and each change, so a recompute split over two tasks can tell it is stale. */
  private pass = 0;
  private decorated: App["editor"] = null;
  /** The document the marks were last drawn for; null while a swapped document still needs them. */
  private decoratedSession: DocumentSession | null = null;
  private readonly app: App;
  /** Ignored findings and learned words of a read-only script, which may not change: kept in this window only. */
  private readonly localIgnored = new Set<string>();
  private readonly localLearned = new Set<string>();

  constructor(app: App) {
    this.app = app;
    this.spell = new SpellCache({
      isMisspelled: (word) => desktop.spelling.isMisspelled(word),
      suggestions: (word) => desktop.spelling.suggestions(word),
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Begin watching the document. Returns a function that stops. */
  start(): () => void {
    let session = this.app.session;
    let offChange = session.onChange(() => this.schedule());
    const offSession = this.app.onSession((next) => {
      offChange();
      session = next;
      offChange = next.onChange(() => this.schedule());
      this.cancelAi();
      this.aiFindings = [];
      this.aiQuotes.clear();
      this.localIgnored.clear();
      this.localLearned.clear();
      this.selectedId = null;
      this.runNow();
      // The editor may draw the new document after this, which clears its marks: draw them again once it has.
      this.decoratedSession = null;
    });
    // The editor and the settings can change without the document changing.
    let lastKinds = this.kindsKey();
    const offApp = this.app.subscribe(() => {
      const kinds = this.kindsKey();
      if (kinds !== lastKinds) {
        lastKinds = kinds;
        this.schedule(0);
      }
      if (this.app.editor !== this.decorated || this.app.session !== this.decoratedSession) this.decorate();
    });
    this.runNow();
    return () => {
      offChange();
      offSession();
      offApp();
      clearTimeout(this.timer);
      this.cancelAi();
      this.disposeWorker();
    };
  }

  private disposeWorker(): void {
    this.checkWorker?.terminate();
    this.checkWorker = null;
    for (const pending of this.pendingAnalysis.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The proofreading worker was stopped."));
    }
    this.pendingAnalysis.clear();
  }

  /** The returned result is advisory; runInSteps checks the document generation before publishing. */
  private async analyzeInWorker(paragraphs: readonly Paragraph[], kinds: ReadonlySet<FindingKind>): Promise<{ findings: Finding[]; vocabulary: Set<string> } | null> {
    if (paragraphs.length < 300 || this.checkWorkerBroken || typeof Worker === "undefined" ||
        (typeof location !== "undefined" && location.protocol === "about:")) return null;
    try {
      if (!this.checkWorker) {
        const { CheckWorker } = await import("./worker-loader.ts");
        const worker = new CheckWorker();
        this.checkWorker = worker;
        worker.onmessage = (event: MessageEvent<{ id: number; findings?: Finding[]; vocabulary?: string[]; error?: string }>) => {
          const pending = this.pendingAnalysis.get(event.data.id);
          if (!pending) return;
          this.pendingAnalysis.delete(event.data.id);
          clearTimeout(pending.timer);
          if (!event.data.findings || !event.data.vocabulary || event.data.error)
            pending.reject(new Error(event.data.error ?? "The proofreading response was invalid."));
          else pending.resolve({ findings: event.data.findings, vocabulary: event.data.vocabulary });
        };
        worker.onerror = () => {
          this.disposeWorker();
          this.checkWorkerBroken = true;
        };
      }
      const worker = this.checkWorker;
      const id = ++this.nextAnalysisId;
      const result = await new Promise<{ findings: Finding[]; vocabulary: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingAnalysis.delete(id);
          reject(new Error("The proofreading worker timed out."));
        }, 15_000);
        this.pendingAnalysis.set(id, { resolve, reject, timer });
        try { worker.postMessage({ id, paragraphs, kinds: [...kinds] }); }
        catch (error) {
          clearTimeout(timer);
          this.pendingAnalysis.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return { findings: result.findings, vocabulary: new Set(result.vocabulary) };
    } catch (error) {
      console.warn("Background proofreading unavailable; using the on-page fallback.", error);
      this.checkWorkerBroken = true;
      this.disposeWorker();
      return null;
    }
  }

  private kindsKey(): string {
    return FINDING_KINDS.map((kind) => (kindOn(this.app, kind) ? "1" : "0")).join("");
  }

  private schedule(delay = DEBOUNCE_MS): void {
    clearTimeout(this.timer);
    this.pass++;
    this.timer = setTimeout(() => void this.runInSteps(), delay);
  }

  private checkOptions(): CheckOptions {
    const learned = new Set([...readList(this.app.session, LEARNED_KEY), ...this.localLearned]);
    return { kinds: new Set(FINDING_KINDS.filter((kind) => kindOn(this.app, kind))), spell: this.spell, learned };
  }

  /**
   * The recompute after the document stops changing, in short tasks (the engine's checks, the script's vocabulary,
   * then spelling a slice of the script at a time) with a yield after each, so a key pressed meanwhile never waits
   * long. A change in between starts over. Checks of single paragraphs are cached per paragraph (check.ts), so
   * mostly the edited paragraph is checked again.
   */
  private async runInSteps(): Promise<void> {
    const pass = ++this.pass;
    const paragraphs = this.app.session.doc.paragraphs();
    const options = this.checkOptions();
    const step = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return pass === this.pass;
    };
    const analysis = await this.analyzeInWorker(paragraphs, options.kinds);
    if (pass !== this.pass) return;
    const found = analysis?.findings ?? scriptFindings(paragraphs, options.kinds);
    if (options.kinds.has("spelling")) {
      if (!(await step())) return;
      const vocabulary = analysis?.vocabulary ?? scriptVocabulary(paragraphs);
      for (let at = 0; at < paragraphs.length; at += SPELLING_SLICE) {
        if (!(await step())) return;
        found.push(...spellingFindings(paragraphs.slice(at, at + SPELLING_SLICE), options.spell, options.learned, vocabulary));
      }
    }
    if (!(await step())) return;
    this.finish(paragraphs, inScriptOrder(paragraphs, found));
  }

  /** Recompute now. Exposed for tests and for actions that need fresh findings. */
  runNow(): void {
    clearTimeout(this.timer);
    this.pass++;
    const paragraphs = this.app.session.doc.paragraphs();
    this.finish(paragraphs, computeFindings(paragraphs, this.checkOptions()));
  }

  private finish(paragraphs: readonly Paragraph[], findings: Finding[]): void {
    this.paragraphs = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
    this.base = findings;
    this.aiFindings = this.aiFindings.filter((finding) => this.aiStillHolds(finding));
    this.refresh();
  }

  private aiStillHolds(finding: Finding): boolean {
    const paragraph = this.paragraphs.get(finding.paragraphId);
    const quote = this.aiQuotes.get(finding.id);
    // The model saw line breaks and notes as spaces.
    return !!paragraph && quote !== undefined && plainText(paragraph.runs).slice(finding.from, finding.to).replace(/[\n\u0001]/g, " ") === quote;
  }

  private refresh(): void {
    const ignored = new Set([...readList(this.app.session, IGNORED_KEY), ...this.localIgnored]);
    const all = [...this.base, ...this.aiFindings];
    const order = new Map([...this.paragraphs.keys()].map((id, index) => [id, index]));
    const shown = all.filter((finding) => !ignored.has(finding.id));
    shown.sort((a, b) => ((order.get(a.paragraphId) ?? 0) - (order.get(b.paragraphId) ?? 0)) || a.from - b.from);
    const ignoredCount = all.length - shown.length;
    if (this.selectedId && !shown.some((finding) => finding.id === this.selectedId)) this.selectedId = null;
    // Typing elsewhere in the script finds the same things: leave the marks and the panel alone. A finding's
    // paragraph is the same object until it changes, so its marks and snippet are still right.
    const shownParagraphs = shown.map((finding) => this.paragraphs.get(finding.paragraphId));
    const unchanged = ignoredCount === this.ignoredCount && this.selectedId === this.shownSelected && shown.length === this.findings.length
      && shown.every((finding, i) => sameFinding(finding, this.findings[i]!) && shownParagraphs[i] === this.shownParagraphs[i]);
    if (unchanged) return;
    this.findings = shown;
    this.shownParagraphs = shownParagraphs;
    this.shownSelected = this.selectedId;
    this.ignoredCount = ignoredCount;
    this.decorate();
    this.emit();
  }

  private decorate(): void {
    const editor = this.app.editor;
    this.decorated = editor;
    this.decoratedSession = this.app.session;
    editor?.setDecorations("proofread", this.findings.map((finding) => ({
      paragraphId: finding.paragraphId, from: finding.from, to: finding.to,
      className: `proofread-mark proofread-${finding.kind}${finding.id === this.selectedId ? " proofread-selected" : ""}`,
      title: finding.replacement !== undefined ? `${finding.message} Suggestion: ${finding.replacement}` : finding.message,
      onClick: () => this.focus(finding.id),
    })));
  }

  /** The writer clicked a mark: show it in the panel. */
  focus(id: string): void {
    this.selectedId = id;
    this.app.togglePanel("proofread", true);
    this.refresh();
  }

  reveal(finding: Finding): void {
    this.selectedId = finding.id;
    const editor = this.app.editor;
    if (editor) {
      editor.revealParagraph(finding.paragraphId, { offset: finding.from });
      editor.setSelection({ paragraphId: finding.paragraphId, offset: finding.from }, { paragraphId: finding.paragraphId, offset: finding.to });
    }
    this.refresh();
  }

  /** The finding as it stands in the current text, or null when the text has changed and it no longer applies. */
  private current(id: string): Finding | null {
    this.runNow();
    return this.findings.find((finding) => finding.id === id) ?? null;
  }

  /** Apply a finding's replacement (or one of its alternatives). Never called except by the writer's click. */
  accept(finding: Finding, replacement = finding.replacement): void {
    const fresh = this.current(finding.id);
    if (!fresh || replacement === undefined) {
      this.app.toast("That suggestion no longer applies.", "info");
      return;
    }
    replaceInParagraph(this.app, fresh.paragraphId, fresh.from, fresh.to, replacement);
    this.runNow();
  }

  ignore(finding: Finding): void {
    const session = this.app.session;
    const list = readList(session, IGNORED_KEY);
    if (session.readOnly) this.localIgnored.add(finding.id);
    else if (!list.includes(finding.id)) writeList(session, IGNORED_KEY, [...list, finding.id]);
    this.refresh();
  }

  restoreIgnored(): void {
    this.localIgnored.clear();
    if (!this.app.session.readOnly) writeList(this.app.session, IGNORED_KEY, []);
    this.refresh();
  }

  /** Add a word to this script's learned words and to the system dictionary. */
  learn(finding: Finding): void {
    const paragraph = this.paragraphs.get(finding.paragraphId);
    if (!paragraph) return;
    const word = plainText(paragraph.runs).slice(finding.from, finding.to);
    if (!word) return;
    const session = this.app.session;
    const list = readList(session, LEARNED_KEY);
    if (session.readOnly) this.localLearned.add(word.toLowerCase());
    else if (!list.includes(word.toLowerCase())) writeList(session, LEARNED_KEY, [...list, word.toLowerCase()]);
    desktop.spelling.addToDictionary(word);
    this.spell.clear();
    this.runNow();
  }

  /** Step to the next finding after the caret, wrapping around. */
  next(step: 1 | -1 = 1): void {
    if (!this.findings.length) return;
    const index = this.findings.findIndex((finding) => finding.id === this.selectedId);
    const target = this.findings[(index + step + this.findings.length) % this.findings.length]!;
    this.app.togglePanel("proofread", true);
    this.reveal(target);
  }

  // ---- AI check ----

  cancelAi(): void {
    this.aiToken++;
    this.aiRun?.cancel();
    this.aiRun = null;
    if (this.ai.running) this.setAi({ running: false });
  }

  private setAi(state: AiState): void {
    this.ai = state;
    this.emit();
  }

  async checkWithAi(scope: AiScope): Promise<void> {
    if (this.ai.running) return;
    const token = ++this.aiToken;
    const script = this.app.session.script();
    let paragraphs = script.paragraphs;
    if (scope === "scene") paragraphs = sceneParagraphs(paragraphs, this.app.editor?.currentParagraphId() ?? null);
    this.setAi({ running: true, progress: "Starting" });
    try {
      const status = await desktop.invoke<AiStatus>(AI_CHANNELS.status);
      const size = Math.max(2000, Math.min(15_000, Math.floor(status.active.contextChars / 6)));
      const chunks = chunkParagraphs(paragraphs, size);
      if (!chunks.length) {
        this.setAi({ running: false, kept: 0 });
        return;
      }
      const names = characterNames(script.paragraphs);
      const kept: Finding[] = [];
      for (const [index, chunk] of chunks.entries()) {
        if (token !== this.aiToken) return;
        this.setAi({ running: true, progress: chunks.length > 1 ? `Checking part ${index + 1} of ${chunks.length}` : "Checking" });
        const answer = await this.askChunk(chunk, names);
        if (token !== this.aiToken) return;
        if (!isReadable(answer)) throw new Error("The model's answer could not be read. Try again, or choose a larger model in Settings.");
        for (const finding of parseAiFindings(answer, chunk)) {
          kept.push(finding);
          this.aiQuotes.set(finding.id, chunk.lines.find((line) => line.paragraph.id === finding.paragraphId)!.text.slice(finding.from, finding.to));
        }
      }
      // Replace earlier AI findings for the paragraphs just checked, keep the rest.
      const checked = new Set(chunks.flatMap((chunk) => chunk.lines.map((line) => line.paragraph.id)));
      this.aiFindings = [...this.aiFindings.filter((finding) => !checked.has(finding.paragraphId)), ...kept];
      this.runNow();
      this.setAi({ running: false, kept: kept.length });
    } catch (error) {
      if (token !== this.aiToken) return;
      this.setAi({ running: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (token === this.aiToken) this.aiRun = null;
    }
  }

  private askChunk(chunk: Chunk, names: string[]): Promise<string> {
    const run = runAi({ tier: "fast", system: AI_CHECK_SYSTEM, messages: [{ role: "user", content: checkPrompt(chunk, names) }], json: true, maxTokens: 1500 });
    this.aiRun = run;
    return run.done;
  }
}
