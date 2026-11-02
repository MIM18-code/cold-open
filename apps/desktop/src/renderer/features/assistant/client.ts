// The renderer's side of "ai:start": send a request, get text as it streams, cancel. The provider and the key
// are the main process's business; this only knows the request ID.
import { CHANNELS } from "../../../shared/api.ts";
import { AI_CHANNELS, CHATGPT_USAGE_URL, PLAN_LIMIT_MESSAGE, type AiErrorCode, type AiEvent, type AiRequest, type AiStarted } from "../../../shared/channels/ai.ts";
import { desktop, messageBox } from "../../core/platform.ts";

export class AiClientError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.code = code;
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

export function runAi(request: Omit<AiRequest, "id">, onDelta?: (text: string) => void): AiRun {
  const id = `ai-${Date.now().toString(36)}-${++counter}`;
  let off: () => void = () => undefined;
  let cancelled = false;
  const done = new Promise<string>((resolve, reject) => {
    off = desktop.on(AI_CHANNELS.event, (raw) => {
      const event = raw as AiEvent;
      if (event.id !== id) return;
      if (event.type === "delta") onDelta?.(event.text);
      else if (event.type === "done") (off(), resolve(event.text));
      else (off(), planLimit(event.code, event.message), reject(new AiClientError(event.code, event.message)));
    });
  });
  done.catch(() => undefined);
  const started = desktop.invoke<AiStarted>(AI_CHANNELS.start, { ...request, id });
  // A request that never starts has no events coming, so its failure ends the run.
  const result = started.then(() => done, (error) => {
    off();
    planLimit(undefined, error instanceof Error ? error.message : String(error));
    throw new AiClientError(cancelled ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
  });
  result.catch(() => undefined);
  started.catch(() => undefined);
  return {
    id, started, done: result,
    cancel() {
      cancelled = true;
      void desktop.invoke(AI_CHANNELS.cancel, id).catch(() => undefined);
    },
  };
}
