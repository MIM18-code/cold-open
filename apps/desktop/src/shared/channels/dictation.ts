// Dictation channels and payloads, shared by the main-process service (src/main/services/dictation.ts) and
// the renderer feature (src/renderer/features/dictation). Pure data and small pure helpers only: both
// processes import this file, so it must not touch Node or the DOM.
import type { ElementType } from "@screenplay/engine";

export const DICTATION = {
  /** renderer → main: WAV bytes in, a formatted take out. */
  process: "dictation:process",
  /** renderer → main: a typed or pasted transcript in, a formatted take out. */
  format: "dictation:format",
  /** Cancel a text-formatting job owned by this window. Payload: take ID. */
  cancelFormat: "dictation:cancel-format",
  /** renderer → main: load the speech model (and warm the formatting model). */
  prepare: "dictation:prepare",
  /** renderer → main: does the helper run, and does the model server answer? */
  check: "dictation:check",
  /** renderer → main: the resolved helper path, without starting it. */
  status: "dictation:status",
  /** renderer → main: pick the speech helper in an open dialog. Returns the path, or null when cancelled. */
  chooseHelper: "dictation:choose-helper",
  /** renderer → main: forget the chosen helper and find the app's own build again. */
  clearHelper: "dictation:clear-helper",
  /** renderer → main: microphone permission on macOS, asking once if it was never decided. */
  micAccess: "dictation:mic-access",
  /** main → renderer: progress of one take. */
  progress: "dictation:progress",
} as const;

export type SpeechEngineName = "parakeet" | "apple" | "whisper";
export const SPEECH_ENGINES: { id: SpeechEngineName; label: string }[] = [
  { id: "parakeet", label: "Parakeet (recommended)" },
  { id: "apple", label: "Apple speech recognition" },
  { id: "whisper", label: "Whisper" },
];

/** Settings keys in the settings store. */
export const SETTING_KEYS = {
  engine: "dictation.engine",
  /** The helper the writer picked with Choose. Main-owned (grants.*): pages can read it but not set it. */
  helperPath: "grants.speechHelper",
  whisperModel: "dictation.whisperModel",
  provider: "dictation.provider",
  endpoint: "dictation.endpoint",
  model: "dictation.model",
  localConfirmed: "dictation.localConfirmed",
  mode: "dictation.mode",
} as const;

/** The formatting model defaults match Writers Block's. */
export const SETTING_DEFAULTS = {
  engine: "parakeet" as SpeechEngineName,
  helperPath: "",
  whisperModel: "",
  provider: "ollama" as "ollama" | "compatible",
  endpoint: "http://127.0.0.1:11434",
  model: "qwen3.5:4b",
  localConfirmed: true,
  mode: "toggle" as "toggle" | "push",
};

/** The element names the formatter speaks. */
export const DICTATION_TYPES = ["scene_heading", "action", "character", "dialogue", "parenthetical", "transition", "shot", "note"] as const;
export type DictationType = (typeof DICTATION_TYPES)[number];

const TO_ENGINE: Record<DictationType, ElementType> = {
  scene_heading: "sceneHeading", action: "action", character: "character", dialogue: "dialogue",
  parenthetical: "parenthetical", transition: "transition", shot: "shot", note: "note",
};

export function toEngineType(type: DictationType): ElementType {
  return TO_ENGINE[type];
}

/** The formatter's name for an engine type, for the context it is shown. Types it has no word for read as action. */
export function fromEngineType(type: ElementType): DictationType {
  return DICTATION_TYPES.find((name) => TO_ENGINE[name] === type) ?? "action";
}

/** Parentheticals live in the script with their brackets; the formatter returns the bare direction. */
export function parentheticalText(text: string): string {
  const bare = text.trim().replace(/^\(+\s*/, "").replace(/\s*\)+$/, "");
  return `(${bare})`;
}

export interface ProposedElement {
  type: ElementType;
  text: string;
  /** Why the formatter was unsure, when it was. */
  uncertainty: string;
}

export interface TakeDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  elementIndex: number | null;
}

/** "Change Bob to Robert everywhere": offered as a suggestion, never applied by itself. */
export interface EditCommand {
  kind: "replace";
  find: string;
  replacement: string;
  scope: "script" | "scene";
  /** The sentence the writer spoke. */
  spoken: string;
}

/** What the renderer knows about the script around the caret. */
export interface TakeContext {
  /** Character names in the script, upper case. */
  characters: string[];
  /** Locations from the scene headings, upper case. */
  locations: string[];
  currentHeading: string;
  /** The current scene's text before the caret. */
  referenceText: string;
  previousElements: { type: DictationType; text: string }[];
  /** Characters whose first appearance is already in the script. */
  introduced: string[];
}

export const EMPTY_CONTEXT: TakeContext = {
  characters: [], locations: [], currentHeading: "", referenceText: "", previousElements: [], introduced: [],
};

export interface ProcessAudioRequest {
  takeId: number;
  /** A WAV file: 16 kHz, mono, 16-bit PCM. */
  audio: Uint8Array;
  context: TakeContext;
  /** Pick out spoken edit commands. Off when the writer chose to keep them as script text. */
  extractCommands?: boolean;
}

export interface FormatTextRequest {
  takeId: number;
  text: string;
  context: TakeContext;
  extractCommands?: boolean;
}

export interface TakeTimings {
  transcribeMs: number;
  formatMs: number;
  totalMs: number;
}

export interface TakeResult {
  takeId: number;
  source: "audio" | "text";
  /** What was heard or typed. */
  transcript: string;
  /** Speech engine and audio length, for audio takes. */
  engine?: string;
  audioSeconds?: number;
  elements: ProposedElement[];
  diagnostics: TakeDiagnostic[];
  /** Strict word/source checks for one-step delivery. Missing means review is required. */
  autoApplyErrors?: string[];
  warnings: string[];
  commands: EditCommand[];
  timings: TakeTimings;
  /** Set when the transcript is good but formatting failed. The transcript stays for another try. */
  error?: string;
}

export type ProgressStage = "saved" | "transcribing" | "formatting" | "done";

export interface TakeProgress {
  takeId: number;
  stage: ProgressStage;
}

export interface PrepareResult {
  engine: SpeechEngineName;
  /** Time to load the speech model. About 17 seconds the first time on a machine, then under a second. */
  speechMs: number;
  /** Set when the formatting model could not be warmed; speech is still ready. */
  modelWarning?: string;
}

export interface HelperStatus {
  ok: boolean;
  path: string;
  message: string;
}

export interface ServerStatus {
  ok: boolean;
  models: string[];
  message: string;
}

export interface CheckResult {
  helper: HelperStatus;
  server: ServerStatus;
}

export type MicStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";
