import { FINDING_KINDS, FINDING_KIND_LABELS, type Finding, plainText } from "@screenplay/engine";
import { useState, useSyncExternalStore } from "react";

import { useSessionState } from "../../core/hooks.ts";
import { openAiSetup } from "../assistant/setup.ts";
import { type AiScope, type ProofreadStore } from "./store.ts";

/** Button text for a replacement; spaces and nothing at all need words. */
function describeFix(fix: string): string {
  if (!fix) return "remove";
  return fix.trim() ? fix : fix.length === 1 ? "one space" : "spaces";
}

/** The flagged text with a little around it. */
function Snippet({ finding, store }: { finding: Finding; store: ProofreadStore }) {
  const paragraph = store.paragraphs.get(finding.paragraphId);
  if (!paragraph) return null;
  const text = plainText(paragraph.runs);
  const start = Math.max(0, finding.from - 24);
  const end = Math.min(text.length, finding.to + 24);
  return (
    <div className="proofread-snippet">
      {start > 0 ? "…" : ""}{text.slice(start, finding.from)}<mark>{text.slice(finding.from, finding.to) || "·"}</mark>{text.slice(finding.to, end)}{end < text.length ? "…" : ""}
    </div>
  );
}

function Item({ finding, store, readOnly }: { finding: Finding; store: ProofreadStore; readOnly: boolean }) {
  const selected = store.selectedId === finding.id;
  const fix = finding.replacement;
  // A read-only script takes no fixes; Ignore and Learn still work, in this window only.
  const locked = readOnly ? { disabled: true, title: "This script is read-only." } : {};
  return (
    <li className={`proofread-item ${selected ? "on" : ""}`} data-kind={finding.kind} onClick={() => store.reveal(finding)}>
      <div className="proofread-message">{finding.message}</div>
      <Snippet finding={finding} store={store} />
      <div className="proofread-actions" onClick={(event) => event.stopPropagation()}>
        {fix !== undefined ? <button className="button primary" {...locked} onClick={() => store.accept(finding)}>Accept{fix.length <= 18 ? `: ${describeFix(fix)}` : ""}</button> : null}
        {finding.alternatives?.slice(1, 4).map((option) => (
          <button key={option} className="button" {...locked} onClick={() => store.accept(finding, option)}>{option}</button>
        ))}
        {finding.kind === "spelling" ? <button className="button" onClick={() => store.learn(finding)}>Learn</button> : null}
        <button className="button" aria-label={`Show in script: ${finding.message}`} onClick={() => store.reveal(finding)}>Show</button>
        <button className="button" onClick={() => store.ignore(finding)}>Ignore</button>
      </div>
    </li>
  );
}

export function ProofreadPanel({ store }: { store: ProofreadStore }) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const { readOnly } = useSessionState();
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [scope, setScope] = useState<AiScope>("scene");
  const groups = FINDING_KINDS.map((kind) => ({ kind, items: store.findings.filter((finding) => finding.kind === kind) })).filter((group) => group.items.length);
  const { ai } = store;
  return (
    <div className="proofread">
      <div className="proofread-summary panel-header">
        <span>{store.findings.length ? `${store.findings.length} suggestion${store.findings.length === 1 ? "" : "s"}` : "No suggestions"}</span>
        {store.ignoredCount ? <button className="icon-button" title="Show ignored suggestions again" onClick={() => store.restoreIgnored()}>{store.ignoredCount} ignored, restore</button> : null}
      </div>
      <div className="proofread-ai-row">
        <select aria-label="What to check" value={scope} disabled={ai.running} onChange={(event) => setScope(event.target.value as AiScope)}>
          <option value="scene">This scene</option>
          <option value="script">Whole script</option>
        </select>
        {ai.running
          ? <button className="button" onClick={() => store.cancelAi()}>Stop</button>
          : <button className="button" onClick={() => void store.checkWithAi(scope)}>Check with AI</button>}
        <span className="proofread-ai-status" role="status">
          {ai.running ? ai.progress : ai.error ? <span className="proofread-error">{ai.error}{ai.setupRequired && <button className="button" onClick={openAiSetup}>Set up AI…</button>}</span> : ai.kept !== undefined ? `${ai.kept} found` : ""}
        </span>
      </div>
      <div className="proofread-list">
        {groups.length === 0 ? <div className="empty-note">The script looks clean.</div> : null}
        {groups.map((group) => (
          <section key={group.kind}>
            <h3>{FINDING_KIND_LABELS[group.kind]} <span>{group.items.length}</span></h3>
            <ul>{group.items.filter((finding, i) => i < (limits[group.kind] ?? 40) || finding.id === store.selectedId).map((finding) => <Item key={finding.id} finding={finding} store={store} readOnly={readOnly} />)}</ul>
            {group.items.length > (limits[group.kind] ?? 40) && <button className="button" onClick={() => setLimits({ ...limits, [group.kind]: (limits[group.kind] ?? 40) + 40 })}>Show 40 more ({group.items.length - (limits[group.kind] ?? 40)} remaining)</button>}
          </section>
        ))}
      </div>
    </div>
  );
}
