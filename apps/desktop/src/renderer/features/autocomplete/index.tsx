// Optional sentence completion. Off until the writer turns it on in Settings > AI. When on, ⌘Return (or a pause in
// typing, if chosen) asks the background provider to finish the sentence at the caret; the answer shows in grey and
// → accepts it. Nothing reaches the script unless the writer accepts it.
import { plainText, type Paragraph } from "@screenplay/engine";
import { AI_CHANNELS, type AiStatus, type ProviderId } from "../../../shared/channels/ai.ts";
import { app, type Feature } from "../../core/app.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import { AiClientError, runAi, type AiRun } from "../assistant/client.ts";
import { preferredProvider, providerName } from "../assistant/provider.ts";
import { COMPLETE_SETTING, COMPLETE_TYPES, answerSentence, completionFrom, completionRequest, visibleBefore, visibleText, type CompleteMode } from "./complete.ts";

const CLOUD_SETTING = "ai.complete.cloudApproved";
const PAUSE_MS = 1200;
let run: AiRun | undefined, token = 0, timer: ReturnType<typeof setTimeout> | undefined;
// Local typing, as opposed to a co-writer's edit arriving over the network: only typing starts a pause completion.
let typedAt = 0;
let announcer: HTMLElement | undefined;

const mode = () => app.setting<CompleteMode>(COMPLETE_SETTING, "off");

