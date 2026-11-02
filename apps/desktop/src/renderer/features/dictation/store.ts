// What the dictation panel shows, held outside React so the command, the toolbar button and the panel
// all see the same state.
import { useSyncExternalStore } from "react";

import type { EditCommand, PrepareResult, TakeResult } from "../../../shared/channels/dictation.ts";

export type Phase = "idle" | "recording" | "working" | "review";

export interface Suggestion {
  command: EditCommand;
  status: "pending" | "accepted" | "ignored";
  /** The writer can widen or narrow the command before accepting. */
  scope: EditCommand["scope"];
}

export interface DictationState {
  phase: Phase;
  /** Meter position while recording, 0 to 1. */
  level: number;
  seconds: number;
  /** What the pipeline is doing while the phase is "working". */
  stage: string;
  take: TakeResult | null;
  /** True once the take's elements are in the script. */
  inserted: boolean;
  suggestions: Suggestion[];
  /** The text box for typed or pasted transcripts. */
  draft: string;
  /** The transcript is open for editing. */
  editing: boolean;
  editText: string;
  error: string | null;
  /** The recording that failed to process, kept so the writer can try again. */
  retryable: boolean;
  prepare: { state: "idle" | "busy" | "done" | "error"; message: string };
}

export const INITIAL_STATE: DictationState = {
  phase: "idle", level: 0, seconds: 0, stage: "", take: null, inserted: false, suggestions: [], draft: "", editing: false,
  editText: "", error: null, retryable: false, prepare: { state: "idle", message: "" },
};

export function prepareMessage(result: PrepareResult): string {
  const seconds = result.speechMs / 1000;
  const speech = seconds > 5
    ? `Speech engine ready. Loading took ${seconds.toFixed(1)} seconds because the model compiled for this Mac; later loads take under a second.`
    : `Speech engine ready in ${seconds.toFixed(1)} seconds.`;
  return result.modelWarning ? `${speech} The formatting model is not ready: ${result.modelWarning}` : `${speech} The formatting model is loaded.`;
}

class Store {
  state: DictationState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();

  set(change: Partial<DictationState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): DictationState => this.state;
}

export const store = new Store();

export function useDictation(): DictationState {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
