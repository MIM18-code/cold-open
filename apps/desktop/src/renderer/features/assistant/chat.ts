// The assistant conversation: messages, the running request, and sending. One conversation per open document;
// it is cleared when another document replaces this one. Kept outside React so it survives the panel closing.
import { AI_CHANNELS, AI_SETTINGS, type AiMessage, type AiStatus, judgesWholeScript, type ProductionData, supportsTools } from "../../../shared/channels/ai.ts";
import type { App } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { AiClientError, runAi, type AiRun } from "./client.ts";
import { readStoredCast } from "../table-read/cast-store.ts";
import { FALLBACK_NOTE, runAgent } from "./agent.ts";
import type { Suggestion } from "./suggestions.ts";
import { QUICK_ACTIONS, assistantSystem, buildScriptContext, selectedText } from "./context.ts";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** The answer is still arriving. */
  streaming?: boolean;
  error?: string;
  /** What the answer was based on, shown under it. */
  note?: string;
  steps?: string[];
  proposals?: Suggestion[];
  toolAnswer?: boolean;
}

export interface SendOptions {
  backlot?: boolean;
  selection?: boolean;
}

export class Chat {
  messages: ChatMessage[] = [];
  busy = false;
  version = 0;
  private run: AiRun | null = null;
  private controller: AbortController | null = null;
  /** Bumped when the conversation is cleared, so an answer still on its way for the old one is dropped. */
  private generation = 0;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
    app.onSession(() => this.clear());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.run?.cancel();
    this.run = null;
    this.messages = [];
    this.busy = false;
    this.emit();
  }

  stop(): void {
    this.controller?.abort();
    this.run?.cancel();
  }

  /** The label of the scene holding the caret, for quick actions. */
  currentScene(): string {
    const script = this.app.session.script();
    const context = buildScriptContext(script, this.app.editor?.currentParagraphId() ?? null, 1e9);
    return context.current ?? "the current scene";
  }

  async quick(kind: keyof typeof QUICK_ACTIONS, options: SendOptions = {}): Promise<void> {
    if (kind === "continuity" && !this.busy) {
      const generation = this.generation;
      const status = await desktop.invoke<AiStatus>(AI_CHANNELS.status).catch(() => null);
      // A document switch while status was loading clears the chat; the action belonged to the old one.
      if (generation !== this.generation) return;
      if (status && !judgesWholeScript(status.active.provider)) {
        this.messages = [...this.messages, { id: this.nextId++, role: "assistant", text: "",
          error: "Checking continuity across the script needs ChatGPT or an API key. Choose one in Settings, AI." }];
        this.emit();
        return;
      }
    }
    const scene = this.currentScene();
    return this.send(kind === "continuity" ? QUICK_ACTIONS.continuity() : QUICK_ACTIONS[kind](scene), options);
  }

  async send(text: string, options: SendOptions = {}): Promise<void> {
    const question = text.trim();
    if (!question || this.busy) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const history: AiMessage[] = this.messages.filter((m) => !m.error && m.text).map((m) => ({ role: m.role, content: m.text }));
    this.messages = [...this.messages, { id: this.nextId++, role: "user", text: question }];
    const reply: ChatMessage = { id: this.nextId++, role: "assistant", text: "", streaming: true };
    this.messages = [...this.messages, reply];
    this.busy = true;
    this.emit();
    const update = (change: Partial<ChatMessage>) => {
      if (generation !== this.generation) return;
      Object.assign(reply, change);
      this.messages = [...this.messages];
      this.emit();
    };
    try {
      const status = await desktop.invoke<AiStatus>(AI_CHANNELS.status);
      if (generation !== this.generation) return;
      const script = this.app.session.script();
      const context = buildScriptContext(script, this.app.editor?.currentParagraphId() ?? null, status.active.contextChars);
      const selection = options.selection ? selectionOf(this.app) : "";
      const useBacklot = !!options.backlot && !!this.app.setting<string>(AI_SETTINGS.backlotPath, "");
      if (controller.signal.aborted) throw new AiClientError("cancelled", "Cancelled.");
      const messages: AiMessage[] = [...history, { role: "user", content: question }];
      const fallback = { tier: "smart" as const, provider: status.active.provider,
        system: assistantSystem({ context, ...(selection ? { selection } : {}) }), messages, maxTokens: 2000, backlot: useBacklot };
      const contextNote = context.truncated ? `${context.included} of ${context.total} scenes sent, nearest the caret` : "whole script sent";
      let model = "";
      if (this.app.setting<boolean>(AI_SETTINGS.wholeScript, true) && supportsTools(status.active.provider)) {
        update({ steps: [], proposals: [], toolAnswer: true });
        const answer = await runAgent({
          request: { ...fallback, system: assistantSystem({ context, selection, agent: true }), backlot: false },
          fallback, signal: controller.signal,
          resultBudget: Math.min(120_000, Math.max(4000, status.active.contextChars - 12_000)),
          context: {
            script: () => this.app.session.script(),
            identities: () => readStoredCast(this.app.session.doc).characters.map((character) => ({
              id: character.id, displayName: character.name, aliases: character.aliases, cueIds: character.cueIds?.length ? character.cueIds : [character.id],
            })),
            ...(useBacklot ? { productionData: () => desktop.invoke<ProductionData>(AI_CHANNELS.productionData) } : {}),
          },
          onStep: (line) => update({ steps: [...reply.steps ?? [], line] }),
          onProposal: (proposal) => update({ proposals: [...reply.proposals ?? [], proposal] }),
          onStarted: (started) => { model = started.model; update({ note: `${model} · Script lookup` }); },
          onDelta: (delta) => update({ text: reply.text + delta }),
        });
        update({ text: answer.text, streaming: false, proposals: answer.proposals,
          toolAnswer: answer.note !== FALLBACK_NOTE,
          note: [model, ...(answer.note ? [answer.note] : ["Script lookup"]), ...(answer.coverage ? [answer.coverage] : []),
            ...(answer.note === FALLBACK_NOTE ? [contextNote, ...(useBacklot ? ["Backlot data"] : [])] : [])].filter(Boolean).join(" · ") });
      } else {
        this.run = runAi(fallback, (delta) => update({ text: reply.text + delta }));
        const active = this.run;
        void active.started.then((started) => {
          if (!controller.signal.aborted) update({ note: [started.model, contextNote, ...(useBacklot ? ["Backlot data"] : [])].join(" · ") });
        }, () => undefined);
        const answer = await active.done;
        if (controller.signal.aborted) throw new AiClientError("cancelled", "Cancelled.");
        update({ text: answer, streaming: false });
      }
    } catch (error) {
      const cancelled = error instanceof AiClientError && error.code === "cancelled";
      update({ streaming: false, ...(cancelled ? { note: "Stopped" } : { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      if (generation === this.generation) {
        this.run = null;
        this.controller = null;
        this.busy = false;
        this.emit();
      }
    }
  }
}

function selectionOf(app: App): string {
  const selection = app.editor?.getSelection();
  if (!selection) return "";
  return selectedText(app.session.script(), selection.anchor, selection.head);
}
