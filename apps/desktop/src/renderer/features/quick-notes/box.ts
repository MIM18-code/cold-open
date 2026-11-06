// The quick note box: state and behaviour outside React, so the command, the Notes panel button and the tray all
// reach one box. The text is written into the document as it is typed; closing only hides the box.
import { plainText } from "@screenplay/engine";
import { useSyncExternalStore } from "react";
import { app } from "../../core/app.ts";
import type { DocumentSession } from "../../core/session.ts";
import { plainSpeechError } from "../dictation/messages.ts";
import { Transcriber } from "../dictation/transcribe.ts";
import { store as dictationStore } from "../dictation/store.ts";
import { captureAnchor, insertSpoken, QuickNote } from "./quick-note.ts";
import { rememberOwn } from "./tray.ts";

export interface BoxState {
  open: boolean;
  text: string;
  /** The line the note is attached to, or a plain statement that it is not attached. */
  where: string;
  mic: "idle" | "starting" | "recording" | "working";
  seconds: number;
  level: number;
  /** One plain line under the box: what the microphone is doing, or why it did not work. */
  message: string;
  /** Bumped to move focus into the box again. */
  focusTick: number;
  /** Where the next spoken words go; the caret of the text area when the writer last touched it. */
  caret: [number, number];
}

const CLOSED: BoxState = { open: false, text: "", where: "", mic: "idle", seconds: 0, level: 0, message: "", focusTick: 0, caret: [0, 0] };
const SAVE_DELAY = 400;

let state: BoxState = CLOSED;
const listeners = new Set<() => void>();
let note: QuickNote | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let mic: Transcriber | null = null;
let offFlush: (() => void) | undefined;
/** The transcription in flight, so closing the box can wait for it instead of dropping the words. */
let heardSoFar: Promise<string> | null = null;

