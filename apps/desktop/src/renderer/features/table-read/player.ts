import { readRevision } from "./workflow.ts";
import type { ReadCue } from "@screenplay/engine";
export interface AudioHandle { done: Promise<void>; pause(): void; resume(): Promise<void>; stop(): void; rate(value: number): void; }
export interface PlayerDeps { synthesize(cue: ReadCue): Promise<Uint8Array>; audio(bytes: Uint8Array, rate: number): AudioHandle; gap?(ms: number): AudioHandle; audioGroup?(items: { bytes: Uint8Array; lane: number }[], rate: number, gapMs: number): AudioHandle; cancel(): Promise<unknown>; highlight(cue: ReadCue | null): void; }
export type PlayerState = "idle" | "loading" | "playing" | "paused" | "finished" | "error";

/** A reading owns an immutable cue list. Live edits are reported but never silently replace spoken words. */
export class ReadPlayer {
  state: PlayerState = "idle";
  cues: ReadCue[] = [];
  index = 0;
  error = "";
  speed = 1;
  gapMs = 180;
  revision = 0;
  stale = false;
  repeat = false;
  simultaneous = false;
  sourceRevision = "";
  sessionId = "";
  rehearsalSpeaker = "";
  awaitingCue = false;
  updateQueued = false;
  private generation = 0;
  private current?: AudioHandle;
  private unpause?: () => void;
  private manualCue?: () => void;
  private pendingPlan?: { cues: ReadCue[]; index: number };
  private gapTimer?: ReturnType<typeof setTimeout>;
  private endGap?: () => void;
  private cancelled: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private readonly deps: PlayerDeps;
  constructor(deps: PlayerDeps) { this.deps = deps; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  private emit() { this.revision++; for (const fn of this.listeners) fn(); }
  get active(): boolean { return ["playing", "loading", "paused"].includes(this.state); }
  setRate(rate: number) { this.speed = Number.isFinite(rate) ? Math.max(0.6, Math.min(1.8, rate)) : 1; this.current?.rate(this.speed); this.emit(); }
  setGap(ms: number) { this.gapMs = Number.isFinite(ms) ? Math.max(0, Math.min(2000, ms)) : 180; this.emit(); }
  setSimultaneous(value: boolean) { if (this.active) return; this.simultaneous = value; this.emit(); }
  setRepeat(value: boolean) { this.repeat = value; this.emit(); }
  setRehearsalSpeaker(value: string) { if (this.active) throw new Error("Stop playback before changing the rehearsal role."); this.rehearsalSpeaker = value; this.emit(); }
  markEdited() { if (this.active && !this.stale) { this.stale = true; this.emit(); } }
  /** The current speech finishes as heard. A queued update begins at the next identifiable speech. */
  queueUpdatedPlan(cues: ReadCue[]) {
    if (!this.active) return;
    let currentIndex = this.index;
    if (this.simultaneous && !this.rehearsalSpeaker && this.cues[currentIndex]?.dual) {
      while (this.cues[currentIndex + 1]?.dual === this.cues[this.index]!.dual) currentIndex++;
    }
    const current = this.cues[currentIndex];
    let next = cues.findIndex((c) => c.id === current?.id);
    if (next >= 0) next++;
    else {
      const remaining = new Set(this.cues.slice(currentIndex + 1).map((c) => c.id));
      next = cues.findIndex((c) => remaining.has(c.id));
    }
    if (next < 0) throw new Error("The remaining speeches were removed or restructured. Stop and restart from the current paragraph.");
    this.pendingPlan = { cues: structuredClone(cues), index: next };
    this.updateQueued = true; this.emit();
  }
  stop() {
    this.generation++; this.current?.stop(); this.current = undefined;
    this.unpause?.(); this.unpause = undefined; this.manualCue?.(); this.manualCue = undefined;
    clearTimeout(this.gapTimer); this.endGap?.(); this.endGap = undefined;
    this.pendingPlan = undefined; this.updateQueued = false; this.awaitingCue = false;
    this.state = "idle"; this.error = ""; this.deps.highlight(null);
    this.cancelled = this.deps.cancel().catch(() => {}); this.emit();
  }
  play(cues = this.cues, index = 0) {
    this.stop(); this.cues = structuredClone(cues); this.index = Math.max(0, Math.min(index, cues.length - 1)); this.stale = false;
    if (!cues.length) { this.error = "There is no readable text in this range."; this.state = "error"; this.emit(); return; }
    this.sourceRevision = readRevision(this.cues); this.sessionId = crypto.randomUUID();
    const generation = this.generation;
    this.state = "loading"; this.emit(); void this.loop(generation, this.cues);
  }
  pause() { if (!this.active || this.state === "paused") return; this.current?.pause(); this.state = "paused"; this.emit(); }
  resume() {
    if (this.state !== "paused") return;
    if (this.awaitingCue) { this.awaitingCue = false; this.state = "loading"; this.manualCue?.(); this.manualCue = undefined; this.emit(); return; }
    this.state = this.current ? "playing" : "loading";
    const generation = this.generation;
    void this.current?.resume().catch((error) => { if (generation === this.generation) this.fail(error); });
    this.unpause?.(); this.unpause = undefined; this.emit();
  }
  seek(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.cues.length) return;
    const stale = this.stale;
    this.play(this.cues, index);
    this.stale = stale; this.emit();
  }
  replaceDocument() {
    this.stop(); this.cues = []; this.index = 0; this.stale = false;
    this.sourceRevision = ""; this.sessionId = ""; this.emit();
  }
  close() { this.stop(); }
  outputChanged() { this.stop(); this.error = "Audio output changed. Press Play to restart this reading."; this.emit(); }
  helperFailed(message: string) { this.fail(new Error(message)); }
  next(direction: 1 | -1) {
    if (!this.cues.length) return;
    const stale = this.stale;
    this.play(this.cues, Math.max(0, Math.min(this.cues.length - 1, this.index + direction)));
    this.stale = stale; this.emit();
  }
  private async wait(g: number) { if (g === this.generation && this.state === "paused") await new Promise<void>((resolve) => { this.unpause = resolve; }); }
  private fail(error: unknown) { this.stop(); this.state = "error"; this.error = error instanceof Error ? error.message : String(error); this.emit(); }
  private async loop(g: number, cues: ReadCue[]) {
    type Outcome = { bytes: Uint8Array; error?: never } | { error: unknown; bytes?: never };
    const fetchCue = (i: number): Promise<Outcome> => cues[i]!.speaker === this.rehearsalSpeaker
      ? Promise.resolve({ bytes: new Uint8Array() })
      : this.deps.synthesize(cues[i]!).then((bytes) => ({ bytes }), (error) => ({ error }));
    try {
      await this.cancelled; if (g !== this.generation) return;
      const pending = new Map<number, Promise<Outcome>>();
      const fetch = (i: number) => {
        let job = pending.get(i);
        if (!job) { job = fetchCue(i); pending.set(i, job); }
        return job;
      };
      const prefetch = (i: number) => {
        for (let n = i; n < Math.min(cues.length, i + 4); n++) void fetch(n);
      };
      prefetch(this.index);
      for (let i = this.index; i < cues.length; i++) {
        const result = await fetch(i);
        if (g !== this.generation) return;
        if ("error" in result) throw result.error;
        await this.wait(g); if (g !== this.generation) return;
        this.index = i; this.deps.highlight(cues[i]!);
        let end = i + 1;
        if (this.simultaneous && this.deps.audioGroup && cues[i]!.dual && !this.rehearsalSpeaker) {
          while (end < cues.length && cues[end]!.dual === cues[i]!.dual) end++;
        }
        const group = [{ bytes: result.bytes!, lane: cues[i]!.lane ?? 1 }];
        for (let n = i + 1; n < end; n++) {
          const other = await fetch(n);
          if (g !== this.generation) return;
          if ("error" in other) throw other.error;
          group.push({ bytes: other.bytes!, lane: cues[n]!.lane ?? 1 });
        }
        await this.wait(g); if (g !== this.generation) return;
        if (end > i + 1) {
          const members = cues.slice(i, end);
          this.deps.highlight({ ...cues[i]!, paragraphIds: members.flatMap((cue) => cue.paragraphIds), source: members.flatMap((cue) => cue.source) });
        }
        for (let n = i; n < end; n++) pending.delete(n);
        prefetch(end);
        if (cues[i]!.speaker === this.rehearsalSpeaker) {
          this.awaitingCue = true; this.state = "paused";
          const advance = new Promise<void>((resolve) => { this.manualCue = resolve; });
          this.emit(); await advance;
        } else {
          this.current = group.length > 1
            ? this.deps.audioGroup!(group, this.speed, this.gapMs)
            : this.deps.audio(result.bytes!, this.speed); this.state = "playing"; this.emit();
          await this.current.done;
        }
        if (g !== this.generation) return;
        i = end - 1;
        this.current = undefined;
        await this.wait(g); if (g !== this.generation) return;
        if (this.pendingPlan) {
          const plan = this.pendingPlan;
          if (plan.index >= plan.cues.length) { this.stop(); this.state = "finished"; this.stale = false; this.emit(); }
          else this.play(plan.cues, plan.index);
          return;
        }
        if (i + 1 < cues.length && this.gapMs) {
          if (this.deps.gap) {
            this.current = this.deps.gap(this.gapMs);
            await this.current.done;
            if (g !== this.generation) return;
            this.current = undefined;
          } else {
            await new Promise<void>((resolve) => { this.endGap = resolve; this.gapTimer = setTimeout(resolve, this.gapMs); });
            this.endGap = undefined;
          }
        }
        if (g !== this.generation) return;
        await this.wait(g); if (g !== this.generation) return;
        this.state = "loading"; this.emit();
      }
      if (this.repeat) { const stale = this.stale; this.play(cues); this.stale = stale; this.emit(); return; }
      this.state = "finished"; this.deps.highlight(null); this.emit();
    } catch (error) { if (g === this.generation) this.fail(error); }
  }
}

