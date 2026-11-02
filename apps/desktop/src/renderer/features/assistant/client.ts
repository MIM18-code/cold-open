// The renderer's side of "ai:start": stream, cancel, and route setup failures to the shared sheet.
import { CHANNELS } from "../../../shared/api.ts";
import { AI_CHANNELS, CHATGPT_USAGE_URL, PLAN_LIMIT_MESSAGE, type AiErrorCode, type AiEvent, type AiRequest, type AiStarted, type AiStartResult, type AiStatus, type AiTurn } from "../../../shared/channels/ai.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import { offerAiSetup } from "./setup.ts";
import { AI_SETUP_MESSAGE } from "./setup-state.ts";

export class AiClientError extends Error {
  readonly code: AiErrorCode;
  readonly setupRequired: boolean;
  constructor(code: AiErrorCode, message: string, setupRequired = false) {
    super(message);
    this.code = code;
    this.setupRequired = setupRequired;
  }
}

export interface AiRun {
  id: string;
  /** Resolves with the provider and model once the request is under way. */
  started: Promise<AiStarted>;
  /** Resolves with the whole answer. Rejects with AiClientError, code "cancelled" after cancel(). */
  done: Promise<string>;
  cancel(): void;
}

let counter = 0;
let planLimitShown = 0;

/** A plan limit, from any feature: OpenAI's guidelines put Manage usage first. Shown at most once a minute. */
function planLimit(code: AiErrorCode | undefined, message: string): void {
  if (code !== "plan-limit" && !message.includes(PLAN_LIMIT_MESSAGE)) return;
  if (Date.now() - planLimitShown < 60_000) return;
  planLimitShown = Date.now();
  void messageBox({ type: "warning", message: PLAN_LIMIT_MESSAGE,
    detail: "Review your plan or this app's limit in ChatGPT settings. Cold Open paused ChatGPT requests; resume them in Settings > AI.",
    buttons: ["Manage usage", "Close"], defaultId: 0, cancelId: 1 })
    .then((answer) => { if (answer === 0) void desktop.invoke(CHANNELS.openExternal, CHATGPT_USAGE_URL); }, () => undefined);
}

export interface AiTurnRun {
  id: string;
  started: Promise<AiStarted>;
  done: Promise<AiTurn>;
  cancel(): void;
}

export function runAi(request: Omit<AiRequest, "id">, onDelta?: (text: string) => void, options: { quiet?: boolean } = {}): AiRun {
  const run = runAiTurn(request, onDelta, options);
  const done = run.done.then((turn) => turn.text);
  done.catch(() => undefined);
  return { ...run, done };
}

export function runAiTurn(request: Omit<AiRequest, "id">, onDelta?: (text: string) => void, options: { quiet?: boolean } = {}): AiTurnRun {
  const id = `ai-${Date.now().toString(36)}-${++counter}`;
  let off: () => void = () => undefined;
  let cancelled = false;
  let status: AiStatus | undefined;
  const failure = (code: AiErrorCode, message: string): AiClientError => {
    // The sheet sets up ChatGPT or the local model; a cloud provider missing its key keeps its own message.
    const local = (request.provider ?? status?.active.provider) === "ollama";
    const setup = code !== "cancelled" && local && (code === "unreachable" || code === "not-configured");
    if (setup && !options.quiet && !cancelled) offerAiSetup();
    return new AiClientError(code, setup ? AI_SETUP_MESSAGE : message, setup);
  };
  let rejectDone!: (error: AiClientError) => void;
  const done = new Promise<AiTurn>((resolve, reject) => {
    rejectDone = reject;
    off = desktop.on(AI_CHANNELS.event, (raw) => {
      const event = raw as AiEvent;
      if (event.id !== id) return;
      if (event.type === "delta") onDelta?.(event.text);
      else if (event.type === "done") {
        off();
        resolve({ text: event.text, ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}), ...(event.reasoning ? { reasoning: event.reasoning } : {}),
          ...(event.skippedCalls ? { skippedCalls: event.skippedCalls } : {}) });
      } else {
        off();
        planLimit(event.code, event.message);
        reject(failure(event.code, event.message));
      }
    });
  });
  done.catch(() => undefined);
  const started = (async () => {
    status = await desktop.invoke<AiStatus>(AI_CHANNELS.status);
    if (cancelled) throw new AiClientError("cancelled", "Cancelled.");
    if ((request.provider ?? status.active.provider) === "ollama" && !status.providers.some((p) => p.provider === "ollama" && p.ready))
      throw failure("not-configured", AI_SETUP_MESSAGE);
    const result = await desktop.invoke<AiStartResult>(AI_CHANNELS.start, { ...request, id });
    if ("error" in result) throw failure(result.error.code, result.error.message);
    return result;
  })();
  void started.then(() => {
    // Cancel can precede model discovery in main; cancel again once its request is registered.
    if (cancelled) void desktop.invoke(AI_CHANNELS.cancel, id).catch(() => undefined);
  }, (error) => {
    off();
    planLimit(undefined, error instanceof Error ? error.message : String(error));
    rejectDone(error instanceof AiClientError ? error : new AiClientError(cancelled ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)));
  });
  return {
    id, started, done,
    cancel() {
      cancelled = true;
      off();
      rejectDone(new AiClientError("cancelled", "Cancelled."));
      void desktop.invoke(AI_CHANNELS.cancel, id).catch(() => undefined);
    },
  };
}
