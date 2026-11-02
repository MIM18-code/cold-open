import { NON_PRINTING, type Paragraph } from "./model.ts";

export interface Speech {
  cue: Paragraph;
  paragraphs: Paragraph[];
}

/** A cue owns dialogue and parentheticals until the next printed element outside that speech. Includes private notes. */
export function speechesOf(paragraphs: readonly Paragraph[]): Speech[] {
  const speeches: Speech[] = [];
  let speech: Speech | undefined;
  for (const paragraph of paragraphs) {
    if (paragraph.type === "character") {
      speech = { cue: paragraph, paragraphs: [paragraph] };
      speeches.push(speech);
    } else if (paragraph.type === "dialogue" || paragraph.type === "lyrics" || paragraph.type === "parenthetical" || NON_PRINTING.has(paragraph.type)) {
      speech?.paragraphs.push(paragraph);
    } else speech = undefined;
  }
  return speeches;
}