let clock: AudioContext | undefined;
function audioClock() { return clock ??= new AudioContext(); }

/** All lanes share one context and start time. Suspend preserves offsets through pauses. */
export function browserAudioGroup(items: { bytes: Uint8Array; lane: number }[], rate: number, gapMs = 0): AudioHandle {
  const context = audioClock();
  return clockPlayback(() => Promise.all(items.map((item) => context.decodeAudioData(new Uint8Array(item.bytes).buffer))), items.map((item) => item.lane), rate, gapMs);
}
export function browserGap(ms: number): AudioHandle {
  const context = audioClock();
  return clockPlayback(async () => [context.createBuffer(1, Math.max(1, Math.round(ms * context.sampleRate / 1000)), context.sampleRate)], [1], 1, 0);
}
function clockPlayback(load: () => Promise<AudioBuffer[]>, laneIds: number[], rate: number, gapMs: number): AudioHandle {
  const context = audioClock();
  const nodes: AudioBufferSourceNode[] = [];
  let closed = false, paused = false, speed = rate;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    for (const node of nodes) { node.onended = null; node.stop(); node.disconnect(); }
    error ? reject(error) : resolve();
  };
  void load()
    .then(async (buffers) => {
      if (closed) return;
      if (!paused) await context.resume();
      if (closed) return;
      const start = context.currentTime + 0.02;
      const lanes = new Map<number, number>();
      let remaining = buffers.length;
      buffers.forEach((buffer, i) => {
        const lane = laneIds[i]!, offset = lanes.get(lane) ?? 0;
        const node = context.createBufferSource();
        node.buffer = buffer; node.playbackRate.value = speed; node.connect(context.destination);
        node.onended = () => { if (--remaining === 0) finish(); };
        nodes.push(node); node.start(start + offset);
        lanes.set(lane, offset + buffer.duration / speed + gapMs / 1000);
      });
    }).catch(finish);
  return {
    done,
    pause() { paused = true; void context.suspend().catch(finish); },
    async resume() { paused = false; await context.resume(); },
    stop: () => finish(),
    // Multi-part lanes have scheduled offsets; apply speed changes on the next group.
    rate(value) { if (nodes.length <= 1) { speed = value; for (const node of nodes) node.playbackRate.value = value; } },
  };
}
export function browserAudio(bytes: Uint8Array, rate: number): AudioHandle {
  return browserAudioGroup([{ bytes, lane: 1 }], rate);
}
