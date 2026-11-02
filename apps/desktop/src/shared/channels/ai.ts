// Channels and payloads for the AI service. The renderer never sees an API key: it sends a request, the
// main process picks the provider from settings, adds the key and streams text back with the request ID.

export const AI_CHANNELS = {
  /** renderer → main: start a streamed request. Payload: AiRequest. The reply is AiStartResult; text arrives on `event`. */
  start: "ai:start",
  /** renderer → main: stop a request. Payload: request ID. */
  cancel: "ai:cancel",
  /** main → renderer: AiEvent for a request. */
  event: "ai:event",
  status: "ai:status",
  localSetup: "ai:local-setup",
  startOllama: "ai:start-ollama",
  offerSetup: "ai:offer-setup",
  setKey: "ai:set-key",
  clearKey: "ai:clear-key",
  test: "ai:test",
  models: "ai:models",
  backlot: "ai:backlot",
  productionData: "ai:production-data",
  pickBacklot: "ai:pick-backlot",
  clearBacklot: "ai:clear-backlot",
  chatgptLogin: "ai:chatgpt-login",
  chatgptCancelLogin: "ai:chatgpt-cancel-login",
  chatgptLogout: "ai:chatgpt-logout",
  chatgptSelect: "ai:chatgpt-select",
  chatgptResume: "ai:chatgpt-resume",
} as const;

export const PROVIDERS = ["ollama", "anthropic", "google", "openai", "chatgpt"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: "AI on this Mac (Ollama)",
  anthropic: "Anthropic (Claude)",
  google: "Google (Gemini)",
  openai: "OpenAI (API key)",
  chatgpt: "Sign in with ChatGPT",
};

/** Providers that need an API key from the user. */
export const KEYED_PROVIDERS = ["anthropic", "google", "openai"] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

/** Setting names, shared so both sides agree. All live in settings.json except keys. */
export const AI_SETTINGS = {
  provider: "ai.provider",
  wholeScript: "ai.assistant.wholeScript",
  ollamaEndpoint: "ai.ollama.endpoint",
  model: (provider: ProviderId) => `ai.model.${provider}`,
  proofreadKind: (kind: string) => `ai.proofread.${kind}`,
  /** The project the writer chose in the main process's dialog. Main-owned (grants.*): pages can read it, not set it. */
  backlotPath: "grants.backlotProject",
} as const;

export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

export interface LocalAiSetup {
  installed: boolean;
  running: boolean;
  model: boolean;
}

export type AiStartResult = AiStarted | { error: { code: AiErrorCode; message: string } };

/** What a request is for: "fast" suits proofreading, "smart" suits answers about the script. */
export type AiTier = "fast" | "smart";

export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Continuation data returned by a provider, sent back with this call. */
  signature?: string;
  namespace?: string;
  /** The provider omitted an ID; do not add our local ID to its signed call on replay. */
  generatedId?: true;
}

export interface AiReasoning {
  id: string;
  encryptedContent: string;
  summary: { text: string }[];
}

export interface AiTurn {
  text: string;
  toolCalls?: AiToolCall[];
  reasoning?: AiReasoning[];
  /** Calls past MAX_TOOL_CALLS, dropped before any ran so the model can ask again next turn. */
  skippedCalls?: number;
}

export interface AiMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: AiToolCall[];
  toolCallId?: string;
  name?: string;
  reasoning?: AiReasoning[];
}

export const MAX_TOOL_CALLS = 8;
export const MAX_TOOL_ARGUMENT_CHARS = 32_000;

export const supportsTools = (provider: ProviderId): boolean => PROVIDERS.includes(provider);

/** Whole-script judgment, such as a continuity check, is offered only where it is reliable. In tests on a 77-scene
 * feature, local models of a size most Macs can run read a third of the script and reported problems that weren't there. */
export const WHOLE_SCRIPT_NEEDS = "Needs ChatGPT or an API key";
export const judgesWholeScript = (provider: ProviderId): boolean => provider !== "ollama";

export interface AiRequest {
  /** Chosen by the renderer so it can listen before the request starts. */
  id: string;
  tier: AiTier;
  system: string;
  messages: AiMessage[];
  tools?: AiTool[];
  /** Ask for a JSON object as the whole answer. */
  json?: boolean;
  maxTokens?: number;
  /** Add the summary of the Backlot project (breakdown, cast, schedule) to the system prompt. */
  backlot?: boolean;
  /** Use this provider instead of the one chosen in Settings. Casting picks a signed-in or keyed provider this way. */
  provider?: ProviderId;
}

export interface AiStarted {
  id: string;
  provider: ProviderId;
  model: string;
}

export type AiEvent =
  | { id: string; type: "delta"; text: string }
  | ({ id: string; type: "done" } & AiTurn)
  | { id: string; type: "error"; message: string; code: AiErrorCode };

export type AiErrorCode = "not-configured" | "unauthorized" | "rate-limited" | "plan-limit" | "unreachable" | "bad-response" | "tool-parse" | "cancelled" | "failed";

/** Where ChatGPT shows plan usage. OpenAI's guidelines make it the main action when a plan limit is reached. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/** How every plan-limit error starts, so the renderer can offer Manage usage even when only the message survives IPC. */
export const PLAN_LIMIT_MESSAGE = "Your ChatGPT plan's usage limit was reached";

export interface ProviderStatus {
  provider: ProviderId;
  /** Ready to use: a key is set, a local model is available, or ChatGPT plan usage is granted. */
  ready: boolean;
  /** Keyed providers: whether a key is stored. */
  keySet?: boolean;
  /** Why it is not ready, in plain words. */
  note?: string;
}

export interface ChatgptStatus {
  available: boolean;
  signedIn: boolean;
  plan?: string;
  email?: string;
  planUsageGranted?: boolean;
  paused?: boolean;
  activeProfile?: string;
  profiles?: { id: string; label: string }[];
  /** A browser sign-in is waiting for the user. */
  pending: boolean;
  note?: string;
}

export interface AiStatus {
  /** Whether keys can be stored encrypted on this Mac. */
  encryption: boolean;
  providers: ProviderStatus[];
  chatgpt: ChatgptStatus;
  /** The provider in use. `model` is empty when Settings leaves it on the default. `contextChars` is how much script text a request can carry. */
  active: { provider: ProviderId; model: string; contextChars: number };
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  model?: string;
}

export interface BacklotInfo {
  ok: boolean;
  path?: string;
  title?: string;
  scenes?: number;
  error?: string;
}

export type ProductionData = { ok: true; text: string } | { ok: false; error: string };

/** Ollama reads a name without a tag as `:latest`, so "mistral" and "mistral:latest" are the same model. */
export const sameOllamaModel = (a: string, b: string) => {
  const tagged = (name: string) => (/:[^/]*$/.test(name) ? name : `${name}:latest`).toLowerCase();
  return tagged(a.trim()) === tagged(b.trim());
};