function stop(): void {
  token++;
  run?.cancel(); run = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

/** The scene up to the paragraph, and who is speaking when it is dialogue. */
function context(paragraphs: readonly Paragraph[], index: number): { before: Paragraph[]; speaker?: string } {
  let start = index;
  while (start > 0 && paragraphs[start]!.type !== "sceneHeading") start--;
  const before = paragraphs.slice(start, index).filter((p) => p.type !== "note" && p.type !== "synopsis" && p.type !== "section");
  let speaker: string | undefined;
  for (let i = index - 1; i >= start && paragraphs[i]!.type !== "action"; i--) {
    if (paragraphs[i]!.type === "character") { speaker = visibleText(paragraphs[i]!.runs).replace(/\s*\(.*\)\s*$/, "").trim(); break; }
  }
  return { before, ...(speaker ? { speaker } : {}) };
}

async function cloudApproved(provider: ProviderId): Promise<boolean> {
  if (provider === "ollama") return true;
  const approved = app.setting<string[]>(CLOUD_SETTING, []);
  if (approved.includes(provider)) return true;
  const name = providerName(provider);
  const answer = await messageBox({ type: "question", message: `Complete sentences with ${name}?`,
    detail: `The scene up to the caret, about a page at most, goes to ${name} each time you ask for a completion. Script notes stay out. You won't be asked again for ${name}.`,
    buttons: [`Use ${name}`, "Cancel"], defaultId: 0, cancelId: 1 });
  if (answer !== 0) return false;
  app.setSetting(CLOUD_SETTING, [...approved, provider]);
  return true;
}

async function complete(auto: boolean): Promise<void> {
  const editor = app.editor, session = app.session;
  if (!editor || session.readOnly || mode() === "off") return;
  const selection = editor.getSelection();
  if (!selection || selection.anchor.paragraphId !== selection.head.paragraphId || selection.anchor.offset !== selection.head.offset) return;
  const paragraphs = session.script().paragraphs;
  const index = paragraphs.findIndex((p) => p.id === selection.head.paragraphId);
  const paragraph = paragraphs[index];
  if (!paragraph || !COMPLETE_TYPES.includes(paragraph.type)) {
    if (!auto) app.toast("Sentence completion works in action and dialogue.");
    return;
  }
  const text = plainText(paragraph.runs), offset = selection.head.offset, prefix = visibleBefore(paragraph.runs, offset);
  // A pause only completes at the end of a line with something on it; the shortcut works anywhere.
  if (auto && (offset !== text.length || prefix.trim().length < 12)) return;
  stop();
  const mine = token, at = { paragraphId: paragraph.id, offset };
  const current = () => mine === token && app.editor === editor && app.session === session && mode() !== "off";
  const status = await desktop.invoke<AiStatus>(AI_CHANNELS.status).catch(() => null);
  if (!status || !current()) return;
  const provider = preferredProvider(status);
  if (!(await cloudApproved(provider)) || !current()) return;
  if (!auto) editor.setGhostText({ ...at, text: "", pending: true, onDismiss: stop });
  const request = completionRequest({ ...context(paragraphs, index), type: paragraph.type, prefix });
  run = runAi({ provider, tier: "fast", json: true, maxTokens: 120, system: request.system, messages: request.messages });
  try {
    const answer = await run.done;
    if (!current()) return;
    const suggestion = completionFrom(prefix, request.fragment, answerSentence(answer));
    if (!suggestion) {
      editor.setGhostText(null);
      if (!auto) app.toast("No completion for this sentence.");
      return;
    }
    editor.setGhostText({ ...at, text: suggestion, onDismiss: stop });
    // The grey text is hidden from screen readers inside the script; this says what it is and how to take it.
    const said = suggestion.trim();
    if (announcer) announcer.textContent = `Suggestion: ${said}${/[.!?…]$/.test(said) ? "" : "."} Right Arrow adds it, Escape dismisses it.`;
  } catch (error) {
    if (!current()) return;
    editor.setGhostText(null);
    if (!auto && !(error instanceof AiClientError && error.code === "cancelled")) app.toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (mine === token) run = undefined;
  }
}

const feature: Feature = {
  id: "autocomplete",
  commands: [{
    id: "ai.completeSentence", label: "Complete Sentence", menu: "Edit", group: "ai", accelerator: "CmdOrCtrl+Enter",
    enabled: () => mode() !== "off" && !!app.editor && !app.session.readOnly,
    run: () => complete(false),
  }],
  activate(a) {
    let editor: EditorBridge | null = null, offSelection: (() => void) | undefined, last = { id: "", offset: -1, text: "" };
    let lastMode = mode();
    announcer = document.createElement("div");
    announcer.className = "visually-hidden";
    announcer.setAttribute("aria-live", "polite");
    document.body.append(announcer);
    // Typing in the script itself, not in a sidebar field while a co-writer's edit lands on the caret's line.
    const input = (event: Event) => { if (event.target instanceof Element && event.target.closest(".editor-pm")) typedAt = Date.now(); };
    document.addEventListener("beforeinput", input, true);
    const watch = () => {
      // Turning completion off ends any request and suggestion at once.
      if (mode() !== lastMode) { lastMode = mode(); stop(); a.editor?.setGhostText(null); }
      if (editor === a.editor) return;
      offSelection?.(); stop();
      editor = a.editor;
      offSelection = editor?.onSelectionChange((selection) => {
        const id = selection?.head.paragraphId ?? "", offset = selection?.head.offset ?? -1;
        const paragraph = id && a.session.doc.has(id) ? a.session.doc.paragraph(id) : null;
        const text = paragraph ? plainText(paragraph.runs) : "";
        // The editor can report one keystroke more than once; only a real change of caret or text counts.
        if (id === last.id && offset === last.offset && text === last.text) return;
        // Only typing in the same line counts as writing: clicking into a line, or moving to another, does not.
        const typed = id === last.id && text !== last.text && Date.now() - typedAt < 500;
        last = { id, offset, text };
        stop();
        if (mode() === "pause" && typed) timer = setTimeout(() => void complete(true), PAUSE_MS);
      });
    };
    watch();
    const offApp = a.subscribe(watch);
    const offSession = a.onSession(stop);
    return () => { offApp(); offSession(); offSelection?.(); stop(); document.removeEventListener("beforeinput", input, true); announcer?.remove(); };
  },
};
export default feature;
