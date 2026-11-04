import { isOmitted, pageLocks, plainText, sceneNumbersLocked } from "@screenplay/engine";
import { DICTATION, type FormatTextRequest, type TakeResult } from "../../../shared/channels/dictation.ts";
import type { DraftFormatDeps } from "./controller.ts";
import { nextFormatRequestId } from "./controller.ts";
import { applyDraftFormatting, captureDraftTarget, hasSelection, MAX_DRAFT_CHARS, targetIsCurrent, type DraftTarget } from "./target.ts";

export const AUTO_INCOMING = "draftFormat.autoIncoming";
export const AUTO_INCOMING_DEFAULT = false;

type IncomingDeps = Pick<DraftFormatDeps, "session" | "editor" | "context" | "invoke" | "notify"> & { enabled(): boolean };
type Job = { session: ReturnType<IncomingDeps["session"]>; target: DraftTarget; readyAt: number };

/** Each paste owns a new paragraph. Later takes and typing never enter its replacement range. */
export class IncomingFormatter {
  private readonly deps: IncomingDeps;
  private queue: Job[] = [];
  private generation = 0;
  private activeId: number | undefined;
  private pending = 0;
  private readonly listeners = new Set<() => void>();

  constructor(deps: IncomingDeps) { this.deps = deps; }
  snapshot = (): number => this.pending;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private setPending(count: number): void { this.pending = count; for (const listener of this.listeners) listener(); }

  cancel(): void {
    this.generation++;
    this.queue = [];
    if (this.activeId !== undefined) void this.deps.invoke(DICTATION.cancelFormat, this.activeId).catch(() => undefined);
    this.activeId = undefined;
    this.setPending(0);
  }

  accept = (text: string): boolean => {
    if (!this.deps.enabled() || !text.trim() || text.length > MAX_DRAFT_CHARS) return false;
    const session = this.deps.session(), editor = this.deps.editor();
    const selection = editor?.getSelection();
    if (!editor || !selection || hasSelection(selection) || session.readOnly) return false;
    const at = selection.head;
    const paragraph = session.script().paragraphs.find(p => p.id === at.paragraphId);
    if (!paragraph || pageLocks(session.doc)?.length || sceneNumbersLocked(session.doc) || paragraph.dual || paragraph.sceneNumber ||
      isOmitted(paragraph) || paragraph.runs.some(r => r.note) || paragraph.fdx?.before?.length || paragraph.fdx?.after?.length) return false;
    // Editing an existing heading keeps the heading in place and uses normal paste.
    if (paragraph.type === "sceneHeading" && at.offset > 0 && at.offset < plainText(paragraph.runs).length) return false;
    const normalized = text.replace(/\r\n?/g, "\n");
    session.undo.stopCapturing();
    try {
      const ids = editor.insertParagraphs([{ type: "action", text: normalized }, { type: "action", text: "" }], at);
      const from = { paragraphId: ids[0]!, offset: 0 };
      const to = { paragraphId: ids[0]!, offset: normalized.length };
      const target = captureDraftTarget(session, { anchor: from, head: to }, null);
      // Let dictation apps finish confirming their clipboard insertion before the text changes shape.
      this.queue.push({ session, target, readyAt: Date.now() + 750 });
      const wasIdle = this.pending === 0;
      this.setPending(this.pending + 1);
      if (wasIdle) void this.drain(this.generation);
    } catch (error) {
      this.deps.notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      session.undo.stopCapturing();
    }
    return true;
  };

  private async drain(generation: number): Promise<void> {
    while (generation === this.generation && this.queue.length) {
      const job = this.queue.shift()!;
      try {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, job.readyAt - Date.now())));
        if (generation !== this.generation) return;
        if (!this.current(job)) continue;
        const takeId = nextFormatRequestId();
        this.activeId = takeId;
        const request: FormatTextRequest = { takeId, text: job.target.text, context: this.deps.context(job.target), extractCommands: false };
        const take = await this.deps.invoke<TakeResult>(DICTATION.format, request);
        if (generation !== this.generation) return;
        this.activeId = undefined;
        if (!this.current(job)) continue;
        const safe = take.autoApplyErrors?.length === 0 && !take.error && !take.needsFormatterSetup && !take.commands.length &&
          !take.warnings.length && !take.diagnostics.length && !take.elements.some(e => e.uncertainty) && take.elements.length > 0;
        if (!safe) {
          this.deps.notify(take.error ? `Incoming text kept. ${take.error}`
            : "Incoming text kept as dictated. Use Format Draft to review its formatting.", !!take.error);
          continue;
        }
        // The editor carries its current caret through this change. Formatting never steals focus.
        applyDraftFormatting(job.session, job.target, take.elements);
      } catch (error) {
        if (generation !== this.generation) return;
        this.deps.notify(`Incoming text kept. ${error instanceof Error ? error.message : String(error)}`, true);
      } finally {
        if (generation === this.generation) {
          this.activeId = undefined;
          this.setPending(this.pending - 1);
        }
      }
    }
  }

  private current(job: Job): boolean {
    return this.deps.enabled() && this.deps.session() === job.session && targetIsCurrent(job.session, job.target);
  }
}
