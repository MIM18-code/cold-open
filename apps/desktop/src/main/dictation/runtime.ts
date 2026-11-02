// Wires the pipeline to the real speech helper and the local model server. The service loads this module on
// first use: @screenplay/dictation reads its prompt file when it loads, and a missing file should fail
// dictation, not the whole app.
import { LocalFormatter, SpeechHelper } from "@screenplay/dictation";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";

import type {
  CheckResult, FormatTextRequest, HelperStatus, PrepareResult, ProcessAudioRequest, ServerStatus, TakeResult,
} from "../../shared/channels/dictation.ts";
import { type DictationConfig, type HelperLookup, helperPathProblem, readConfig } from "./config.ts";
import { explainError, helperMissingMessage, modelMissingMessage } from "./errors.ts";
import { DictationPipeline, type Progress } from "./pipeline.ts";

export interface RuntimeOptions {
  /** Current settings, read on every request so a change applies to the next take. */
  settings(): Record<string, unknown>;
  lookup: HelperLookup;
}

export function checkHelper(path: string): Promise<HelperStatus> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve({ ok: false, path, message: helperMissingMessage(path) });
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return resolve({ ok: false, path, message: `The speech helper at ${path} is not executable. Run "chmod +x" on it, or build it again.` });
    }
    execFile(path, ["engines"], { timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, path, message: `The speech helper at ${path} did not run: ${error.message}` });
      try {
        const engines: string[] = JSON.parse(stdout.trim().split("\n").pop() ?? "{}").engines ?? [];
        resolve({ ok: true, path, message: `Speech helper found. Engines: ${engines.join(", ") || "none listed"}.` });
      } catch {
        resolve({ ok: true, path, message: "Speech helper found." });
      }
    });
  });
}

export async function checkServer(config: DictationConfig): Promise<ServerStatus> {
  try {
    const models = await new LocalFormatter({ ...config.formatter, timeoutSeconds: 5 }).models();
    if (!models.includes(config.formatter.model)) return { ok: false, models, message: modelMissingMessage(config) };
    return { ok: true, models, message: `Model server answered. ${config.formatter.model} is installed.` };
  } catch (error) {
    return { ok: false, models: [], message: explainError(error, config) };
  }
}

export class DictationRuntime {
  private helper?: SpeechHelper;
  private helperPath = "";
  private readonly pipeline: DictationPipeline;
  private readonly options: RuntimeOptions;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.pipeline = new DictationPipeline({
      speech: (config) => this.speech(config),
      formatter: (config) => new LocalFormatter(config.formatter),
    });
  }

  config(): DictationConfig {
    return readConfig(this.options.settings(), this.options.lookup);
  }

  /** Why the chosen helper must not run (it is no longer an executable file), or null. */
  private refusal(config: DictationConfig): string | null {
    return config.helperGranted ? helperPathProblem(config.helperPath) : null;
  }

  private speech(config: DictationConfig) {
    const refused = this.refusal(config);
    if (refused) throw new Error(refused);
    if (!existsSync(config.helperPath)) throw new Error(helperMissingMessage(config.helperPath));
    if (!this.helper || this.helperPath !== config.helperPath) {
      this.helper?.close();
      this.helper = new SpeechHelper(config.helperPath);
      this.helperPath = config.helperPath;
    }
    return this.helper.engine(config.engine, config.whisperModel ? { "whisper-model": config.whisperModel } : {});
  }

  processAudio(request: ProcessAudioRequest, progress: Progress): Promise<TakeResult> {
    return this.pipeline.processAudio(request, this.config(), progress);
  }

  processText(request: FormatTextRequest, progress: Progress, signal?: AbortSignal): Promise<TakeResult> {
    return this.pipeline.processText(request, this.config(), progress, signal);
  }

  /** Load the speech model, then ask Ollama to load the formatting model so the first take is not slow. */
  async prepare(): Promise<PrepareResult> {
    const config = this.config();
    let speechMs: number;
    try {
      speechMs = await this.pipeline.prepare(config);
    } catch (error) {
      throw new Error(explainError(error, config));
    }
    const result: PrepareResult = { engine: config.engine, speechMs };
    try {
      await new LocalFormatter(config.formatter).warm();
    } catch (error) {
      result.modelWarning = explainError(error, config);
    }
    return result;
  }

  async check(): Promise<CheckResult> {
    const config = this.config();
    const refused = this.refusal(config);
    const [helper, server] = await Promise.all([
      refused ? { ok: false, path: config.helperPath, message: refused } : checkHelper(config.helperPath),
      checkServer(config),
    ]);
    return { helper, server };
  }

  status(): { helperPath: string; exists: boolean } {
    const { helperPath } = this.config();
    return { helperPath, exists: existsSync(helperPath) };
  }

  close(): void {
    this.helper?.close();
  }
}
