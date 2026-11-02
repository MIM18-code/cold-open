// The assistant conversation: messages, the running request, and sending. One conversation per open document;
// it is cleared when another document replaces this one. Kept outside React so it survives the panel closing.
import { AI_CHANNELS, AI_SETTINGS, type AiMessage, type AiStatus } from "../../../shared/channels/ai.ts";
import type { App } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { AiClientError, runAi, type AiRun } from "./client.ts";
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
    this.run?.cancel();
    this.run = null;
    this.messages = [];
    this.busy = false;
    this.emit();
  }

  stop(): void {
    this.run?.cancel();
  }

  /** The label of the scene holding the caret, for quick actions. */
  currentScene(): string {
    const script = this.app.session.script();
    const context = buildScriptContext(script, this.app.editor?.currentParagraphId() ?? null, 1e9);
    return context.current ?? "the current scene";
  }

  quick(kind: keyof typeof QUICK_ACTIONS, options: SendOptions = {}): Promise<void> {
    const scene = this.currentScene();
    return this.send(kind === "continuity" ? QUICK_ACTIONS.continuity() : QUICK_ACTIONS[kind](scene), options);
  }

  async send(text: string, options: SendOptions = {}): Promise<void> {
    const question = text.trim();
    if (!question || this.busy) return;
    const generation = this.generation;
    const history: AiMessage[] = this.messages.filter((m) => !m.error && m.text).map((m) => ({ role: m.role, content: m.text }));
    this.messages = [...this.messages, { id: this.nextId++, role: "user", text: question }];
    const reply: ChatMessage = { id: this.nextId++, role: "assistant", text: "", streaming: true };
    this.messages = [...this.messages, reply];
    this.busy = true;
    this.emit();
    const update = (change: Partial<ChatMessage>) => {
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
      const system = assistantSystem({ context, ...(selection ? { selection } : {}) });
      this.run = runAi({ tier: "smart", system, messages: [...history, { role: "user", content: question }], maxTokens: 2000, backlot: useBacklot },
        (delta) => update({ text: reply.text + delta }));
      const started = await this.run.started;
      const used = [`${started.model}`, context.truncated ? `${context.included} of ${context.total} scenes sent` : "whole script sent", ...(useBacklot ? ["Backlot data"] : [])];
      update({ note: used.join(" · ") });
      const answer = await this.run.done;
      update({ text: answer, streaming: false });
    } catch (error) {
      const cancelled = error instanceof AiClientError && error.code === "cancelled";
      update({ streaming: false, ...(cancelled ? { note: "Stopped" } : { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      if (generation === this.generation) {
        this.run = null;
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
