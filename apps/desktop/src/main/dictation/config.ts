// Dictation settings as the pipeline uses them, and where the native speech helper lives.
import type { FormatterSettings } from "@screenplay/dictation";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { SETTING_DEFAULTS, SETTING_KEYS, SPEECH_ENGINES, type SpeechEngineName } from "../../shared/channels/dictation.ts";

export interface DictationConfig {
  engine: SpeechEngineName;
  /** The helper binary to run: the one the writer chose, else the first build found. */
  helperPath: string;
  /** helperPath is the writer's choice from the Choose dialog (a main-owned grants.* setting), checked before it runs. */
  helperGranted: boolean;
  whisperModel: string;
  formatter: FormatterSettings;
}

export const HELPER_RELATIVE = "native/speech-helper/.build/release/speech-helper";

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export interface HelperLookup {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  /** Electron's resources folder in a packaged app, where the helper ships beside the app. */
  resourcesPath?: string;
  exists?: (path: string) => boolean;
}

/**
 * The helper to run. The one the writer chose is used as given, so a wrong one is reported instead of
 * silently replaced. Otherwise the app's own locations: the SCREENPLAY_SPEECH_HELPER variable, this
 * checkout's build, the packaged app's resources, then the main checkout when this is a git worktree under it.
 */
export function resolveHelperPath(granted: string, lookup: HelperLookup): string {
  if (granted) return granted;
  const exists = lookup.exists ?? existsSync;
  const candidates = [
    lookup.env?.SCREENPLAY_SPEECH_HELPER,
    join(lookup.repoRoot, HELPER_RELATIVE),
    lookup.resourcesPath ? join(lookup.resourcesPath, "speech-helper") : undefined,
    ...(lookup.repoRoot.includes("/.claude/worktrees/") ? [join(lookup.repoRoot.split("/.claude/worktrees/")[0]!, HELPER_RELATIVE)] : []),
  ].filter((path): path is string => !!path);
  return candidates.find((path) => exists(path)) ?? candidates[0] ?? join(lookup.repoRoot, HELPER_RELATIVE);
}

/**
 * Why the chosen helper must not run, or null when it may. Only the Choose dialog in the main process sets it, but
 * the file can change afterwards, so it must still be a full path to an executable file.
 */
export function helperPathProblem(path: string): string | null {
  if (!isAbsolute(path)) return `The speech helper path must be a full path starting with "/": ${path}`;
  if (!existsSync(path)) return null;
  try {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) return `The speech helper at ${path} is not a file.`;
    accessSync(real, constants.X_OK);
  } catch {
    return `The speech helper at ${path} is not executable. Run "chmod +x" on it, or build it again.`;
  }
  return null;
}

export function readConfig(values: Record<string, unknown>, lookup: HelperLookup): DictationConfig {
  const engine = SPEECH_ENGINES.find((e) => e.id === values[SETTING_KEYS.engine])?.id ?? SETTING_DEFAULTS.engine;
  const provider = values[SETTING_KEYS.provider] === "compatible" ? "compatible" : "ollama";
  const confirmed = values[SETTING_KEYS.localConfirmed];
  // A grants.* key: settings:set refuses it, so only the Choose dialog in the main process wrote this value.
  const granted = text(values[SETTING_KEYS.helperPath], "");
  return {
    engine,
    helperPath: resolveHelperPath(granted, lookup),
    helperGranted: !!granted,
    whisperModel: text(values[SETTING_KEYS.whisperModel], ""),
    formatter: {
      provider,
      endpoint: text(values[SETTING_KEYS.endpoint], SETTING_DEFAULTS.endpoint),
      model: text(values[SETTING_KEYS.model], SETTING_DEFAULTS.model),
      localServerConfirmed: typeof confirmed === "boolean" ? confirmed : SETTING_DEFAULTS.localConfirmed,
      // Qwen 3.5 spends seconds thinking before it answers; a labelling task does not need it.
      ollamaDisableThinking: true,
    },
  };
}
