// Microphone capture: getUserMedia into an audio tap, downsampled as it arrives to 16 kHz mono and encoded as
// WAV on stop. The tap is an AudioWorklet (tap.worklet.js, a separate file because the page's CSP allows only
// its own scripts); if it cannot load, a ScriptProcessor does the same job on the main thread.
import workletUrl from "./tap.worklet.js?url&no-inline";
import { Resampler, TARGET_RATE, downmix, encodeWav, meterPosition, peak, rms } from "./wav.ts";

export const MAX_SECONDS = 300;

export interface Recording {
  wav: Uint8Array;
  seconds: number;
  /** Loudest sample, 0 to 1. Near zero means the microphone heard nothing. */
  peak: number;
}

export class Recorder {
  /** Smoothed loudness for the meter, 0 to 1. */
  meter = 0;
  /** Seconds of audio captured so far. */
  seconds = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private nodes: AudioNode[] = [];
  private resampler?: Resampler;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private loudest = 0;
  private tapKind: "worklet" | "script" | "" = "";

  get kind(): string {
    return this.tapKind;
  }

  /** Why the worklet was not used, when the ScriptProcessor took over. */
  workletError = "";

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.resume();
      this.resampler = new Resampler(context.sampleRate);
      const source = context.createMediaStreamSource(this.stream);
      const mute = context.createGain();
      mute.gain.value = 0;
      mute.connect(context.destination);
      const tap = await this.createTap(context);
      source.connect(tap);
      tap.connect(mute);
      this.nodes = [source, tap, mute];
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private async createTap(context: AudioContext): Promise<AudioNode> {
    try {
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, "dictation-tap", { numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (event: MessageEvent<Float32Array[]>) => this.take(event.data);
      this.tapKind = "worklet";
      return node;
    } catch (error) {
      this.workletError = error instanceof Error ? error.message : String(error);
      const node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => {
        const { inputBuffer } = event;
        this.take(Array.from({ length: inputBuffer.numberOfChannels }, (_, c) => inputBuffer.getChannelData(c).slice()));
      };
      this.tapKind = "script";
      return node;
    }
  }

  private take(channels: Float32Array[]): void {
    const mono = downmix(channels);
    this.meter = Math.max(meterPosition(rms(mono)), this.meter * 0.8);
    this.loudest = Math.max(this.loudest, peak(mono));
    const out = this.resampler!.push(mono);
    this.chunks.push(out);
    this.samples += out.length;
    this.seconds = this.samples / TARGET_RATE;
  }

  /** Stop and encode what was heard. */
  stop(): Recording {
    const recording = { wav: encodeWav(this.chunks), seconds: this.samples / TARGET_RATE, peak: this.loudest };
    this.release();
    return recording;
  }

  /** Stop and throw the audio away. */
  cancel(): void {
    this.release();
  }

  private release(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.chunks = [];
    this.meter = 0;
  }
}
