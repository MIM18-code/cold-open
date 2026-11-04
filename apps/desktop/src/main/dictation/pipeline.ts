// One take, start to finish: WAV bytes to a temp file, the speech helper, then the local model formatter and
// the checks in @screenplay/dictation. Spoken edit commands are pulled out first. The pipeline takes its
// speech engine and formatter as arguments so tests can run it without the helper or a model server.
import { type Formatter, MAX_TRANSCRIPT, type SpeechEngine, type Transcript, formatTake, shortcutErrors } from "@screenplay/dictation";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type FormatTextRequest, type ProcessAudioRequest, type ProgressStage, type ProposedElement, type TakeContext, type TakeResult,
  parentheticalText, toEngineType,
} from "../../shared/channels/dictation.ts";
import { extractEditCommands } from "./commands.ts";
import type { DictationConfig } from "./config.ts";
import { diagnoseTake, explainError } from "./errors.ts";
import { wavInfo } from "./wav-info.ts";

export interface PipelineDeps {
  speech(config: DictationConfig): SpeechEngine;
  formatter(config: DictationConfig): Formatter;
  now?: () => number;
}

export type Progress = (stage: ProgressStage) => void;

/** The context object Writers Block's prompt expects. */
export function modelContext(context: TakeContext): Record<string, unknown> {
  return {
    characters: context.characters,
    locations: context.locations,
    current_heading: context.currentHeading,
    reference_text: context.referenceText,
    previous_elements: context.previousElements,
  };
}

export class DictationPipeline {
  private readonly prepared = new Map<string, Promise<number>>();
  private readonly deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? performance.now.bind(performance))();
  }

  private key(config: DictationConfig): string {
    return [config.helperPath, config.engine, config.whisperModel].join("|");
  }

  /** Load the speech model once per engine and helper; later calls return at once. Resolves to the load time. */
  prepare(config: DictationConfig): Promise<number> {
    const key = this.key(config);
    let pending = this.prepared.get(key);
    if (!pending) {
      const start = this.now();
      pending = this.deps.speech(config).prepare().then(() => this.now() - start);
      this.prepared.set(key, pending);
      pending.catch(() => this.prepared.delete(key));
    }
    return pending;
  }

  private async transcribe(file: string, config: DictationConfig): Promise<Transcript> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.prepare(config);
        return await this.deps.speech(config).transcribe(file);
      } catch (error) {
        // The helper restarted and forgot its engines: load again, once.
        const lost = /Prepare .* first|Speech helper exited/.test((error as Error).message);
        if (!lost || attempt > 0) throw new Error(explainError(error, config));
        this.prepared.delete(this.key(config));
      }
    }
  }

  async processAudio(request: ProcessAudioRequest, config: DictationConfig, progress: Progress = () => {}): Promise<TakeResult> {
    const started = this.now();
    const info = wavInfo(request.audio);
    if (info.seconds < 0.2) throw new Error("The recording is too short.");
    // The recording sits in a private temp folder only while the helper reads it.
    const folder = await mkdtemp(join(tmpdir(), "screenplay-dictation-"));
    let transcript: Transcript;
    const heardAt = { start: 0, end: 0 };
    try {
      const file = join(folder, "take.wav");
      await writeFile(file, request.audio);
      progress("saved");
      progress("transcribing");
      heardAt.start = this.now();
      transcript = await this.transcribe(file, config);
      heardAt.end = this.now();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
    const text = transcript.text.trim();
    if (!text) throw new Error("No speech was found in the recording. Check the microphone and try again.");
    if (request.transcribeOnly) {
      const transcribeMs = heardAt.end - heardAt.start;
      return {
        takeId: request.takeId, source: "audio", transcript: text, engine: transcript.engine, audioSeconds: transcript.audioSeconds,
        elements: [], diagnostics: [], warnings: [], commands: [], timings: { transcribeMs, formatMs: 0, totalMs: this.now() - started },
      };
    }
    const take = await this.formatText(text, request, config, progress);
    return {
      ...take, source: "audio", engine: transcript.engine, audioSeconds: transcript.audioSeconds,
      timings: { ...take.timings, transcribeMs: heardAt.end - heardAt.start, totalMs: this.now() - started },
    };
  }

  async processText(request: FormatTextRequest, config: DictationConfig, progress: Progress = () => {}, signal?: AbortSignal): Promise<TakeResult> {
    signal?.throwIfAborted();
    const started = this.now();
    const text = request.text.trim();
    if (!text) throw new Error("There is no text to format.");
    const take = await this.formatText(text, request, config, progress, signal);
    signal?.throwIfAborted();
    return { ...take, timings: { ...take.timings, totalMs: this.now() - started } };
  }

  private async formatText(
    text: string, request: { takeId: number; context: TakeContext; extractCommands?: boolean }, config: DictationConfig, progress: Progress, signal?: AbortSignal,
  ): Promise<TakeResult> {
    const { commands, rest } = request.extractCommands === false ? { commands: [], rest: text } : extractEditCommands(text);
    const result: TakeResult = {
      takeId: request.takeId, source: "text", transcript: text, elements: [], diagnostics: [], warnings: [], commands,
      timings: { transcribeMs: 0, formatMs: 0, totalMs: 0 },
    };
    if (rest.trim()) {
      progress("formatting");
      const start = this.now();
      try {
        if (rest.length > MAX_TRANSCRIPT) {
          throw new Error(`A take can hold ${MAX_TRANSCRIPT.toLocaleString("en-US")} characters; this one has ${rest.length.toLocaleString("en-US")}. Split it into smaller takes.`);
        }
        const { proposal, diagnostics } = await formatTake(this.deps.formatter(config), rest, modelContext(request.context),
          { cast: request.context.characters, introduced: request.context.introduced, signal });
        result.autoApplyErrors = [...new Set(shortcutErrors(proposal, rest))];
        result.elements = proposal.elements.map((element): ProposedElement => ({
          type: toEngineType(element.type),
          text: element.type === "parenthetical" ? parentheticalText(element.text) : element.text,
          uncertainty: element.uncertainty,
        }));
        result.warnings = proposal.warnings;
        result.diagnostics = diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, elementIndex: d.element_index }));
      } catch (error) {
        Object.assign(result, diagnoseTake(error, config));
      }
      result.timings.formatMs = this.now() - start;
    }
    progress("done");
    return result;
  }
}
