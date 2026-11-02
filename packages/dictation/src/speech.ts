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

/** One long-lived `speech-helper serve` process; each engine stays loaded once prepared. */
export class SpeechHelper {
  private child?: ChildProcessWithoutNullStreams;
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private readonly binary: string;

  constructor(binary: string) {
    this.binary = binary;
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
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
    // A missing binary arrives as "error", not "exit"; unhandled, it would crash the app.
    child.on("error", (error) => fail(new Error(`Speech helper could not start: ${error.message}`)));
    child.on("exit", (code) => fail(new Error(`Speech helper exited (${code}).`)));
    child.stdin.on("error", () => {});
    this.child = child;
    return child;
  }

  call(op: string, engine: HelperEngine, extra: Record<string, unknown> = {}): Promise<any> {
    const child = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

  close(): void {
    this.child?.stdin.end();
  }
}
