// The AI section of Settings: provider, model, keys, the local endpoint, a connection test, the proofreading
// checks, and the Backlot project the assistant reads.
import { FINDING_KINDS, FINDING_KIND_LABELS } from "@screenplay/engine";
import { useCallback, useEffect, useState } from "react";

import {
  AI_CHANNELS, AI_SETTINGS, CHATGPT_USAGE_URL, DEFAULT_OLLAMA_ENDPOINT, KEYED_PROVIDERS, PROVIDERS, PROVIDER_LABELS,
  type AiStatus, type AiTestResult, type BacklotInfo, type KeyedProvider, type ProviderId,
} from "../../../shared/channels/ai.ts";
import { CHANNELS } from "../../../shared/api.ts";
import { useSetting } from "../../core/hooks.ts";
import { COMPLETE_SETTING, type CompleteMode } from "../autocomplete/complete.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import logoBlack from "./brand/chatgpt-logo-black.svg";
import logoWhite from "./brand/chatgpt-logo-white.svg";

function TextSetting({ label, name, placeholder, list, hint }: { label: string; name: string; placeholder?: string; list?: string; hint?: string }) {
  const [value, setValue] = useSetting<string>(name, "");
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) setValue(draft.trim());
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input value={draft} placeholder={placeholder} {...(list ? { list } : {})} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()} />
      {hint ? <small className="ai-settings-hint">{hint}</small> : null}
    </label>
  );
}

function KeyRow({ provider, keySet, encryption, refresh }: { provider: KeyedProvider; keySet: boolean; encryption: boolean; refresh: () => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await desktop.invoke(AI_CHANNELS.setKey, provider, draft);
      setDraft("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  return (
    <div className="field">
      <span>API key {keySet ? <strong className="ai-settings-ok">is set</strong> : "is not set"}</span>
      <div className="ai-settings-row">
        <input type="password" autoComplete="off" value={draft} placeholder={keySet ? "Paste a new key to replace it" : "Paste your key"} aria-label={`${PROVIDER_LABELS[provider]} API key`}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && draft && void save()} />
        <button className="button" disabled={!draft} onClick={() => void save()}>Save</button>
        <button className="button" disabled={!keySet} onClick={async () => (await desktop.invoke(AI_CHANNELS.clearKey, provider), refresh())}>Clear</button>
      </div>
      <small className="ai-settings-hint">
        {encryption ? "Stored encrypted on this Mac. The key is never shown again and never leaves this computer except to reach the provider." : "This Mac can't encrypt keys, so none can be saved."}
      </small>
      {error ? <small className="ai-settings-error">{error}</small> : null}
    </div>
  );
}

