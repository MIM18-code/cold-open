// Record into the main script. Selections, uncertain formatting and edit commands need review.
import {
  DICTATION, type FormatTextRequest, type MicStatus, type PrepareResult, type ProcessAudioRequest, type TakeContext, type TakeProgress,
  type TakeResult,
} from "../../../shared/channels/dictation.ts";
import { app } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { MAX_SECONDS, Recorder } from "./capture.ts";
import { buildTakeContext } from "./context.ts";
import { applyMatches, findMatches } from "./edits.ts";
import { captureDelivery, deliverElements, scriptEnd, type DeliveryTarget } from "./delivery.ts";
import { INITIAL_STATE, prepareMessage, store } from "./store.ts";

const STAGES: Record<TakeProgress["stage"], string> = {
  saved: "Saved the recording",
  transcribing: "Transcribing",
  formatting: "Formatting with the local model",
  done: "Done",
};
const MIN_SECONDS = 0.4;
const SILENT = 0.003;
const PANEL = "dictation";

let recorder: Recorder | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
let takeCounter = 0;
let currentTake = 0;
let lastAudio: Uint8Array | null = null;
let warmed: Promise<unknown> | null = null;
/** Push-to-talk: true while the button is held, so a release that arrives before the microphone opens still stops. */
let holding = false;
/** Which audio tap the last recording used ("worklet" or "script"); tests read it. */
let lastTapKind = "";
/** The microphone is opening. A second press during that moment means "stop", so it is remembered, not started again. */
let starting = false;
let stopWhenReady = false;
let delivery: DeliveryTarget | null = null;
let directDelivery = false;

export function continueAtEnd(): void {
  const end = scriptEnd(app.session);
  if (end) app.editor?.setSelection(end);
  app.editor?.focus();
}

export function tapKind(): string {
  return lastTapKind;
}

export function startListening(): void {
  desktop.on(DICTATION.progress, (payload) => {
    const progress = payload as TakeProgress;
    if (progress.takeId === currentTake && store.state.phase === "working") store.set({ stage: STAGES[progress.stage] });
  });
}

export function caretParagraph(): string | null {
  const editor = app.editor;
  return editor?.getSelection()?.head.paragraphId ?? editor?.currentParagraphId() ?? null;
}

/** What the model is told: the current scene up to the caret, the cast, and who has been introduced. */
export function currentContext(): TakeContext {
  return buildTakeContext(app.session.script(), caretParagraph(), app.editor?.getSelection()?.head.offset);
}

function microphoneError(error: unknown): string {
  const name = (error as { name?: string }).name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Screenplay does not have microphone access. Open System Settings > Privacy & Security > Microphone, turn on Screenplay, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  return error instanceof Error ? error.message : String(error);
}

export function unresolved(): boolean {
  const { take, inserted, suggestions } = store.state;
  return store.state.retryable || (!!take && ((!!take.elements.length && !inserted) || suggestions.some((s) => s.status === "pending") || !!take.error));
}

export async function startRecording(): Promise<void> {
  const { phase } = store.state;
  if (phase === "recording" || starting) return;
  if (phase === "working") return app.toast("Still working on the last take.");
  if (unresolved()) return app.toast("Insert or discard the take in the Dictate panel first.");
  try {
    delivery = captureDelivery(app.session, app.editor);
  } catch (error) {
    return app.toast(error instanceof Error ? error.message : String(error), "error");
  }
  const session = app.session;
  starting = true;
  stopWhenReady = false;
  try {
    await openMicrophone(session.id);
  } finally {
    starting = false;
  }
}

async function openMicrophone(sessionId: string): Promise<void> {
  const access = await desktop.invoke<MicStatus>(DICTATION.micAccess).catch((): MicStatus => "unknown");
  if (stopWhenReady || app.session.id !== sessionId) return;
  if (access === "denied" || access === "restricted") {
    app.togglePanel(PANEL, true);
    return store.set({ error: microphoneError({ name: "NotAllowedError" }), phase: "idle" });
  }
  const next = new Recorder();
  try {
    await next.start();
  } catch (error) {
    app.togglePanel(PANEL, true);
    return store.set({ error: microphoneError(error), phase: "idle" });
  }
  if (stopWhenReady || app.session.id !== sessionId) return next.cancel();
  recorder = next;
  lastTapKind = next.kind + (next.workletError ? ` (worklet failed: ${next.workletError})` : "");
  // A held microphone button must keep focus so Space release reaches pushStop.
  if (!holding) {
    if (!delivery?.replacement) continueAtEnd();
    else app.editor?.focus();
  }
  store.set({ ...INITIAL_STATE, prepare: store.state.prepare, draft: store.state.draft, phase: "recording", replacing: !!delivery?.replacement });
  ticker = setInterval(tick, 50);
  void warmUp();
}

