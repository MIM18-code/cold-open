export const TABLE_READ = {
  status: "table-read:status",
  prepare: "table-read:prepare",
  synthesize: "table-read:synthesize",
  cancel: "table-read:cancel",
  clearCache: "table-read:clear-cache",
  catalogue: "table-read:voice-catalogue",
  models: "table-read:models",
  modelsChanged: "table-read:models-changed",
  install: "table-read:install",
  remove: "table-read:remove",
  activity: "table-read:activity",
  design: "table-read:design-voice",
  readSidecar: "table-read:read-sidecar",
  writeSidecar: "table-read:write-sidecar",
  shareableReferences: "table-read:shareable-references",
  importReferences: "table-read:import-references",
} as const;

/** A table-read sidecar lives next to its script and is versioned on its own. */
export const SIDECAR_SUFFIX = ".coldopen-read.json";
/** Written by versions before the rename. Still read when no current sidecar exists; never written. */
export const LEGACY_SIDECAR_SUFFIX = ".inklot-read.json";
export const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
export const MAX_REFERENCE_ASSET_BYTES = 16 * 1024 * 1024;

/** A designed reference voice whose provenance allows it to travel in a bundle. */
export interface ShareableReference {
  id: string;
  engine: "qwen";
  label: string;
  transcript: string;
  description: string;
  tags: string[];
  provenance: string;
  generatorVersion: string;
  modelChecksum: string;
  audioChecksum: string;
  /** Base64 WAV. Never a filesystem path. */
  audio: string;
  /** Only a voice whose provenance permits sharing is ever returned. */
  shareable: true;
}

export const READ_ENGINES = ["system", "phonon", "ming", "kokoro", "qwen", "qwen-design"] as const;
export type ReadEngine = (typeof READ_ENGINES)[number];
export interface ReadVoice {
  id: string;
  label: string;
  language: string;
  tags?: string[];
  checksum?: string;
  engine?: ReadEngine;
}
export interface EngineStatus {
  id: ReadEngine;
  label: string;
  tier: string;
  available: boolean;
  ready: boolean;
  note: string;
  voices: ReadVoice[];
}
export interface ReaderStatus {
  engines: EngineStatus[];
  cacheBytes: number;
  memoryGB?: number;
  models?: VoicePackState[];
  activeEngine?: ReadEngine | null;
  prefetchPaused?: boolean;
}
export interface GenerationSettings { temperature?: number; seed?: number; speed?: number; }
export interface SynthesisRequest {
  id: string;
  engine: ReadEngine;
  voice: string;
  text: string;
  priority?: "foreground" | "prefetch";
  direction?: string;
  pronunciations?: Record<string, string>;
  contextFingerprint?: string;
  generationSettings?: GenerationSettings;
}
export interface SynthesisResult { audio: Uint8Array; cached: boolean; }
export const MAX_SPEECH_CHARS = 1200;
export function isReadEngine(value: unknown): value is ReadEngine {
  return (READ_ENGINES as readonly unknown[]).includes(value);
}
export function validateSynthesis(value: unknown): SynthesisRequest {
  const r = value as Partial<SynthesisRequest> | null;
  if (!r || !isReadEngine(r.engine) || typeof r.id !== "string" || !/^[\w-]{1,100}$/.test(r.id)
    || typeof r.voice !== "string" || !r.voice || r.voice.length > 120 || /[\x00-\x1f]/.test(r.voice)
    || typeof r.text !== "string" || !r.text.trim() || r.text.length > MAX_SPEECH_CHARS || r.text.includes("\0")) {
    throw new Error("Invalid table-read request.");
  }
  if (r.priority !== undefined && r.priority !== "foreground" && r.priority !== "prefetch"
    || r.direction !== undefined && (typeof r.direction !== "string" || r.direction.length > 500)
    || r.contextFingerprint !== undefined && (typeof r.contextFingerprint !== "string" || r.contextFingerprint.length > 200)) {
    throw new Error("Invalid speech context.");
  }
  if (r.pronunciations !== undefined && (!r.pronunciations || typeof r.pronunciations !== "object"
    || Array.isArray(r.pronunciations) || Object.entries(r.pronunciations).length > 100
    || Object.entries(r.pronunciations).some(([k, v]) => !k || k.length > 100 || typeof v !== "string" || v.length > 200))) {
    throw new Error("Invalid pronunciations.");
  }
  if (r.generationSettings !== undefined) {
    const g = r.generationSettings;
    if (!g || typeof g !== "object" || Array.isArray(g)
      || Object.keys(g).some((k) => !["temperature", "seed", "speed"].includes(k))
      || g.temperature !== undefined && (!Number.isFinite(g.temperature) || g.temperature < 0 || g.temperature > 1)
      || g.seed !== undefined && (!Number.isSafeInteger(g.seed) || g.seed < 0 || g.seed > 2147483647)
      || g.speed !== undefined && (!Number.isFinite(g.speed) || g.speed < 0.5 || g.speed > 2)) {
      throw new Error("Invalid generation settings.");
    }
  }
  return r as SynthesisRequest;
}
export interface VoicePackState {
  id: string;
  label: string;
  engine: string;
  installed: boolean;
  sizeBytes: number;
  diskBytes: number;
  minimumMacOS: number;
  memoryGB: number;
  license: string;
  licenseUrls?: string[];
  provenance: string;
  revision: string[];
  unresolved?: string;
}

export interface DesignedAudition { id: string; audio: Uint8Array; }
export interface ModelProgress { packId: string; completedBytes: number; totalBytes: number; }
