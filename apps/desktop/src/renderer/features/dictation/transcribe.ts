// Record one spoken passage and return what was heard, for text fields outside the script (the quick note box).
// It reuses the dictation microphone capture and the speech helper behind DICTATION.process, with transcribeOnly
// so the local formatting model is never involved: the writer gets the words, not screenplay elements.
import { DICTATION, EMPTY_CONTEXT, type MicStatus, type ProcessAudioRequest, type TakeResult } from "../../../shared/channels/dictation.ts";
import { desktop } from "../../core/platform.ts";
import { MAX_SECONDS, Recorder } from "./capture.ts";
import { plainSpeechError } from "./messages.ts";

const MIN_SECONDS = 0.4;
const SILENT = 0.003;
// Apart from the Dictate panel's take IDs (counting up from 1), so its progress events never match these.
let takeId = 1_000_000;
let active = 0;

/** A note recording is open or being transcribed; the Dictate panel stays out of the way meanwhile. */
export function transcribing(): boolean {
  return active > 0;
}

export type TranscriberState = "idle" | "starting" | "recording" | "working";

export class Transcriber {
  state: TranscriberState = "idle";
  private recorder: Recorder | null = null;
  private cancelled = false;

  get seconds(): number {
    return this.recorder?.seconds ?? 0;
  }

  get meter(): number {
    return this.recorder?.meter ?? 0;
  }

  /** Open the microphone. Throws an Error whose message says what to do. */
  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.state = "starting";
    this.cancelled = false;
    active++;
    try {
      const access = await desktop.invoke<MicStatus>(DICTATION.micAccess).catch((): MicStatus => "unknown");
      if (access === "denied" || access === "restricted") throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      const next = new Recorder();
      await next.start();
      if (this.cancelled) return next.cancel();
      this.recorder = next;
      this.state = "recording";
      // The speech model loads while the writer talks.
      void desktop.invoke(DICTATION.prepare).catch(() => undefined);
    } catch (error) {
      this.reset();
      throw new Error(plainSpeechError(error));
    } finally {
      if (this.state === "starting") this.reset();
    }
  }

  /** True once the recording has run as long as a take may. */
  get full(): boolean {
    return this.seconds >= MAX_SECONDS;
  }

  /** Stop and transcribe. Resolves to the words heard; an empty string when there was nothing to hear. */
  async stop(): Promise<string> {
    const recorder = this.recorder;
    if (!recorder || this.state !== "recording") return "";
    this.recorder = null;
    this.state = "working";
    try {
      const { wav, seconds, peak } = recorder.stop();
      if (seconds < MIN_SECONDS) throw new Error("That was too short to transcribe.");
      if (peak < SILENT) throw new Error("The recording is silent. Check the microphone in System Settings > Sound > Input.");
      const request: ProcessAudioRequest = { takeId: ++takeId, audio: wav, context: EMPTY_CONTEXT, transcribeOnly: true };
      const take = await desktop.invoke<TakeResult>(DICTATION.process, request);
      return take.transcript.trim();
    } catch (error) {
      throw new Error(/silent/i.test((error as Error).message) ? (error as Error).message : plainSpeechError(error));
    } finally {
      this.reset();
    }
  }

  /** Drop the recording without transcribing it. */
  cancel(): void {
    this.cancelled = true;
    this.recorder?.cancel();
    this.recorder = null;
    this.reset();
  }

  private reset(): void {
    if (this.state !== "idle") active = Math.max(0, active - 1);
    this.state = "idle";
  }
}
