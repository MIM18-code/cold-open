import assert from "node:assert/strict";
import test from "node:test";
import { browserAudioGroup, browserGap } from "../src/renderer/features/table-read/player.ts";

test("Web Audio schedules both lanes on one clock and suspends that clock for pause", async () => {
  const nodes: { start: number; stopped: boolean; onended: (() => void) | null }[] = [];
  let contexts = 0, suspended = 0, resumed = 0;
  class FakeContext {
    currentTime = 10;
    sampleRate = 24000;
    destination = {};
    constructor() { contexts++; }
    async decodeAudioData() { return { duration: 2 }; }
    async suspend() { suspended++; }
    async resume() { resumed++; }
    createBuffer() { return { duration: 0.4 }; }
    createBufferSource() {
      const state = { start: -1, stopped: false, onended: null as (() => void) | null };
      nodes.push(state);
      return {
        buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {},
        get onended() { return state.onended; }, set onended(value) { state.onended = value; },
        start(time: number) { state.start = time; }, stop() { state.stopped = true; },
      };
    }
  }
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  try {
    const group = browserAudioGroup([{ bytes: new Uint8Array(), lane: 1 }, { bytes: new Uint8Array(), lane: 2 },
      { bytes: new Uint8Array(), lane: 1 }], 1, 180);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(contexts, 1); assert.equal(nodes[0]!.start, nodes[1]!.start);
    assert.equal(nodes[2]!.start, nodes[0]!.start + 2.18);
    group.pause(); await group.resume(); assert.equal(suspended, 1); assert.equal(resumed, 2);
    group.stop(); await group.done; assert(nodes.every((node) => node.stopped));
    const gap = browserGap(400); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(contexts, 1); gap.stop(); await gap.done;
    const cancelled = browserAudioGroup([{ bytes: new Uint8Array(), lane: 1 }], 1);
    const count = nodes.length; cancelled.stop(); await cancelled.done;
    await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(nodes.length, count);
  } finally { globalThis.AudioContext = original; }
});
