import type { ReadEngine, VoicePackState } from "../../../shared/channels/table-read.ts";

export const VOICES_CHANGED = "table-read:voices-changed";
export function downloadSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
export function memoryWarning(pack: VoicePackState, memoryGB?: number): string {
  return memoryGB !== undefined && memoryGB < pack.memoryGB
    ? `This Mac has ${Math.round(memoryGB)} GB of memory; ${pack.label} needs at least ${pack.memoryGB} GB. It may stall or stop other apps.` : "";
}
export function playbackPack(models: VoicePackState[], engine: ReadEngine, memoryGB = 0): VoicePackState | undefined {
  if (engine !== "qwen") return models.find((p) => p.id === engine);
  const preferred = memoryGB >= 32 ? "qwen-base-17b" : "qwen-base-06b";
  return models.find((p) => p.id === preferred && p.installed) ?? models.find((p) => p.engine === "qwen" && p.installed) ?? models.find((p) => p.id === preferred);
}
export function packPurpose(pack: VoicePackState): string {
  switch (pack.engine) {
    case "phonon": return "Fast English dialogue";
    case "kokoro": return "Quick reads with English accents";
    case "ming": return "Three English voice presets";
    case "qwen": return "Reads with saved reference voices";
    case "qwen-design": return "Creates voices from descriptions";
    default: return "Local speech";
  }
}
