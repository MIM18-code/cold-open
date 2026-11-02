import { useCallback, useEffect, useRef, useState } from "react";
import { AI_CHANNELS, AI_SETTINGS, sameOllamaModel, type AiStatus, type LocalAiSetup } from "../../../shared/channels/ai.ts";
import { CHANNELS } from "../../../shared/api.ts";
import type { ModelProgress } from "../../../main/models/ollama.ts";
import { app, type ModalProps } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { ChatgptRow } from "./Settings.tsx";
import { aiSetupReady } from "./setup.ts";
import { chatgptReady, setupStep } from "./setup-state.ts";

export function AiSetup({ close }: ModalProps) {
  const [local, setLocal] = useState<LocalAiSetup | null>(null), [status, setStatus] = useState<AiStatus | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null), [busy, setBusy] = useState(false), [starting, setStarting] = useState(false);
  const [canPause, setCanPause] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), notified = useRef<string | null>(null), polling = useRef(false), pulling = useRef(false);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const [readiness, ai, download] = await Promise.all([
        desktop.invoke<LocalAiSetup>(AI_CHANNELS.localSetup), desktop.invoke<AiStatus>(AI_CHANNELS.status),
        desktop.invoke<{ progress: ModelProgress | null; downloading: boolean; canCancel: boolean }>("models:status", { fromAiSetup: true }),
      ]);
      if (!mounted.current) return;
      setLocal(readiness); setStatus(ai); setBusy(download.downloading || pulling.current); setCanPause(download.canCancel || pulling.current);
      setProgress(download.progress);
    } catch { if (mounted.current) setError("Could not check AI setup. Close this sheet and try again."); }
    finally { polling.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const off = desktop.on("models:progress", (value) => setProgress(value as ModelProgress));
    return () => { mounted.current = false; clearInterval(timer); off(); };
  }, [refresh]);
  // A provider changes only on the writer's choice in this sheet: "Use ChatGPT", a sign-in started here, or a step of
  // "Run on this Mac". Being signed in already, a sign-in in another window, or a local model that happens to be ready
  // isn't a choice.
  const signedIn = !!status && chatgptReady(status), [useChatgpt, setUseChatgpt] = useState(false);
  const signingIn = useRef(false), [localChosen, setLocalChosen] = useState(() => app.setting<string>(AI_SETTINGS.provider, "ollama") === "ollama");
  // The sign-in started here is used once; cancelling or failing it ends it, so a later sign-in elsewhere changes nothing.
  // A poll that began before the click can still report "not pending"; only the end of a sign-in seen pending counts.
  const pending = !!status?.chatgpt.pending, sawPending = useRef(false);
  useEffect(() => {
    if (!signingIn.current) return;
    if (signedIn) { signingIn.current = sawPending.current = false; setUseChatgpt(true); }
    else if (pending) sawPending.current = true;
    else if (sawPending.current) signingIn.current = sawPending.current = false;
  }, [signedIn, pending, status]);
  const local_ = () => {
    setLocalChosen(true); setUseChatgpt(false);
    // A local model chosen in Settings and since deleted would hold every step at Download; let the default take over.
    const chosen = app.setting<string>(AI_SETTINGS.model("ollama"), "");
    if (chosen) void desktop.invoke<{ models: string[] }>(AI_CHANNELS.models, "ollama")
      .then(({ models }) => models.some((m) => sameOllamaModel(m, chosen)) ? undefined : app.setSetting(AI_SETTINGS.model("ollama"), "")).then(() => refresh(), () => undefined);
  };
  const step = setupStep(local, useChatgpt, busy ? progress?.state === "verifying" ? progress : { ...progress, state: "downloading", status: "" } : progress?.state === "paused" ? progress : null);
  useEffect(() => {
    if ((step !== "ready" && step !== "chatgpt-ready") || (step === "ready" && !localChosen) || notified.current === step) return;
    notified.current = step;
    const finish = async () => {
      if (step === "ready") {
        const chosen = app.setting<string>(AI_SETTINGS.model("ollama"), "");
        if (chosen) {
          const models = await desktop.invoke<{ models: string[] }>(AI_CHANNELS.models, "ollama");
          if (!models.models.includes(chosen)) await app.setSetting(AI_SETTINGS.model("ollama"), "");
        }
      }
      if (!mounted.current || notified.current !== step) return;
      await app.setSetting(AI_SETTINGS.provider, step === "chatgpt-ready" ? "chatgpt" : "ollama");
      setError("");
      aiSetupReady();
    };
    void finish().catch(() => { notified.current = null; setError("Could not select AI. Close this sheet and try again."); });
  }, [step, localChosen]);
  const start = async () => {
    local_();
    setStarting(true); setError("");
    try { await desktop.invoke(AI_CHANNELS.startOllama); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  };
  const pull = async () => {
    local_();
    pulling.current = true;
    setBusy(true); setCanPause(true); setProgress({ state: "downloading", status: "" }); setError("");
    try { await desktop.invoke("models:pull", { fromAiSetup: true }); }
    catch (e) {
      // Pausing rejects the pull too; its progress event carries the paused state.
      if (mounted.current && !pausing.current) setError("The download stopped. Retry keeps what already downloaded.");
    } finally { pulling.current = false; pausing.current = false; if (mounted.current) { setBusy(false); await refresh(); } }
  };
  const pausing = useRef(false);
  const percent = progress?.total && progress.completed !== undefined ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : undefined;
  return <div className="ai-setup">
    <p>Writing, saving and exporting never need AI. To use the AI features, choose one:</p>
    <section className="rewrite-item" aria-label="Use your ChatGPT plan">
      <h3>Use your ChatGPT plan</h3>
      <p>Uses the ChatGPT plan you already pay for. Nothing to download.</p>
      {!status ? <p role="status">Checking ChatGPT sign-in…</p>
        : signedIn ? step !== "chatgpt-ready" && <button className="button" onClick={() => setUseChatgpt(true)}>Use ChatGPT</button>
        : <ChatgptRow status={status.chatgpt} refresh={() => void refresh()} setup onSignIn={() => { signingIn.current = true; sawPending.current = false; }} />}
      {step === "chatgpt-ready" && <p role="status">ChatGPT is ready.</p>}
    </section>
    <section className="rewrite-item" aria-label="Run on this Mac">
      <h3>Run on this Mac</h3>
      <p>Free and private: your script stays on this Mac. One-time download of 3.3 GB.</p>
      <div role="status" aria-live="polite">
        {step === "checking" && <p>Checking AI on this Mac…</p>}
        {step === "not-installed" && <><p>Get the free Ollama app, which runs AI on your Mac.</p>
          <button className="button" onClick={() => { local_(); void desktop.invoke(CHANNELS.openExternal, "https://ollama.com/download").catch(() => setError("Could not open the download page. Try again.")); }}>Download Ollama</button>
          <p className="ai-settings-hint">Open the app after installing it. This sheet checks every two seconds.</p></>}
        {step === "not-running" && <><p>Ollama is installed but not running. Start it to use AI on this Mac.</p>
          <button className="button" disabled={starting} onClick={() => void start()}>{starting ? "Starting…" : "Start Ollama"}</button></>}
        {(step === "no-model" || step === "paused") && <><p>{step === "paused" ? "Download paused. Resume keeps what already downloaded." : "Ollama is running. Download the AI model to use it on this Mac."}</p>
          <button className="button primary" onClick={() => void pull()}>{step === "paused" ? "Resume download (3.3 GB)" : error ? "Retry download (3.3 GB)" : "Download (3.3 GB)"}</button></>}
        {step === "downloading" && <><progress aria-label="AI download" value={percent} max={100} />
          <p>{progress?.state === "verifying" ? "Checking the download…" : percent === undefined ? "Preparing download…" : `Downloading: ${percent}%`}</p>
          <button className="button" disabled={!canPause || pausing.current} onClick={() => {
            pausing.current = true;
            void desktop.invoke("models:cancel").catch(() => { pausing.current = false; setError("Could not pause the download. Try again."); });
          }}>Pause</button><p className="ai-settings-hint">{canPause ? "You can pause and resume without starting over." : "This download started in another window. Pause it there."} Closing this sheet keeps the download running.</p></>}
        {step === "ready" && (localChosen ? <p>AI on this Mac is ready.</p>
          : <><p>AI on this Mac is ready to use.</p><button className="button" onClick={local_}>Use AI on this Mac</button></>)}
        {step === "chatgpt-ready" && <p>ChatGPT is selected. You can use AI now.</p>}
      </div>
    </section>
    {error && <p className="ai-settings-error" role="alert">{error}</p>}
    <div className="ai-setup-actions"><button className="button" onClick={close}>Not now</button>
      {((step === "ready" && localChosen) || step === "chatgpt-ready") && <button className="button primary" onClick={close}>Done</button>}</div>
  </div>;
}
