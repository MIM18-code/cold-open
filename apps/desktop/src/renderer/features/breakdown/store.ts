import { castSuggestions, normalizeSuggestions, scenesOf, type BreakdownSuggestion, type Script } from "@screenplay/engine";
import { AI_CHANNELS, judgesWholeScript, WHOLE_SCRIPT_NEEDS, type AiStatus, type ProviderId } from "../../../shared/channels/ai.ts";
import { app } from "../../core/app.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import { AiClientError, runAi, type AiRun } from "../assistant/client.ts";
import { preferredProvider, providerName } from "../assistant/provider.ts";
import { cancelAiRetry, retryWhenAiReady } from "../assistant/setup.ts";
import { needsAiSetup } from "../assistant/setup-state.ts";
import { breakdownHighlights } from "./highlights.ts";
import { breakdownRequest, parseBreakdown } from "./request.ts";
import { liveSpan, tagReviewed, type ReviewSuggestion } from "./review.ts";

export const showTags = () => app.setting("breakdown.showTags", app.ui.rightPanel === "breakdown");

export class BreakdownStore {
  rows: ReviewSuggestion[] = [];
  sceneIndex = -1;
  all = false;
  busy = false;
  progress = "";
  error = "";
  setupRequired = false;
  message = "";
  provider: ProviderId = "ollama";
  resultProvider?: ProviderId;
  revision = 0;
  private listeners = new Set<() => void>();
  private run?: AiRun;
  private token = 0;
  private session = app.session;
  private headingId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.revision;
  private emit() { this.revision++; for (const listener of this.listeners) listener(); }
  private draw = () => {
    app.editor?.setDecorations("breakdown", breakdownHighlights(this.session.script(), showTags(), app.ui.rightPanel === "breakdown" ? this.rows : []));
  };
  private refresh = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.followCaret(); this.draw(); }, 150);
  };
  private reviewRows(script: Script, suggestions: BreakdownSuggestion[]): ReviewSuggestion[] {
    const scenes = scenesOf(script.paragraphs);
    return suggestions.map(row => ({ ...row, checked: true, headingId: scenes[row.sceneIndex]!.headingId }));
  }
  private casts() {
    this.rows = this.reviewRows(this.session.script(), castSuggestions(this.session.script(), this.sceneIndex));
    this.error = ""; this.message = ""; this.resultProvider = undefined;
  }
  /** After an edit in the same scene: add cast the script now has (a new cue, an undone tag) and drop cast rows whose
   * words are gone or now tagged, keeping the writer's choices on rows that remain and every model row. */
  private reconcileCast() {
    if (this.all || this.busy || this.sceneIndex < 0) return;
    const script = this.session.script(), fresh = this.reviewRows(script, castSuggestions(script, this.sceneIndex));
    const kept = new Map(this.rows.filter(row => row.source === "script").map(row => [row.id, row]));
    const cast = fresh.map(row => kept.get(row.id) ?? row);
    if (cast.length === kept.size && cast.every(row => kept.get(row.id) === row)) return;
    this.rows = [...cast, ...this.rows.filter(row => row.source !== "script")];
    this.emit();
  }
  private followCaret = () => {
    const scenes = scenesOf(this.session.script().paragraphs), id = app.editor?.currentParagraphId();
    const index = id ? scenes.findIndex(s => s.paragraphIds.includes(id)) : scenes.length ? 0 : -1;
    const headingId = scenes[index]?.headingId;
    if (headingId === this.headingId && index === this.sceneIndex) { this.reconcileCast(); return; }
    this.sceneIndex = index; this.headingId = headingId;
    if (!this.all) { this.cancel(); this.casts(); }
    this.emit(); this.draw();
  };
  cancel = () => {
    cancelAiRetry(this);
    this.token++; this.run?.cancel(); this.run = undefined;
    this.busy = false; this.progress = ""; this.emit();
  };
  update = (id: string, patch: Partial<Pick<ReviewSuggestion, "checked" | "label" | "category">>) => {
    this.rows = this.rows.map(row => row.id === id ? { ...row, ...patch } : row);
    this.emit(); this.draw();
  };
  reveal = (row: ReviewSuggestion) => {
    const span = liveSpan(this.session.script(), row);
    if (span) app.editor?.revealParagraph(span.paragraphId, { offset: span.start, ifNeeded: true });
  };
  next = () => {
    const next = scenesOf(this.session.script().paragraphs)[this.sceneIndex + 1];
    if (!next) return;
    this.cancel(); this.all = false; this.rows = []; this.headingId = undefined;
    app.editor?.setSelection({ paragraphId: next.headingId, offset: 0 });
    app.editor?.revealParagraph(next.headingId);
    this.followCaret();
  };
  tag = () => {
    if (this.session.readOnly || this.busy) return;
    try {
      app.flushPending();
      const { tagged, skipped } = tagReviewed(this.session, this.rows);
      this.rows = this.rows.filter(row => !row.checked);
      this.message = `Tagged ${tagged}.${skipped ? ` Skipped ${skipped}: the text moved, is already tagged, or has no name.` : ""}`;
      this.error = ""; this.emit(); this.draw();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.emit(); }
  };

  suggest = async (all: boolean) => {
    if (this.busy || (!all && this.sceneIndex < 0)) return;
    this.cancel();
    const token = this.token, session = this.session;
    const current = () => token === this.token && session === app.session && app.ui.rightPanel === "breakdown";
    this.busy = true; this.error = ""; this.setupRequired = false; this.message = ""; this.emit();
    try {
      app.flushPending();
      const status = await desktop.invoke<AiStatus>(AI_CHANNELS.status);
      if (!current()) return;
      const provider = preferredProvider(status);
      this.provider = provider; this.emit();
      if (all && !judgesWholeScript(provider)) throw new Error(WHOLE_SCRIPT_NEEDS);
      const approved = app.setting<string[]>("breakdown.cloudApproved", []);
      if (provider !== "ollama" && !approved.includes(provider)) {
        const name = providerName(provider);
        const answer = await messageBox({ type: "question", message: `Suggest breakdown tags with ${name}?`,
          detail: `Each scene's text goes to ${name}. Script notes stay out. You won't be asked again for ${name}.`,
          buttons: [`Use ${name}`, "Cancel"], defaultId: 0, cancelId: 1 });
        if (!current() || answer !== 0) return;
        await app.setSetting("breakdown.cloudApproved", [...approved, provider]);
        if (!current()) return;
      }
      const script = session.script(), scenes = scenesOf(script.paragraphs);
      const indices = all ? scenes.map((_, index) => index) : [this.sceneIndex];
      this.all = all; this.resultProvider = provider;
      this.rows = this.reviewRows(script, indices.flatMap(index => castSuggestions(script, index)));
      this.emit(); this.draw();
      for (const [ordinal, index] of indices.entries()) {
        if (!current()) return;
        this.progress = all ? `Scene ${ordinal + 1} of ${indices.length}` : `Scene ${index + 1} of ${scenes.length}`;
        this.emit();
        const request = breakdownRequest(script, index);
        let parsed: ReturnType<typeof parseBreakdown> | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          this.run = runAi({ provider, tier: "fast", json: true, maxTokens: 2000, ...request });
          const answer = await this.run.done;
          if (!current()) return;
          try { parsed = parseBreakdown(answer); break; }
          catch (error) { if (attempt === 1) throw error; }
        }
        this.rows = [...this.rows.filter(row => row.sceneIndex !== index), ...this.reviewRows(script, normalizeSuggestions(parsed, script, index))];
        this.emit(); this.draw();
      }
      this.message = this.rows.length ? "Review the names and uncheck elements you don't want to tag." : "No untagged elements found.";
    } catch (error) {
      if (current() && !(error instanceof AiClientError && error.code === "cancelled")) {
        this.error = error instanceof Error ? error.message : String(error);
        this.setupRequired = needsAiSetup(error);
        if (this.setupRequired) retryWhenAiReady(this, () => { if (current()) void this.suggest(all); });
      }
    } finally {
      if (current()) { this.busy = false; this.progress = ""; this.run = undefined; this.emit(); }
    }
  };

  start() {
    let editor: EditorBridge | null = null, offSelection: (() => void) | undefined;
    let open = false, settings: unknown, statusToken = 0;
    const watch = () => this.session.onChange(this.refresh);
    let offChange = watch();
    const offSession = app.onSession(session => {
      this.cancel(); offChange(); this.session = session; this.all = false; this.rows = []; this.headingId = undefined; this.sceneIndex = -1;
      offChange = watch(); this.followCaret(); this.casts(); this.draw(); this.emit();
    });
    const changed = () => {
      if (app.editor !== editor) {
        editor?.setDecorations("breakdown", []); offSelection?.(); editor = app.editor;
        offSelection = editor?.onSelectionChange(this.followCaret); this.followCaret(); this.draw();
      }
      const nextOpen = app.ui.rightPanel === "breakdown";
      if (open !== nextOpen) {
        open = nextOpen;
        if (open) { this.all = false; this.followCaret(); this.casts(); this.emit(); }
        else this.cancel();
        this.draw();
      }
      if (settings !== app.settings) {
        settings = app.settings; this.draw();
        const token = ++statusToken;
        void desktop.invoke<AiStatus>(AI_CHANNELS.status).then(status => {
          if (token === statusToken) { this.provider = preferredProvider(status); this.emit(); }
        }, () => undefined);
      }
    };
    const offApp = app.subscribe(changed);
    changed();
    return () => { statusToken++; this.cancel(); clearTimeout(this.timer); offApp(); offSession(); offChange(); offSelection?.(); editor?.setDecorations("breakdown", []); };
  }
}
