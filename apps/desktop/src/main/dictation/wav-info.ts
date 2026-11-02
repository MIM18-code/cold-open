// Reads the header of a WAV file the renderer sent, so the service refuses anything that is not audio
// before it writes a file or starts the helper.

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  seconds: number;
}

const MAX_BYTES = 64 * 1024 * 1024;

export function wavInfo(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength > MAX_BYTES) throw new Error("The recording is too long.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("The recording is not a WAV file.");
  let format: Omit<WavInfo, "seconds"> | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && at + 24 <= bytes.byteLength) {
      format = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (tag(at) === "data") {
      if (!format || !format.sampleRate || !format.channels || !format.bits) break;
      const length = Math.min(size, bytes.byteLength - at - 8);
      return { ...format, seconds: length / (format.sampleRate * format.channels * (format.bits / 8)) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The recording is not a valid WAV file.");
}
