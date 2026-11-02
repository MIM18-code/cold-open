// Settings > Dictation: the speech engine and helper, the local formatting model, and buttons to warm the
// speech model and test the model server.
import { useEffect, useState } from "react";

import {
  DICTATION, SETTING_DEFAULTS, SETTING_KEYS, SPEECH_ENGINES, type CheckResult, type SpeechEngineName,
} from "../../../shared/channels/dictation.ts";
import { useSetting } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import { prepareEngine } from "./controller.ts";
import { useDictation } from "./store.ts";

/** A text setting that is saved when the field loses focus, not on every keystroke. */
function TextSetting({ label, settingKey, fallback, placeholder, hint }: {
  label: string; settingKey: string; fallback: string; placeholder?: string; hint?: string;
}) {
  const [value, setValue] = useSetting(settingKey, fallback);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input value={text} placeholder={placeholder} spellCheck={false} onChange={(event) => setText(event.target.value)}
        onBlur={() => text.trim() !== value && setValue(text.trim())} />
      {hint ? <small className="dictation-hint">{hint}</small> : null}
    </label>
  );
}

function HelperPath() {
  const [path] = useSetting(SETTING_KEYS.helperPath, SETTING_DEFAULTS.helperPath);
  const [status, setStatus] = useState<{ helperPath: string; exists: boolean } | null>(null);
  const refresh = () => void desktop.invoke<{ helperPath: string; exists: boolean }>(DICTATION.status).then(setStatus, () => setStatus(null));
  useEffect(refresh, [path]);
  const shown = status ? `${status.helperPath}${status.exists ? "" : " (not found)"}` : path;
  const [error, setError] = useState("");
  // The app runs this program, so only the Choose dialog sets it; a typed path is not accepted. The main process's
  // answer is what counts, so the shown path is read back from it after every change.
  const run = (channel: string) => {
    setError("");
    desktop.invoke(channel).then(refresh, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  return (
    <div className="dictation-helper">
      <div className="field">
        <span>Speech helper</span>
        <span className="dictation-helper-path">{shown || "Not found"}</span>
        <small className="dictation-hint">{path ? "You chose this helper." : "Found automatically."}</small>
      </div>
      <button type="button" className="button" onClick={() => run(DICTATION.chooseHelper)}>Choose…</button>
      {path ? <button type="button" className="button" onClick={() => run(DICTATION.clearHelper)}>Find Automatically</button> : null}
      {error ? <p className="dictation-note-error">{error}</p> : null}
    </div>
  );
}

function Results({ result }: { result: CheckResult }) {
  return (
    <ul className="dictation-notes">
      <li className={result.helper.ok ? "dictation-note-ok" : "dictation-note-error"}>{result.helper.message}</li>
      <li className={result.server.ok ? "dictation-note-ok" : "dictation-note-error"}>{result.server.message}</li>
    </ul>
  );
}

export function DictationSettings() {
  const [engine, setEngine] = useSetting<SpeechEngineName>(SETTING_KEYS.engine, SETTING_DEFAULTS.engine);
  const [mode, setMode] = useSetting(SETTING_KEYS.mode, SETTING_DEFAULTS.mode);
  const [provider, setProvider] = useSetting(SETTING_KEYS.provider, SETTING_DEFAULTS.provider);
  const [confirmed, setConfirmed] = useSetting(SETTING_KEYS.localConfirmed, SETTING_DEFAULTS.localConfirmed);
  const { prepare } = useDictation();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState("");

  const check = async () => {
    setChecking(true);
    setCheckError("");
    try {
      setResult(await desktop.invoke<CheckResult>(DICTATION.check));
    } catch (error) {
      setResult(null);
      setCheckError(error instanceof Error ? error.message : String(error));
    }
    setChecking(false);
  };

  return (
    <div className="dictation-settings">
      <label className="field">
        <span>Speech engine</span>
        <select value={engine} onChange={(event) => setEngine(event.target.value as SpeechEngineName)}>
          {SPEECH_ENGINES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
      </label>
      <HelperPath />
      {engine === "whisper" ? (
        <TextSetting label="Whisper model file" settingKey={SETTING_KEYS.whisperModel} fallback="" placeholder="Path to a ggml model" />
      ) : null}
      <label className="field">
        <span>Dictation button</span>
        <select value={mode} onChange={(event) => setMode(event.target.value as "toggle" | "push")}>
          <option value="toggle">Click to start, click to stop</option>
          <option value="push">Hold to talk</option>
        </select>
      </label>
      <div className="dictation-row">
        <button className="button" disabled={prepare.state === "busy"} onClick={() => void prepareEngine()}>Prepare engine</button>
        {prepare.message ? <span className={`dictation-hint ${prepare.state === "error" ? "dictation-note-error" : ""}`} role="status">{prepare.message}</span> : null}
      </div>

      <h3 className="dictation-heading">Formatting model</h3>
      <label className="field">
        <span>Model server</span>
        <select value={provider} onChange={(event) => setProvider(event.target.value as "ollama" | "compatible")}>
          <option value="ollama">Ollama</option>
          <option value="compatible">OpenAI-compatible server (LM Studio, llama.cpp)</option>
        </select>
      </label>
      <TextSetting label="Endpoint" settingKey={SETTING_KEYS.endpoint} fallback={SETTING_DEFAULTS.endpoint}
        hint="Only this computer is allowed: 127.0.0.1, localhost or ::1." />
      <TextSetting label="Model" settingKey={SETTING_KEYS.model} fallback={SETTING_DEFAULTS.model} />
      <label className="dictation-inline">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>This server runs the model on this computer</span>
      </label>
      <div className="dictation-row">
        <button className="button" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check model server"}</button>
      </div>
      {result ? <Results result={result} /> : null}
      {checkError ? <div className="dictation-error" role="alert">{checkError}</div> : null}
    </div>
  );
}