function tick(): void {
  if (!recorder) return;
  store.set({ level: recorder.meter, seconds: recorder.seconds });
  if (recorder.seconds >= MAX_SECONDS) void stopRecording();
}

export async function stopRecording(): Promise<void> {
  const active = recorder;
  if (!active) return;
  recorder = null;
  clearInterval(ticker);
  const { wav, seconds, peak } = active.stop();
  if (seconds < MIN_SECONDS) {
    app.toast("That was too short to transcribe.");
    return store.set({ phase: "idle", level: 0, seconds: 0 });
  }
  if (peak < SILENT) {
    app.togglePanel(PANEL, true);
    return store.set({
      phase: "idle", level: 0, seconds: 0,
      error: "The recording is silent. Check that the right microphone is selected in System Settings > Sound > Input.",
    });
  }
  await processAudio(wav, true, true);
}

export async function toggleRecording(): Promise<void> {
  if (store.state.phase === "recording") await stopRecording();
  else if (starting) stopWhenReady = true;
  else await startRecording();
}

export async function pushStart(): Promise<void> {
  holding = true;
  await startRecording();
  if (!holding && store.state.phase === "recording") await stopRecording();
}

export async function pushStop(): Promise<void> {
  holding = false;
  if (store.state.phase === "recording") await stopRecording();
}

/** Send a recording through the speech helper and the formatter. */
export async function processAudio(wav: Uint8Array, extractCommands = true, direct = false, retry = false): Promise<void> {
  if (store.state.phase === "working" || (unresolved() && !retry)) return app.toast("Insert or discard the current take first.");
  try {
    if ((!direct && !retry) || !delivery) delivery = captureDelivery(app.session, app.editor);
  } catch (error) {
    return app.toast(error instanceof Error ? error.message : String(error), "error");
  }
  directDelivery = direct;
  const takeId = ++takeCounter;
  currentTake = takeId;
  lastAudio = wav;
  if (!direct) app.togglePanel(PANEL, true);
  store.set({ ...INITIAL_STATE, prepare: store.state.prepare, draft: store.state.draft, phase: "working", stage: "Saving the recording" });
  try {
    const request: ProcessAudioRequest = { takeId, audio: wav, context: deliveryContext(), extractCommands };
    const take = await desktop.invoke<TakeResult>(DICTATION.process, request);
    if (takeId !== currentTake) return;
    lastAudio = null;
    show(take);
  } catch (error) {
    if (takeId !== currentTake) return;
    app.togglePanel(PANEL, true);
    store.set({ phase: "idle", stage: "", error: error instanceof Error ? error.message : String(error), retryable: true });
  }
}

export async function retryAudio(): Promise<void> {
  if (lastAudio) await processAudio(lastAudio, true, directDelivery, true);
}

/** Format typed or pasted text, or a transcript the writer corrected. */
export async function formatText(text: string, extractCommands = true): Promise<void> {
  if (!text.trim()) return;
  const reformat = store.state.editing || text === store.state.take?.transcript || !extractCommands;
  if (store.state.phase === "working" || store.state.phase === "recording" || (unresolved() && !reformat)) {
    return app.toast("Insert or discard the current take first.");
  }
  try {
    if (!reformat || !delivery) delivery = captureDelivery(app.session, app.editor);
  } catch (error) {
    return app.toast(error instanceof Error ? error.message : String(error), "error");
  }
  const submittedDraft = text === store.state.draft ? text : undefined;
  const previous = store.state;
  directDelivery = false;
  const takeId = ++takeCounter;
  currentTake = takeId;
  app.togglePanel(PANEL, true);
  store.set({ ...INITIAL_STATE, prepare: store.state.prepare, draft: store.state.draft, phase: "working", stage: "Formatting with the local model" });
  try {
    const request: FormatTextRequest = { takeId, text, context: deliveryContext(), extractCommands };
    const take = await desktop.invoke<TakeResult>(DICTATION.format, request);
    if (takeId !== currentTake) return;
    show(take, submittedDraft);
  } catch (error) {
    if (takeId !== currentTake) return;
    store.set({ ...previous, draft: store.state.draft, phase: previous.take ? "review" : "idle", stage: "",
      ...(reformat && previous.take ? { editing: true, editText: text } : {}),
      error: error instanceof Error ? error.message : String(error) });
  }
}

function deliveryContext(): TakeContext {
  const from = delivery?.replacement?.from ?? scriptEnd(app.session);
  return buildTakeContext(app.session.script(), from?.paragraphId ?? null, from?.offset);
}

