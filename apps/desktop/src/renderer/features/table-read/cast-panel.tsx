import { useMemo } from "react";
import type { AliasSuggestion, CastBinding } from "@screenplay/engine";
import type { ReadEngine, ReadVoice } from "../../../shared/channels/table-read.ts";
import { aliasKey } from "./cast-store.ts";
import { auditionChoices, voiceInfos, type CastSubject } from "./cast-ensemble.ts";

export interface CastRowProps {
  binding: CastBinding;
  engine: ReadEngine;
  voices: readonly ReadVoice[];
  narratorVoice: string;
  subjects: readonly CastSubject[];
  current: Readonly<Record<string, string>>;
  shared: boolean;
  disabled: boolean;
  canAudition: boolean;
  designDisabled?: boolean;
  designInstalled?: boolean;
  onDesign?(): void;
  onVoice(voice: string): void;
  onLock(locked: boolean): void;
  onRecast(): void;
  onAudition(voice: string): void;
}

/** One speaking character: current voice, lock, a one-role recast and three auditions of their own line. */
export function CastRow({ binding, engine, voices, narratorVoice, subjects, current, shared, disabled, canAudition, onVoice, onLock, onRecast, onAudition, onDesign, designDisabled, designInstalled }: CastRowProps) {
  const choices = useMemo(
    () => auditionChoices({ subjects, voices: voiceInfos(voices, engine), narratorVoice, current }, binding.id),
    [subjects, voices, engine, narratorVoice, current, binding.id],
  );
  const name = binding.name, voice = binding.voices[engine] ?? "";
  return <div className="reader-cast-row">
    <div><strong>{name}</strong>{shared && <small>Shared voice</small>}</div>
    <select aria-label={`Voice for ${name}`} value={voice} disabled={disabled} onChange={(e) => onVoice(e.target.value)}>
      <option value="">Choose voice</option>
      {voices.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.language}</option>)}
    </select>
    <button className="icon-button" aria-label={`Audition ${name}`} disabled={!canAudition || !voice} onClick={() => onAudition(voice)}>▶</button>
    <button className="button" aria-label={`Recast ${name}`} disabled={disabled} onClick={onRecast}>Recast</button>
    <label className="reader-lock"><input type="checkbox" aria-label={`Lock ${name}`} checked={binding.locked} disabled={disabled} onChange={(e) => onLock(e.target.checked)}/>Lock</label>
    {onDesign && <button className="button reader-design" aria-label={`${designInstalled ? "Design a voice" : "Install VoiceDesign"} for ${name}`} disabled={designDisabled} onClick={onDesign}>{designInstalled ? "Design a voice…" : "Install VoiceDesign…"}</button>}
    {choices.length > 0 && <details className="reader-auditions"><summary>Audition {choices.length} voice{choices.length === 1 ? "" : "s"}</summary>
      <ol>{choices.map((option, index) => <li key={option.id}>
        <span>{index + 1}. {option.name}</span>
        <button className="icon-button" aria-label={`Audition ${name} option ${index + 1}`} disabled={!canAudition} onClick={() => onAudition(option.id)}>▶</button>
        <button className="button" aria-label={`Use ${option.name} for ${name}`} disabled={disabled} onClick={() => onVoice(option.id)}>Use</button>
      </li>)}</ol>
    </details>}
  </div>;
}

export interface AliasListProps {
  suggestions: readonly AliasSuggestion[];
  names: Readonly<Record<string, string>>;
  ignored: readonly string[];
  disabled: boolean;
  onMerge(suggestion: AliasSuggestion): void;
  onDifferent(suggestion: AliasSuggestion): void;
}

const suggestionKey = (suggestion: AliasSuggestion) => aliasKey(suggestion.characterId, suggestion.name);

/** Name-pair suggestions. The writer confirms each one; nothing is merged until they do. */
export function AliasList({ suggestions, names, ignored, disabled, onMerge, onDifferent }: AliasListProps) {
  const open = suggestions.filter((suggestion) => !ignored.includes(suggestionKey(suggestion)));
  if (!open.length) return null;
  return <div className="reader-aliases" role="group" aria-label="Possible character aliases">
    {open.map((suggestion) => <div key={suggestionKey(suggestion)}>
      <span>{suggestion.name} might be {names[suggestion.characterId] ?? "another character"}. {suggestion.reason}</span>
      <button className="button" disabled={disabled} onClick={() => onMerge(suggestion)}>Same person</button>
      <button className="button" disabled={disabled} onClick={() => onDifferent(suggestion)}>Different</button>
    </div>)}
  </div>;
}
