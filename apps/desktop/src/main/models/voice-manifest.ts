import { createHash } from "node:crypto";
import type { ReadEngine } from "../../shared/channels/table-read.ts";
import { VOICE_PACKS } from "./voice-packs.ts";

export interface VoiceSource {
  repo: string;
  license?: string;
  revision: string;
  include: string;
  strip: string;
  destination: string;
}
export interface VoiceFile { source: number; path: string; localPath: string; size: number; sha256: string; }
export interface VoicePack {
  id: string;
  engine: Exclude<ReadEngine, "system">;
  label: string;
  quantization: string;
  minimumMacOS: number;
  memoryGB: number;
  license: string;
  provenance: string;
  sources: VoiceSource[];
  files: VoiceFile[];
  unresolved?: string;
}
export { VOICE_PACKS };
export function safeRelative(path: string): boolean {
  return !!path && !path.includes("\\") && !path.includes("\0") && path.split("/").every((p) => !!p && p !== "." && p !== "..");
}
export function validateVoicePack(pack: VoicePack): void {
  if (!["phonon", "kokoro", "ming", "qwen", "qwen-design"].includes(pack.engine) ||
    !/^[a-z0-9-]+$/.test(pack.id) || pack.unresolved || !pack.files.length || !pack.license || !pack.provenance ||
    !Number.isInteger(pack.minimumMacOS) || pack.minimumMacOS < 15 || !Number.isFinite(pack.memoryGB) || pack.memoryGB <= 0 ||
    !pack.sources.length || pack.sources.some((s) => !/^[\w.-]+\/[\w.-]+$/.test(s.repo) || !/^[a-f0-9]{40}$/.test(s.revision))) {
    throw new Error("Voice pack is unresolved. Run npm run voices:manifest with network access before distribution.");
  }
  if (!Number.isSafeInteger(pack.files.reduce((n, f) => n + f.size, 0))) throw new Error("Invalid voice pack total size.");
  const paths = new Set<string>();
  for (const file of pack.files) {
    if (!pack.sources[file.source] || !safeRelative(file.path) || !safeRelative(file.localPath) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || paths.has(file.localPath)) {
      throw new Error("Invalid voice pack file manifest.");
    }
    paths.add(file.localPath);
  }
}
const LICENSE_URLS: Record<string, string> = {
  "cc-by-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "mit": "https://opensource.org/license/mit"
};
/** Text installed beside the weights as notices/NOTICE.txt. Built from the pinned manifest, so it always matches the files. */
export function noticeText(pack: VoicePack): string {
  const lines = [`${pack.label}`, "", `License: ${pack.license}`, `Provenance: ${pack.provenance}`, "", "Sources:"];
  for (const source of pack.sources) {
    const id = (source.license ?? "").toLowerCase();
    lines.push(`- https://huggingface.co/${source.repo} at ${source.revision}, license ${source.license ?? "not declared"}${LICENSE_URLS[id] ? ` (${LICENSE_URLS[id]})` : ""}`);
  }
  if (pack.sources.some((s) => s.license?.toLowerCase() === "cc-by-4.0") || /cc-by-4\.0/i.test(pack.license)) {
    lines.push("", "Attribution: these weights are licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).",
      "They are redistributed here after the Core ML conversion listed in Provenance. The original authors and licensor are named in",
      "the source model card kept in this folder. The license does not imply endorsement by the authors.");
  }
  lines.push("", "The source README and any LICENSE or NOTICE files published with the weights are kept in the source-N folders next to this file.", "");
  return lines.join("\n");
}
/**
 * Install identity: the folder name and cache identity of a pack. It covers only what decides the bytes on disk
 * (files, source revisions, quantization). Memory minimums, license and notice text can change without a re-download.
 */
export function packChecksum(pack: VoicePack): string {
  validateVoicePack(pack);
  return createHash("sha256").update(JSON.stringify({
    schema: 2, id: pack.id, engine: pack.engine, quantization: pack.quantization,
    sources: pack.sources.map((s) => ({ repo: s.repo, revision: s.revision })),
    files: pack.files.map((f) => ({ source: f.source, path: f.path, localPath: f.localPath, size: f.size, sha256: f.sha256 })),
  })).digest("hex");
}
export function performancePack(memoryBytes: number): string {
  return memoryBytes >= 32 * 1024 ** 3 ? "qwen-base-17b" : "qwen-base-06b";
}
