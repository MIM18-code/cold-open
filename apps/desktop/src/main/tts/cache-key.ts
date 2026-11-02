import { createHash } from "node:crypto";
import type { SynthesisRequest } from "../../shared/channels/table-read.ts";

/** Neural cache identity. Change the helper suffix whenever helper audio processing changes, so old takes miss. */
export const ENGINE_VERSION = "fluid-0.18.0-mlxAudio-87d0359538f8d7915ae77a41655dfcd891b6e614-mlx-0.33.0-helper-v4";

export interface SpeechIdentity {
  engineVersion: string;
  modelChecksum: string;
  quantization: string;
  voiceChecksum: string;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function normalizedSpeech(text: string): string { return text.normalize("NFC").replace(/\r\n?/g, "\n").trim(); }
export function audioKey(request: Omit<SynthesisRequest, "id">, identity?: SpeechIdentity): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    schema: 2, engine: request.engine, engineVersion: identity?.engineVersion ?? "system-v2",
    modelChecksum: identity?.modelChecksum ?? "system", quantization: identity?.quantization ?? "native",
    voice: request.voice, voiceChecksum: identity?.voiceChecksum ?? request.voice,
    text: normalizedSpeech(request.text), direction: request.direction ?? "",
    pronunciations: request.pronunciations ?? {}, generationSettings: request.generationSettings ?? {},
    contextFingerprint: request.contextFingerprint ?? ""
  }))).digest("hex");
}