function ChatgptRow({ status, refresh }: { status: AiStatus["chatgpt"]; refresh: () => void }) {
  const [error, setError] = useState("");
  const [welcomed, setWelcomed] = useSetting<boolean>("ai.chatgpt.welcomed", false);
  // OpenAI's guidelines: say once, on the first sign-in with plan usage, that eligible requests use the plan.
  useEffect(() => {
    if (!status.signedIn || !status.planUsageGranted || welcomed) return;
    setWelcomed(true);
    // OpenAI's wording for this notice, word for word.
    void messageBox({ type: "info", message: "You’re using your ChatGPT plan",
      detail: "Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.",
      buttons: ["Got it"], defaultId: 0, cancelId: 0 }).catch(() => undefined);
  }, [status.signedIn, status.planUsageGranted, welcomed, setWelcomed]);
  useEffect(() => {
    if (!status.pending) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [status.pending, refresh]);
  const run = async (channel: string, ...args: unknown[]) => {
    try {
      await desktop.invoke(channel, ...args);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  return (
    <div className="field">
      <span>ChatGPT account</span>
      {status.profiles?.length ? <label>Connection
        <select aria-label="ChatGPT connection" value={status.activeProfile ?? ""}
          disabled={status.pending} onChange={(e) => void run(AI_CHANNELS.chatgptSelect, e.target.value)}>
          {!status.activeProfile ? <option value="">Choose a connection</option> : null}
          {status.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
        </select>
      </label> : null}
      <div className="ai-settings-row">
        {status.signedIn ? (
          <>
            <span>Signed in{status.email ? ` as ${status.email}` : ""}{status.plan ? `, ${status.plan} plan` : ""}.</span>
            <button className="button" onClick={() => void run(AI_CHANNELS.chatgptLogout)}>Sign out</button>
          </>
        ) : (
          // OpenAI's approved button: black with the white logo, or white with the black logo in dark mode.
          <button className="siwc-button" data-oai-siwc-button="" disabled={status.pending} onClick={() => void run(AI_CHANNELS.chatgptLogin)}>
            <img className="siwc-logo-on-black" src={logoWhite} alt="" width={18} height={18} />
            <img className="siwc-logo-on-white" src={logoBlack} alt="" width={18} height={18} />
            <span>{status.pending ? "Waiting for your browser" : "Continue with ChatGPT"}</span>
          </button>
        )}
      </div>
      {status.signedIn ? <span>{status.planUsageGranted ? "Using ChatGPT plan" : "ChatGPT plan usage is not enabled"}</span> : null}
      <div className="ai-settings-row">
        {status.signedIn && !status.planUsageGranted ? <button className="button" disabled={status.pending}
          onClick={() => void run(AI_CHANNELS.chatgptLogin, { consent: true })}>Enable ChatGPT plan usage</button> : null}
        {status.profiles?.length || status.signedIn ? <button className="button" disabled={!status.available || status.pending}
          onClick={() => void run(AI_CHANNELS.chatgptLogin, { newProfile: true })}>Add ChatGPT account</button> : null}
        <button className="button" onClick={() => void run(CHANNELS.openExternal, CHATGPT_USAGE_URL)}>Manage usage</button>
        {status.paused ? <button className="button" onClick={() => void run(AI_CHANNELS.chatgptResume)}>Resume ChatGPT requests</button> : null}
        {status.pending ? <button className="button" onClick={() => void run(AI_CHANNELS.chatgptCancelLogin)}>Cancel sign-in</button> : null}
      </div>
      <small className="ai-settings-hint">Cold Open is free and has no plan or charges of its own. With ChatGPT plan usage on, eligible requests use your ChatGPT plan. Casting and sentence completion each ask once before their first use.</small>
      {status.note ? <small className="ai-settings-hint" role="status">{status.note}</small> : null}
      {error ? <small className="ai-settings-error">{error}</small> : null}
    </div>
  );
}

function CompleteSetting() {
  const [mode, setMode] = useSetting<CompleteMode>(COMPLETE_SETTING, "off");
  return (
    <label className="field">
      <span>Suggest the rest of a sentence</span>
      <select aria-label="Sentence completion" value={mode} onChange={(e) => setMode(e.target.value as CompleteMode)}>
        <option value="off">Off</option>
        <option value="shortcut">When I press ⌘Return</option>
        <option value="pause">When I pause while typing</option>
      </select>
      <small className="ai-settings-hint">
        {mode === "off" ? "Nothing is suggested." : "In action and dialogue, the suggestion appears in grey: → adds it, Esc or typing dismisses it. Uses ChatGPT or an API key when one is set up, otherwise the local model."}
      </small>
    </label>
  );
}

function ProofreadToggle({ kind }: { kind: (typeof FINDING_KINDS)[number] }) {
  const [on, set] = useSetting<boolean>(AI_SETTINGS.proofreadKind(kind), true);
  return (
    <label className="ai-settings-check">
      <input type="checkbox" checked={on !== false} onChange={(e) => set(e.target.checked)} /> {FINDING_KIND_LABELS[kind]}
    </label>
  );
}

function BacklotRow() {
  const [info, setInfo] = useState<BacklotInfo>({ ok: false });
  // Set and cleared only through the main process: the assistant sends this project's contents to the provider.
  const [path] = useSetting<string>(AI_SETTINGS.backlotPath, "");
  useEffect(() => void desktop.invoke<BacklotInfo>(AI_CHANNELS.backlot).then(setInfo, () => undefined), [path]);
  return (
    <div className="field">
      <span>Backlot project</span>
      <div className="ai-settings-row">
        <span className="ai-settings-path">{path ? path : "None chosen"}</span>
        <button className="button" onClick={async () => setInfo(await desktop.invoke<BacklotInfo>(AI_CHANNELS.pickBacklot))}>Choose…</button>
        <button className="button" disabled={!path} onClick={() => void desktop.invoke(AI_CHANNELS.clearBacklot)}>Clear</button>
      </div>
      <small className="ai-settings-hint">
        {info.ok ? `${info.title}: ${info.scenes} scenes. The assistant reads it, read-only, to answer questions like which scenes need a stunt coordinator.` : info.error ?? "Choose a project.json from Backlot so the assistant can answer production questions."}
      </small>
    </div>
  );
}

export function AiSettings() {
  const [provider, setProvider] = useSetting<ProviderId>(AI_SETTINGS.provider, "ollama");
  const [wholeScript, setWholeScript] = useSetting<boolean>(AI_SETTINGS.wholeScript, true);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [entries, setEntries] = useState<{ id: string; label: string }[]>([]);
  const [chatgptModel, setChatgptModel] = useSetting<string>(AI_SETTINGS.model("chatgpt"), "");
  const [suggested, setSuggested] = useState<string | undefined>();
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(() => void desktop.invoke<AiStatus>(AI_CHANNELS.status).then(setStatus, () => undefined), []);
  useEffect(refresh, [refresh, provider]);
  const keySet = status?.providers.find((p) => p.provider === provider)?.keySet ?? false;
  useEffect(() => {
    setResult(null);
    setModels([]);
    setEntries([]);
    let current = true;
    const needsKey = (KEYED_PROVIDERS as readonly string[]).includes(provider);
    if ((needsKey && !keySet) || (provider === "chatgpt" && (!status?.chatgpt.planUsageGranted || status.chatgpt.paused))) return;
    void desktop.invoke<{ models: string[]; suggested?: string; entries?: { id: string; label: string }[] }>(AI_CHANNELS.models, provider).then((r) => {
      if (current) { setModels(r.models); setSuggested(r.suggested); setEntries(r.entries ?? []); }
    }, () => undefined);
    return () => { current = false; };
  }, [provider, keySet, status?.chatgpt.signedIn, status?.chatgpt.planUsageGranted, status?.chatgpt.activeProfile, status?.chatgpt.paused]);

  const test = async () => {
    setTesting(true);
    setResult(await desktop.invoke<AiTestResult>(AI_CHANNELS.test, provider).catch((e) => ({ ok: false, message: String(e.message ?? e) })));
    setTesting(false);
  };

  return (
    <div className="ai-settings">
      <label className="field">
        <span>Provider</span>
        <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
          {PROVIDERS.map((id) => <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>)}
        </select>
        <small className="ai-settings-hint">
          {provider === "ollama" ? "Runs on this Mac. Nothing leaves it." : "Text you send, such as a scene or a question, goes to this provider."}
        </small>
      </label>

      {provider === "ollama" ? <TextSetting label="Ollama address" name={AI_SETTINGS.ollamaEndpoint} placeholder={DEFAULT_OLLAMA_ENDPOINT} /> : null}
      {(KEYED_PROVIDERS as readonly string[]).includes(provider) && status
        ? <KeyRow provider={provider as KeyedProvider} keySet={keySet} encryption={status.encryption} refresh={refresh} /> : null}
      {provider === "chatgpt" && status ? <ChatgptRow status={status.chatgpt} refresh={refresh} /> : null}

      <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
      {provider === "chatgpt" ? <label className="field"><span>Model</span>
        <select aria-label="ChatGPT model" value={chatgptModel} onChange={(e) => setChatgptModel(e.target.value)}>
          <option value="">Automatic: first available model</option>
          {chatgptModel && !entries.some((model) => model.id === chatgptModel) ? <option value={chatgptModel}>{chatgptModel} (unavailable)</option> : null}
          {entries.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label> : <TextSetting label="Model" name={AI_SETTINGS.model(provider)} list="ai-models"
        placeholder={provider === "ollama" ? (suggested ? `Automatic: ${suggested}` : "Automatic: the best installed small model") : "Default for this provider"}
        hint={provider === "anthropic" ? "Default: Haiku for proofreading, Sonnet for questions." : undefined} />}

      <div className="ai-settings-row">
        <button className="button" disabled={testing} onClick={() => void test()}>{testing ? "Testing" : "Test connection"}</button>
        {result ? <span className={result.ok ? "ai-settings-ok" : "ai-settings-error"} role="status">{result.message}</span> : null}
      </div>

      <h3 className="ai-settings-heading">Assistant</h3>
      <label className="ai-settings-check"><input type="checkbox" checked={wholeScript} onChange={(e) => setWholeScript(e.target.checked)} />Let the assistant look through the whole script</label>

      <h3 className="ai-settings-heading">Sentence completion</h3>
      <CompleteSetting />

      <h3 className="ai-settings-heading">Proofreading</h3>
      <p className="ai-settings-hint">Checks run as you write and only suggest. Nothing changes until you accept it.</p>
      <div className="ai-settings-checks">{FINDING_KINDS.filter((kind) => kind !== "ai").map((kind) => <ProofreadToggle key={kind} kind={kind} />)}</div>

      <h3 className="ai-settings-heading">Production data</h3>
      <BacklotRow />
    </div>
  );
}
