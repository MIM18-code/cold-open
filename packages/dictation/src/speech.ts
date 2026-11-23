// Pluggable speech recognition. The native helper (native/speech-helper) runs
// Parakeet through Core ML, Apple's SpeechTranscriber, or whisper.cpp; a writer
// who dictates with Wispr Flow or another app supplies text instead, through
// the same interface.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Transcript {
  engine: string;
  text: string;
  words: WordTiming[];
  audioSeconds: number;
  transcribeMs: number;
}

export interface SpeechEngine {
  readonly name: string;
  prepare(): Promise<void>;
  transcribe(audioPath: string): Promise<Transcript>;
}

export type HelperEngine = "parakeet" | "apple" | "whisper";

export interface SpeechHelperOptions {
  /** How long one call may wait for an answer before the helper is stopped. */
  timeoutMs?: number;
  /** How long close() waits for the helper to exit before killing it. */
  closeMs?: number;
}

// A desktop take is at most five minutes, and a first prepare may compile a Core ML model. Whisper on a slow Mac
// takes a few minutes for a long take; ten is past that, and short enough that a hung helper is noticed.
const CALL_TIMEOUT_MS = 10 * 60_000;
const CLOSE_GRACE_MS = 2000;

/** One long-lived `speech-helper serve` process; each engine stays loaded once prepared. */
export class SpeechHelper {
  private child?: ChildProcessWithoutNullStreams;
  private next = 1;
  /** Calls waiting for an answer, with the process each was sent to: a stopped helper fails only its own calls. */
  private readonly pending = new Map<number, { child: ChildProcessWithoutNullStreams; resolve: (value: any) => void; reject: (error: Error) => void }>();

  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly closeMs: number;

  constructor(binary: string, options: SpeechHelperOptions = {}) {
    this.binary = binary;
    this.timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    this.closeMs = options.closeMs ?? CLOSE_GRACE_MS;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.binary, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let reply: any;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = this.pending.get(reply.id);
      if (!waiter) return;
      this.pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply);
      else waiter.reject(new Error(reply.error ?? "Speech helper failed."));
    });
    const fail = (error: Error) => {
      if (this.child === child) this.child = undefined;
      this.rejectCalls(child, error);
    };
    // A missing binary arrives as "error", not "exit"; unhandled, it would crash the app.
    child.on("error", (error) => fail(new Error(`Speech helper could not start: ${error.message}`)));
    child.on("exit", (code) => fail(new Error(`Speech helper exited (${code}).`)));
    child.stdin.on("error", () => {});
    // Diagnostics are not read, but a full stderr pipe would stall the helper mid-transcription.
    child.stderr.resume();
    this.child = child;
    return child;
  }

  call(op: string, engine: HelperEngine, extra: Record<string, unknown> = {}): Promise<any> {
    const child = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`The speech helper did not answer in ${Math.round(this.timeoutMs / 60_000) || 1} minutes, so it was stopped. Try again.`));
        // A helper that stopped answering one call will not answer the next: start a fresh one then.
        if (this.child === child) this.child = undefined;
        child.kill("SIGKILL");
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        child,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ id, op, engine, ...extra }) + "\n");
    });
  }

  engine(kind: HelperEngine, options: Record<string, string> = {}): SpeechEngine {
    return {
      name: kind,
      prepare: async () => {
        await this.call("prepare", kind, { options });
      },
      transcribe: async (path) => (await this.call("transcribe", kind, { path, options })).result as Transcript,
    };
  }

  private rejectCalls(child: ChildProcessWithoutNullStreams, error: Error): void {
    for (const [id, waiter] of this.pending) {
      if (waiter.child !== child) continue;
      this.pending.delete(id);
      waiter.reject(error);
    }
  }

  /**
   * Ask the helper to exit, kill it if it does not, and fail any call still waiting. Settles once the helper is
   * gone, so quitting can wait for it instead of leaving a hung helper running.
   */
  close(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.child = undefined;
    this.rejectCalls(child, new Error("The speech helper was closed."));
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), this.closeMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // A helper that never started (its binary is missing) reports "error" and "close" but never "exit".
      child.once("exit", done);
      child.once("close", done);
      child.once("error", done);
      child.stdin.end();
    });
  }
}