function set(patch: Partial<BoxState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useQuickNote(): BoxState {
  return useSyncExternalStore((onChange) => (listeners.add(onChange), () => listeners.delete(onChange)), () => state);
}

export function quickNoteState(): BoxState {
  return state;
}

/** The record the box is writing, once its first words have created one. */
export function quickNoteId(): string | null {
  return note?.id ?? null;
}

function describe(session: DocumentSession): string {
  const id = app.editor?.getSelection()?.head.paragraphId ?? app.editor?.currentParagraphId();
  if (!id || !session.doc.has(id)) return "Not attached to a line in the script";
  const text = plainText(session.doc.paragraph(id).runs).trim();
  return text ? `Attached to “${text.length > 38 ? `${text.slice(0, 37)}…` : text}”` : "Attached to the current line";
}

/** Open the box, or move the writer back into it when it is already open. */
export function openQuickNote(): void {
  const session = app.session;
  if (session.readOnly) {
    app.toast("This script is read-only, so it can't take a new note.", "error");
    return;
  }
  if (state.open) return set({ focusTick: state.focusTick + 1 });
  app.flushPending();
  const anchor = captureAnchor(session, app.editor?.getSelection(), app.editor?.currentParagraphId());
  const where = describe(session);
  note = new QuickNote(session, { author: app.setting("collab.name", "Writer"), ...(anchor ? { anchor } : {}), onCreate: rememberOwn });
  offFlush = app.onFlush(() => flushQuickNote());
  set({ ...CLOSED, open: true, where, focusTick: state.focusTick + 1 });
}

export function setQuickText(text: string, caret?: [number, number]): void {
  set({ text, ...(caret ? { caret } : {}) });
  clearTimeout(timer);
  timer = setTimeout(flushQuickNote, SAVE_DELAY);
}

export function setQuickCaret(caret: [number, number]): void {
  state = { ...state, caret };
}

/** Write what is in the box into the script now. Safe to call at any time, open or not. False when it couldn't. */
export function flushQuickNote(): boolean {
  clearTimeout(timer);
  if (!note) return true;
  try {
    note.save(state.text);
    return true;
  } catch (error) {
    set({ message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function teardown(): void {
  clearTimeout(timer);
  clearInterval(ticker);
  offFlush?.();
  offFlush = undefined;
  note = null;
  mic = null;
  heardSoFar = null;
  set({ ...CLOSED, focusTick: state.focusTick });
}

/** Done: keep the note, hide the box and give the caret back to the script. */
export async function closeQuickNote(): Promise<void> {
  if (!state.open) return;
  const finished = note, recorder = mic, pending = heardSoFar, text = state.text, [start, end] = state.caret;
  // The box goes at once, so nothing can be typed into it while words are still being turned into text. Those words
  // join this note when they arrive; a note opened meanwhile is a different one and is left alone.
  // A note the script can't take (it is full, say) keeps the box open with the reason, so the words aren't lost.
  if (!flushQuickNote() && (!recorder || recorder.state === "idle")) return;
  teardown();
  app.editor?.focus();
  const heard = recorder && recorder.state !== "idle" ? await settleMic(recorder, pending) : "";
  // The script was closed meanwhile: show the words (errors stay in Activity) rather than write them nowhere.
  if (heard && finished && app.session !== finished.session) {
    app.toast(`The script closed before your words joined the note: “${heard}”`, "error");
    return;
  }
  try {
    finished?.finish(heard ? insertSpoken(text, start, end, heard).text : text);
    if (heard) app.toast("Added what you said to the note.", "success");
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), "error");
  }
}

async function settleMic(recorder: Transcriber, pending: Promise<string> | null): Promise<string> {
  try {
    if (recorder.state === "recording") return await recorder.stop();
    if (recorder.state === "working") return (await pending) ?? "";
    if (recorder.state === "starting") return recorder.cancel(), "";
  } catch (error) {
    app.toast(plainSpeechError(error), "error");
  }
  return "";
}

/** One tap starts the microphone, the next stops it and adds the words at the caret. */
export async function toggleQuickMic(): Promise<void> {
  if (!state.open || state.mic === "working" || state.mic === "starting") return;
  if (state.mic === "recording") return stopQuickMic();
  if (dictationStore.state.phase === "recording" || dictationStore.state.phase === "working") {
    return set({ message: "Dictation is busy. Finish it first, then try again." });
  }
  const recorder = (mic = new Transcriber());
  set({ mic: "starting", message: "" });
  try {
    await recorder.start();
  } catch (error) {
    if (mic === recorder) mic = null;
    return set({ mic: "idle", message: error instanceof Error ? error.message : String(error) });
  }
  if (mic !== recorder) return recorder.cancel();
  set({ mic: "recording", message: "" });
  ticker = setInterval(() => {
    set({ seconds: recorder.seconds, level: recorder.meter });
    if (recorder.full) void stopQuickMic();
  }, 100);
}

async function stopQuickMic(): Promise<void> {
  const recorder = mic;
  if (!recorder || recorder.state !== "recording") return;
  clearInterval(ticker);
  set({ mic: "working", level: 0, message: "Writing down what you said…" });
  try {
    const pending = (heardSoFar = recorder.stop());
    const heard = await pending;
    if (mic !== recorder) return;
    mic = null;
    if (!heard) return set({ mic: "idle", message: "No speech heard. Try again." });
    const [start, end] = state.caret;
    const next = insertSpoken(state.text, start, end, heard);
    set({ mic: "idle", message: "", seconds: 0, caret: [next.caret, next.caret], focusTick: state.focusTick + 1 });
    setQuickText(next.text, [next.caret, next.caret]);
    flushQuickNote();
  } catch (error) {
    if (mic !== recorder) return;
    mic = null;
    set({ mic: "idle", seconds: 0, message: error instanceof Error ? error.message : String(error) });
  }
}

/** The open script changed or the window is going away: write the note to the script it was started in. */
export function abandonQuickNote(): void {
  if (!state.open) return;
  mic?.cancel();
  try {
    note?.finish(state.text);
  } catch {
    /* The script it belonged to is gone. */
  }
  teardown();
}
