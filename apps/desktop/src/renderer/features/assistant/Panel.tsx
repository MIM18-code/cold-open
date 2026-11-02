import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { CHANNELS } from "../../../shared/api.ts";
import { AI_CHANNELS, AI_SETTINGS, CHATGPT_USAGE_URL, judgesWholeScript, PROVIDER_LABELS, type AiStatus, WHOLE_SCRIPT_NEEDS } from "../../../shared/channels/ai.ts";
import { app } from "../../core/app.ts";
import { useApp, useSessionState, useSetting } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import { hasSelection as selectionExists } from "../format-draft/target.ts";
import { applySuggestion } from "./apply.ts";
import { type ChatMessage, Chat } from "./chat.ts";
import { splitAnswer, type Suggestion } from "./suggestions.ts";

let chat: Chat | null = null;
export function getChat(): Chat {
  return (chat ??= new Chat(app));
}

function useChat(): Chat {
  const current = getChat();
  useSyncExternalStore(current.subscribe, current.getVersion);
  return current;
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const [state, setState] = useState<"idle" | "applied" | string>("idle");
  const { readOnly } = useSessionState();
  const apply = () => {
    const result = applySuggestion(app, suggestion);
    if ("error" in result) return setState(result.error);
    setState("applied");
  };
  const problem = state !== "idle" && state !== "applied" ? state : null;
  return (
    <div className="assistant-suggestion">
      <div className="assistant-suggestion-label">{suggestion.cut === "speech" ? "Cut speech" : suggestion.cut === "paragraph" ? "Cut paragraph" : "Suggested change"}{suggestion.scene ? `, scene ${suggestion.scene}` : ""}</div>
      <div className="assistant-diff"><del>{suggestion.find}</del>{suggestion.cut ? null : <ins>{suggestion.replace}</ins>}</div>
      {suggestion.why ? <div className="assistant-why">{suggestion.why}</div> : null}
      <div className="assistant-suggestion-actions">
        <button className="button" disabled={state === "applied" || readOnly} title={readOnly ? "This script is read-only." : undefined} onClick={apply}>{state === "applied" ? "Applied" : "Apply"}</button>
        {problem ? <span className="assistant-problem">{problem}</span> : null}
      </div>
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <div className="assistant-message assistant-user">{message.text}</div>;
  const pieces = message.toolAnswer ? [{ type: "text" as const, text: message.text }] : splitAnswer(message.text);
  const steps = message.steps?.map((line, index) => <div key={index}>{line}</div>);
  return (
    <div className="assistant-message assistant-reply">
      {steps?.length ? message.streaming
        ? <div className="assistant-steps">{steps}</div>
        : <details className="assistant-steps"><summary>Script lookup</summary>{steps}</details> : null}
      {pieces.map((piece, i) => piece.type === "text"
        ? <div key={i} className="assistant-text">{piece.text}</div>
        : <SuggestionCard key={i} suggestion={piece.suggestion} />)}
      {message.proposals?.map((suggestion, index) => <SuggestionCard key={`proposal-${index}`} suggestion={suggestion} />)}
      {message.streaming && !message.text ? <div className="assistant-wait">Thinking</div> : null}
      {message.error ? <div className="assistant-error">{message.error}</div> : null}
      {message.note ? <div className="assistant-note">{message.note}</div> : null}
    </div>
  );
}

export function AssistantPanel() {
  const current = useChat();
  const backlotPath = useApp((a) => a.setting<string>(AI_SETTINGS.backlotPath, ""));
  const hasSelection = useApp((a) => selectionExists(a.editor?.getSelection()));
  const [text, setText] = useState("");
  const [useBacklot, setUseBacklot] = useState(true);
  const [useSelection, setUseSelection] = useState(true);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // Refetch when the provider changes in Settings, so the continuity action follows it.
  const [provider] = useSetting<string>(AI_SETTINGS.provider, "");
  useEffect(() => {
    void desktop.invoke<AiStatus>(AI_CHANNELS.status).then(setStatus, () => undefined);
  }, [current.messages.length, provider]);
  // The braces matter: an effect that returns a value makes React call it as a cleanup and crash the panel.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [current.version]);

  const options = { backlot: useBacklot && !!backlotPath, selection: useSelection && hasSelection };
  const submit = () => {
    if (!text.trim() || current.busy) return;
    void current.send(text, options);
    setText("");
  };
  const active = status?.active;
  const ready = status?.providers.find((p) => p.provider === active?.provider)?.ready;

  return (
    <div className="assistant">
      <div className="assistant-head panel-header">
        <span title="Change the provider in Settings, under AI">
          {active ? `${PROVIDER_LABELS[active.provider]}${active.model ? `, ${active.model}` : ""}` : "Assistant"}
        </span>
        {current.messages.length ? <button className="icon-button" onClick={() => current.clear()}>Clear</button> : null}
      </div>
      {active?.provider === "chatgpt" && ready ? <div className="assistant-plan">
        <span>Using ChatGPT plan</span>
        <button className="link-button" onClick={() => void desktop.invoke(CHANNELS.openExternal, CHATGPT_USAGE_URL)}>Manage usage</button>
      </div> : null}
      <div className="assistant-actions">
        <button className="button" disabled={current.busy} onClick={() => void current.quick("notes", options)}>Notes on this scene</button>
        <button className="button" disabled={current.busy} onClick={() => void current.quick("summarize", options)}>Summarize scene</button>
        {active && !judgesWholeScript(active.provider)
          ? <button className="button" disabled title={WHOLE_SCRIPT_NEEDS}>Check continuity across the script <span className="assistant-needs">{WHOLE_SCRIPT_NEEDS}</span></button>
          : <button className="button" disabled={current.busy} onClick={() => void current.quick("continuity", options)}>Check continuity across the script</button>}
      </div>
      <div className="assistant-log" role="log" aria-live="polite">
        {current.messages.length === 0 ? (
          <div className="assistant-empty">
            Ask about the script{backlotPath ? " or the production" : ""}. Nothing is sent until you ask.
            {status && ready === false ? <div className="assistant-problem">Not ready: open Settings, AI, to set up {PROVIDER_LABELS[status.active.provider]}.</div> : null}
          </div>
        ) : current.messages.map((message) => <Message key={message.id} message={message} />)}
        <div ref={end} />
      </div>
      <div className="assistant-compose">
        {backlotPath || hasSelection ? (
          <div className="assistant-includes">
            {backlotPath ? <label><input type="checkbox" checked={useBacklot} onChange={(e) => setUseBacklot(e.target.checked)} /> Backlot data</label> : null}
            {hasSelection ? <label><input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} /> Selection</label> : null}
          </div>
        ) : null}
        <textarea
          aria-label="Ask about the script" value={text} rows={3} placeholder="Which scenes need the stunt coordinator?"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) (event.preventDefault(), submit());
          }}
        />
        <div className="assistant-send">
          {current.busy ? <button className="button" onClick={() => current.stop()}>Stop</button> : <button className="button primary" disabled={!text.trim()} onClick={submit}>Ask</button>}
        </div>
      </div>
    </div>
  );
}
