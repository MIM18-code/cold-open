// What a document template changes outside the page drawing itself: which elements start a page, and how
// Number Scenes numbers a script. Kept free of layout and document imports so pagination and FDX export can
// read it without a cycle.
import type { ElementType } from "./model.ts";

export const TEMPLATE_IDS = ["feature", "oneHourDrama", "halfHourComedy", "multiCamera", "stage"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const TEMPLATE_NAMES: Record<TemplateId, string> = {
  feature: "Feature screenplay",
  oneHourDrama: "One-hour TV drama",
  halfHourComedy: "Half-hour single-camera comedy",
  multiCamera: "Multi-camera sitcom",
  stage: "Stage play",
};

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && (TEMPLATE_IDS as readonly string[]).includes(value);
}

/** One line for the template picker. It says what the app will do, not how to write. */
export const TEMPLATE_NOTES: Record<TemplateId, string> = {
  feature: "Standard US screenplay layout. Number Scenes numbers 1, 2, 3.",
  oneHourDrama: "A teaser and five acts, each act on a new page and closed with END OF ACT. Number Scenes numbers 1, 2, 3.",
  halfHourComedy: "A cold open, three acts and a tag, each on a new page. Number Scenes numbers 1, 2, 3.",
  multiCamera: "A cold open, two acts and a tag. Double-spaced dialogue, capitalized action, underlined entrances and exits. Number Scenes gives them letters: A, B, C.",
  stage: "Centered character names, wide dialogue, indented italic stage directions, and centered act and scene headings.",
};

/** Page breaks the template adds on top of the ones paragraphs carry. */
export const TEMPLATE_BREAKS: Record<TemplateId, readonly ElementType[]> = {
  feature: [],
  oneHourDrama: ["newAct"],
  halfHourComedy: ["newAct"],
  multiCamera: ["newAct", "sceneHeading"],
  stage: ["newAct"],
};

export type SceneNumberStyle = "arabic" | "letters";

export const TEMPLATE_SCENE_NUMBERS: Record<TemplateId, SceneNumberStyle> = {
  feature: "arabic",
  oneHourDrama: "arabic",
  halfHourComedy: "arabic",
  multiCamera: "letters",
  stage: "arabic",
};

/** Elements that start a new page under a template; [] for no template and for the feature layout. */
export function templateBreakBefore(template: unknown): readonly ElementType[] {
  return isTemplateId(template) ? TEMPLATE_BREAKS[template] : [];
}

/** How Number Scenes labels a template's scenes. Scripts without a template number 1, 2, 3. */
export function templateSceneNumbering(template: unknown): SceneNumberStyle {
  return isTemplateId(template) ? TEMPLATE_SCENE_NUMBERS[template] : "arabic";
}

/** A scene label in the multi-camera alphabet: A to Z, then AA, AB, and so on. */
export function sceneLetters(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1, label = "";
  while (value > 0) {
    value--;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

/**
 * Paragraph IDs that FDX export marks StartsNewPage for a template, so Final Draft opens the script with the
 * same act and scene pages. A scene heading directly under a New Act heading stays on that page, as it does in
 * pagination.
 */
export function templatePageBreaks(paragraphs: readonly { id: string; type: ElementType }[], template: unknown): ReadonlySet<string> {
  const breaks = new Set(templateBreakBefore(template));
  if (!breaks.size) return breaks;
  const starts = new Set<string>();
  let previous: ElementType | undefined;
  for (const paragraph of paragraphs) {
    if (paragraph.type === "section" || paragraph.type === "synopsis" || paragraph.type === "note") continue;
    if (breaks.has(paragraph.type) && !(paragraph.type === "sceneHeading" && previous === "newAct")) starts.add(paragraph.id);
    previous = paragraph.type;
  }
  return starts;
}
