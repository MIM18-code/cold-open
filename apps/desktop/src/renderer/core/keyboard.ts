const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
/** Editing in Find, an assistant prompt or a card must never reformat the screenplay. */
export function inOtherTextField(): boolean {
  if (typeof document === "undefined") return false;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused.closest(".editor-pm")) return false;
  if (focused instanceof HTMLInputElement) return TEXT_INPUTS.has(focused.type);
  return focused instanceof HTMLTextAreaElement || focused.isContentEditable;
}
