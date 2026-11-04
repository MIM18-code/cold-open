import { DICTATION, type FormatTextRequest, type TakeContext, type TakeResult } from "../../../shared/channels/dictation.ts";
import type { DesktopBridge } from "../../../shared/api.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";
import { applyDraftFormatting, captureDraftTarget, targetIsCurrent, type DraftTarget } from "./target.ts";

export interface DraftFormatState {
  phase: "idle" | "working" | "review";
  target?: DraftTarget;
  take?: TakeResult;
  warnings?: string[];
}
export interface DraftFormatDeps {
  session(): DocumentSession;
  editor(): EditorBridge | null;
  context(target: DraftTarget): TakeContext;
  invoke: DesktopBridge["invoke"];
  alwaysReview(): boolean;
  review(): void;
  offerFormatterSetup(): void;
  notify(message: string, error?: boolean): void;
}
let requestId = Date.now();
export const nextFormatRequestId = (): number => ++requestId;
export class DraftFormatController {
  private state: DraftFormatState = { phase: "idle" };
  private generation = 0;
  private activeId: number | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly deps: DraftFormatDeps;
  constructor(deps: DraftFormatDeps) { this.deps = deps; }
  snapshot = (): DraftFormatState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: DraftFormatState): void { this.state = state; for (const listener of this.listeners) listener(); }
  cancel(): void {
    this.generation++;
    if (this.activeId !== undefined) void this.deps.invoke(DICTATION.cancelFormat, this.activeId).catch(() => undefined);
    this.activeId = undefined;
    this.set({ phase: "idle" });
  }
  async format(): Promise<void> {
    if (this.state.phase !== "idle") return;
    const generation = ++this.generation;
    const session = this.deps.session();
    const editor = this.deps.editor();
    try {
      const target = captureDraftTarget(session, editor?.getSelection() ?? null, editor?.currentParagraphId() ?? null);
      const takeId = nextFormatRequestId();
      this.activeId = takeId;
      this.set({ phase: "working", target });
      const request: FormatTextRequest = { takeId, text: target.text, context: this.deps.context(target), extractCommands: false };
      const take = await this.deps.invoke<TakeResult>(DICTATION.format, request);
      if (generation !== this.generation) return;
      this.activeId = undefined;
      if (this.deps.session() !== session || !targetIsCurrent(session, target)) throw new Error("The source passage changed while formatting. Your draft was left untouched.");
      if (take.needsFormatterSetup) {
        this.set({ phase: "idle" });
        this.deps.offerFormatterSetup();
        return;
      }
      if (take.error) throw new Error(take.error);
      if (!take.elements.length) throw new Error("The formatter returned no screenplay elements. Your draft was left untouched.");
      const warnings = [...new Set([...target.warnings, ...(take.autoApplyErrors ?? ["Review is required because this result has no automatic-apply safety check."]),
        ...take.warnings, ...take.elements.filter((e) => e.uncertainty).map((e) => e.uncertainty),
        ...take.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)])];
      this.set({ phase: "review", target, take, warnings });
      if (warnings.length || this.deps.alwaysReview()) this.deps.review();
      else this.apply();
    } catch (error) {
      if (generation !== this.generation) return;
      this.activeId = undefined;
      this.set({ phase: "idle" });
      this.deps.notify(error instanceof Error ? error.message : String(error), true);
    }
  }
  apply(): boolean {
    const { target, take } = this.state;
    if (!target || !take) return false;
    try {
      const caret = applyDraftFormatting(this.deps.session(), target, take.elements);
      this.deps.editor()?.setSelection(caret);
      this.deps.editor()?.focus();
      this.set({ phase: "idle" });
      this.deps.notify(`Formatted ${take.elements.length} screenplay elements. Undo restores the rough draft.`);
      return true;
    } catch (error) {
      this.deps.notify(error instanceof Error ? error.message : String(error), true);
      return false;
    }
  }
}
