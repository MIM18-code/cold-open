import { compileReadPlan, type ReadCue, type ReadOptions, type Script } from "@screenplay/engine";

export type ListeningMode = "full" | "dialogue" | "range" | "rehearsal" | "compare";
export interface ReadLocation { paragraphId: string; offset: number; }
export function modeOptions(options: ReadOptions, mode: ListeningMode): ReadOptions {
  return mode === "dialogue" ? { action: false, headings: false, parentheticals: false, names: false } : options;
}
export function resumeIndex(cues: ReadCue[], location: ReadLocation): number {
  return cues.findIndex((cue) => cue.source?.some((span) => span.paragraphId === location.paragraphId
    && span.from <= location.offset && span.to > location.offset));
}
export function readRevision(cues: ReadCue[]): string {
  const text = JSON.stringify(cues);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export function estimatedDuration(cues: ReadCue[], speed: number, gapMs: number): number {
  return cues.reduce((seconds, cue) => seconds + cue.text.split(/\s+/).filter(Boolean).length / 2.5 / speed, 0)
    + Math.max(0, cues.length - 1) * gapMs / 1000;
}
/** Compile an isolated alternate paragraph with the original speaker context. */
export function compareTake(source: Script, paragraphId: string, text: string, options: ReadOptions): ReadCue[] {
  const index = source.paragraphs.findIndex((p) => p.id === paragraphId);
  if (index < 0 || !["dialogue", "lyrics"].includes(source.paragraphs[index]!.type)) {
    throw new Error("Choose an alternative attached to a dialogue line.");
  }
  const original = compileReadPlan(source, options).find((cue) => cue.paragraphIds.includes(paragraphId));
  if (!original) throw new Error("This line is outside the readable script.");
  // Compile just this speech so earlier paragraphs never become part of the alternate.
  return compileReadPlan({ titlePage: [], paragraphs: [
    { id: "compare-speaker", type: "character", runs: [{ text: original.speaker }] },
    { ...source.paragraphs[index]!, runs: [{ text }], dual: undefined },
  ] }, { ...options, names: false }).map((cue) => ({ ...cue, sceneId: original.sceneId,
    sceneHeading: original.sceneHeading, speaker: original.speaker, source: original.source.filter((span) => span.paragraphId === paragraphId),
    id: `${paragraphId}:alternate:${cue.id}` }));
}

export function restrictPassages(cues: ReadCue[], ids: Set<string>, source: Script): ReadCue[] {
  return cues.flatMap((cue) => {
    const spans = cue.source.filter((span) => ids.has(span.paragraphId));
    if (!spans.length) return [];
    if (spans.length === cue.source.length) return [cue];
    const paragraphs = [...new Set(spans.map((span) => span.paragraphId))];
    const text = paragraphs.map((id) => {
      const paragraph = source.paragraphs.find((p) => p.id === id)!;
      const raw = paragraph.runs.map((run) => run.text).join("");
      return spans.filter((span) => span.paragraphId === id).map((span) => raw.slice(span.from, span.to)).join("");
    }).join(" ");
    return [{ ...cue, id: `${paragraphs[0]}:range:${cue.id}`, text, source: spans, paragraphIds: paragraphs }];
  });
}

export function captureRead(cues: ReadCue[], voices: Record<string, string>) {
  return { cues: structuredClone(cues), voices: { ...voices }, sourceRevision: readRevision(cues) };
}