function show(take: TakeResult, submittedDraft?: string): void {
  store.set({
    phase: "review", stage: "", take, inserted: false, editing: false, editText: take.transcript, error: null, retryable: false,
    draft: submittedDraft !== undefined && store.state.draft === submittedDraft && !take.error ? "" : store.state.draft,
    suggestions: take.commands.map((command) => ({ command, status: "pending", scope: command.scope })),
    replacing: !!delivery?.replacement,
    selectedText: delivery?.replacement?.text ?? "",
  });
  const safe = take.autoApplyErrors?.length === 0 && !take.error && !take.warnings.length && !take.commands.length &&
    !take.diagnostics.length && !take.elements.some(e => e.uncertainty);
  if (directDelivery && !delivery?.replacement && safe && take.elements.length) insertTake();
  else app.togglePanel(PANEL, true);
  if (take.needsFormatterSetup) app.openModal("workspace.settings", { section: "modelManager" });
}

/** Back to idle once the writer has dealt with everything in the take. */
function settle(): void {
  if (!unresolved()) store.set({ ...INITIAL_STATE, prepare: store.state.prepare, draft: store.state.draft });
}

export function insertTake(): void {
  const { take, inserted } = store.state;
  if (!take?.elements.length || inserted) return;
  if (!delivery) return;
  try {
    const caret = deliverElements(app.session, delivery, take.elements);
    app.editor?.setSelection(caret);
    app.editor?.focus();
  } catch (error) {
    return app.toast(error instanceof Error ? error.message : String(error), "error");
  }
  app.toast(`Inserted ${take.elements.length} screenplay elements. Undo restores the previous draft.`, "success");
  store.set({ inserted: true });
  settle();
}

export function discardTake(): void {
  currentTake = 0;
  lastAudio = null;
  delivery = null;
  directDelivery = false;
  store.set({ ...INITIAL_STATE, prepare: store.state.prepare, draft: store.state.draft });
}

/**
 * The writer opened another document. A proposal was made for the old script's scene, cast and caret, so it is
 * dropped, and a take still in flight is ignored when it arrives.
 */
export function resetForNewDocument(): void {
  const { phase, take } = store.state;
  stopWhenReady = true;
  recorder?.cancel();
  recorder = null;
  clearInterval(ticker);
  const pending = phase === "working" || (!!take && unresolved());
  discardTake();
  if (pending) app.toast("The dictation take was dropped because the document changed.");
}

export function setEditing(editing: boolean): void {
  store.set({ editing, editText: store.state.take?.transcript ?? "" });
}

export function setScope(index: number, scope: "script" | "scene"): void {
  store.set({ suggestions: store.state.suggestions.map((s, i) => (i === index ? { ...s, scope } : s)) });
}

export function acceptSuggestion(index: number): void {
  const suggestion = store.state.suggestions[index];
  if (!suggestion || suggestion.status !== "pending") return;
  const matches = findMatches(app.session.script(), { ...suggestion.command, scope: suggestion.scope }, caretParagraph());
  const count = applyMatches(app.session, matches);
  app.toast(count ? `Changed ${count} place${count === 1 ? "" : "s"}.` : "Nothing matched.", count ? "success" : "info");
  mark(index, "accepted");
}

export function ignoreSuggestion(index: number): void {
  mark(index, "ignored");
}

function mark(index: number, status: "accepted" | "ignored"): void {
  store.set({ suggestions: store.state.suggestions.map((s, i) => (i === index ? { ...s, status } : s)) });
  settle();
}

/** The writer meant that sentence as script text: format the transcript again without picking out commands. */
export async function keepCommandsAsText(): Promise<void> {
  const text = store.state.take?.transcript;
  if (text) await formatText(text, false);
}

/** Load the speech model now, so the first take does not wait for it. */
export async function prepareEngine(): Promise<PrepareResult | null> {
  store.set({ prepare: { state: "busy", message: "Preparing the speech engine. The first load takes about 17 seconds once per machine." } });
  try {
    const result = await desktop.invoke<PrepareResult>(DICTATION.prepare);
    store.set({ prepare: { state: "done", message: prepareMessage(result) } });
    return result;
  } catch (error) {
    store.set({ prepare: { state: "error", message: error instanceof Error ? error.message : String(error) } });
    return null;
  }
}

/** Start loading the models when recording starts, so they load while the writer speaks. */
function warmUp(): Promise<unknown> {
  return (warmed ??= desktop.invoke<PrepareResult>(DICTATION.prepare).catch(() => {
    warmed = null;
  }));
}
