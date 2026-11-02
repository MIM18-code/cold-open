export type Selection = { start: number; end: number };
export type Cue = "Scene" | "Character" | "Parenthetical" | "Transition";

export function replaceSelection(text: string, selection: Selection, insertion: string) {
  const start = Math.min(selection.start, text.length), end = Math.min(selection.end, text.length);
  return { text: text.slice(0, start) + insertion + text.slice(end),
    selection: { start: start + insertion.length, end: start + insertion.length } };
}

export function insertCue(text: string, selection: Selection, cue: Cue) {
  const before = text.slice(0, selection.start);
  const gap = cue === "Parenthetical" ? (before && !before.endsWith("\n") ? "\n" : "")
    : before ? before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n" : "";
  const template = { Scene: "INT. ", Character: "@", Parenthetical: "()", Transition: "> CUT TO:" }[cue];
  const result = replaceSelection(text, selection, gap + template);
  if (cue === "Parenthetical") result.selection.start = --result.selection.end;
  return result;
}
