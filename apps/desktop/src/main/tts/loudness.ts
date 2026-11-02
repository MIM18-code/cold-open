// Mirrors SpeechAudio.normalized in native/voice-helper so Mac voices land at the same level as the neural engines.
const TARGET_LUFS = -20, CEILING_DBTP = -2, MAX_BOOST_DB = 18;

function kWeighted(x: Float64Array, rate: number): Float64Array {
  const stage = (input: Float64Array, b: [number, number, number], a: [number, number]) => {
    const out = new Float64Array(input.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < input.length; n++) {
      const v = input[n]!, y = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      out[n] = y; x2 = x1; x1 = v; y2 = y1; y1 = y;
    }
    return out;
  };
  let k = Math.tan(Math.PI * 1681.974450955533 / rate);
  const q1 = 0.7071752369554196, vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q1 + k * k;
  const shelfB: [number, number, number] = [(vh + vb * k / q1 + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q1 + k * k) / a0];
  const shelfA: [number, number] = [2 * (k * k - 1) / a0, (1 - k / q1 + k * k) / a0];
  k = Math.tan(Math.PI * 38.13547087602444 / rate);
  const q2 = 0.5003270373238773; a0 = 1 + k / q2 + k * k;
  return stage(stage(x, shelfB, shelfA), [1, -2, 1], [2 * (k * k - 1) / a0, (1 - k / q2 + k * k) / a0]);
}

export function lufs(x: Float64Array, rate: number): number {
  const w = kWeighted(x, rate), block = Math.floor(0.4 * rate), step = Math.floor(0.1 * rate);
  const energies: number[] = [];
  if (w.length < block) energies.push(w.reduce((s, v) => s + v * v, 0) / Math.max(1, w.length));
  else {
    const cumulative = new Float64Array(w.length + 1);
    for (let i = 0; i < w.length; i++) cumulative[i + 1] = cumulative[i]! + w[i]! * w[i]!;
    for (let start = 0; start + block <= w.length; start += step) energies.push((cumulative[start + block]! - cumulative[start]!) / block);
  }
  const level = (e: number) => e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity;
  const absolute = energies.filter((e) => level(e) > -70);
  if (!absolute.length) return -Infinity;
  const relativeGate = level(absolute.reduce((s, e) => s + e, 0) / absolute.length) - 10;
  const gated = absolute.filter((e) => level(e) > relativeGate);
  return gated.length ? level(gated.reduce((s, e) => s + e, 0) / gated.length) : -Infinity;
}

export function truePeakDB(x: Float64Array): number {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 1; i < x.length - 2; i++) {
    const p0 = x[i - 1]!, p1 = x[i]!, p2 = x[i + 1]!, p3 = x[i + 2]!;
    for (const t of [0.25, 0.5, 0.75]) {
      const t2 = t * t, t3 = t2 * t;
      peak = Math.max(peak, Math.abs(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)));
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Scales a 16-bit PCM WAV to the shared loudness target in place; other layouts are returned unchanged. */
export function normalizeWave(data: Uint8Array): Uint8Array {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let rate = 0, channels = 0, bits = 0, codec = 0, start = -1, size = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const name = b.toString("ascii", i, i + 4), length = b.readUInt32LE(i + 4);
    if (name === "fmt ") { codec = b.readUInt16LE(i + 8); channels = b.readUInt16LE(i + 10); rate = b.readUInt32LE(i + 12); bits = b.readUInt16LE(i + 22); }
    if (name === "data") { start = i + 8; size = Math.min(length, b.length - start); break; }
    i += 8 + length + (length & 1);
  }
  if (codec !== 1 || bits !== 16 || start < 0 || !rate || !channels) return data;
  const frames = Math.floor(size / 2 / channels), mono = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += b.readInt16LE(start + (f * channels + c) * 2) / 32768;
    mono[f] = sum / channels;
  }
  const loudness = lufs(mono, rate);
  if (!Number.isFinite(loudness) || loudness <= -60) return data;
  let gain = Math.min(MAX_BOOST_DB, TARGET_LUFS - loudness);
  const peak = truePeakDB(mono);
  if (Number.isFinite(peak)) gain = Math.min(gain, CEILING_DBTP - peak);
  const factor = 10 ** (gain / 20), out = Buffer.from(b);
  for (let i = 0; i < frames * channels; i++) {
    const at = start + i * 2;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(b.readInt16LE(at) * factor))), at);
  }
  return new Uint8Array(out);
}
