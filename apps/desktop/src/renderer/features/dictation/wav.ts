// Turns microphone samples into the file the speech helper reads: 16 kHz, mono, 16-bit PCM WAV. No DOM
// types here, so the encoder runs under node in tests.

export const TARGET_RATE = 16000;

/**
 * Streaming downsampler. Each output sample is the average of the input samples it covers (a box filter),
 * which is enough to keep speech clean when going from 44.1 or 48 kHz to 16 kHz.
 */
export class Resampler {
  private readonly ratio: number;
  private filled = 0;
  private sum = 0;

  constructor(fromRate: number, toRate = TARGET_RATE) {
    this.ratio = fromRate / toRate;
  }

  push(input: Float32Array): Float32Array {
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      let left = 1;
      while (left > 0) {
        const take = Math.min(left, this.ratio - this.filled);
        this.sum += input[i]! * take;
        this.filled += take;
        left -= take;
        if (this.filled >= this.ratio - 1e-9) {
          out[written++] = this.sum / this.ratio;
          this.sum = 0;
          this.filled = 0;
        }
      }
    }
    return out.subarray(0, written);
  }
}

/** Largest absolute sample, to tell a silent recording from a quiet one. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (const value of samples) max = Math.max(max, Math.abs(value));
  return max;
}

/** Map a block's level to a 0 to 1 meter position: silence at the bottom, a loud voice near the top. */
export function meterPosition(level: number): number {
  if (level <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 54));
}

/** Root mean square of a block, 0 to 1. */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

/** Encode mono float samples (-1 to 1) as a 16-bit PCM WAV file. */
export function encodeWav(chunks: Float32Array[], sampleRate = TARGET_RATE): Uint8Array {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  let at = 44;
  for (const chunk of chunks) {
    for (const value of chunk) {
      const clipped = Math.max(-1, Math.min(1, value));
      view.setInt16(at, Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767), true);
      at += 2;
    }
  }
  return bytes;
}

/** Average separate channel buffers into one mono buffer. */
export function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first || channels.length === 1) return first ?? new Float32Array(0);
  const out = new Float32Array(first.length);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i]! += channel[i]! / channels.length;
  return out;
}
