// Tools > Compare Drafts: pick an earlier draft (.screenplay, .fdx or .fountain) and see what changed in the open script,
// grouped by scene. Optionally mark the changes in the script editor.
import {
  type Comparison, type ParagraphChange, type SceneChange, type Script, type WordDiffPart, compareScripts, insertedRanges,
} from "@screenplay/engine";
import { type ReactNode, type KeyboardEvent, useEffect, useState } from "react";

import { CHANNELS, NATIVE_EXTENSION, type OpenedFile } from "../../../shared/api.ts";
import { app, type Feature } from "../../core/app.ts";
import { useScript, useSession } from "../../core/hooks.ts";
import type { Decoration } from "../../core/editor-bridge.ts";
import { desktop } from "../../core/platform.ts";
import "./compare.css";
import { scriptFromFile } from "./load.ts";

const FILTERS = [
  { name: "Screenplays", extensions: [NATIVE_EXTENSION, "fdx", "fountain", "spmd", "txt"] },
  { name: "All files", extensions: ["*"] },
];

const TYPE_LABEL: Record<string, string> = {
  sceneHeading: "Heading", action: "Action", character: "Character", parenthetical: "Parenthetical", dialogue: "Dialogue", transition: "Transition",
  shot: "Shot", general: "General", lyrics: "Lyrics", castList: "Cast list", newAct: "New act", endOfAct: "End of act",
};

interface Result {
  sessionId: string;
  fileName: string;
  /** The earlier draft, kept so the comparison can be made again as the script changes. */
  base: Script;
  /** The version of this script the comparison was made against: its paragraph offsets are only good for that one. */
  revised: Script;
  comparison: Comparison;
}

// The last comparison stays for the open document, so the dialog reopens where the writer left it. It is made
// again against the script as it is now whenever it is shown or highlighted.
let last: Result | null = null;
let highlighted = false;

/** The result compared against `script`: the same object when it already is, otherwise compared again. */
function against(result: Result, script: Script): Result {
  if (result.revised === script) return result;
  const next = { ...result, revised: script, comparison: compareScripts(result.base, script) };
  if (last?.sessionId === result.sessionId && last.base === result.base) last = next;
  return next;
}

export function decorationsFor(comparison: Comparison): Decoration[] {
  const out: Decoration[] = [];
  for (const change of comparison.changes) {
    const paragraphId = change.revisedId;
    if (!paragraphId) continue;
    if (change.kind === "added") out.push({ paragraphId, className: "compare-added", title: "Added" });
    else if (change.kind === "moved") out.push({ paragraphId, className: "compare-moved", title: "Moved" });
    else {
      const ranges = change.words ? insertedRanges(change.words) : [];
      if (ranges.length) for (const [from, to] of ranges) out.push({ paragraphId, from, to, className: "compare-changed", title: "Changed" });
      else out.push({ paragraphId, className: "compare-changed", title: "Changed" });
    }
  }
  return out;
}

function setHighlights(on: boolean, comparison?: Comparison): void {
  app.editor?.setDecorations("compare", on && comparison ? decorationsFor(comparison) : []);
  highlighted = on && !!app.editor;
  app.refreshMenu();
  app.emit();
}

function sceneTitle(scene: SceneChange): string {
  const heading = scene.status === "omitted" ? scene.baseHeading : scene.revisedHeading;
  const number = scene.status === "omitted" ? scene.baseNumber : scene.revisedNumber;
  if (heading === undefined) return "Before the first scene";
  return [number, heading || "(empty heading)"].filter(Boolean).join("  ");
}

function Words({ parts, side }: { parts: WordDiffPart[]; side: "base" | "revised" | "both" }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.op === "equal") return <span key={i}>{part.text}</span>;
        if (part.op === "insert" && side !== "base") return <ins key={i}>{part.text}</ins>;
        if (part.op === "delete" && side !== "revised") return <del key={i}>{part.text}</del>;
        return null;
      })}
    </>
  );
}

function tagFor(change: ParagraphChange): ReactNode {
  const tags: string[] = [];
  if (change.kind === "moved") tags.push("moved");
  if (change.baseType) tags.push(`${TYPE_LABEL[change.baseType] ?? change.baseType} to ${TYPE_LABEL[change.type] ?? change.type}`);
  return tags.length ? <span className="compare-tag">{tags.join(", ")}</span> : null;
}

function inlineBody(change: ParagraphChange): ReactNode {
  if (change.kind === "added") return <ins>{change.revisedText}</ins>;
  if (change.kind === "deleted") return <del>{change.baseText}</del>;
  return change.words ? <Words parts={change.words} side="both" /> : change.revisedText;
}

function ChangeRow({ change, mode }: { change: ParagraphChange; mode: "inline" | "side" }) {
  const reveal = change.revisedId && app.editor
    ? () => {
        app.editor!.revealParagraph(change.revisedId!, { select: true });
        app.closeModal();
      }
    : undefined;
  const props = { className: `compare-row ${mode === "side" ? "side" : ""} ${reveal ? "click" : ""}`,
    onClick: reveal, "data-kind": change.kind,
    ...(reveal ? { role: "button" as const, tabIndex: 0, "aria-label": `Go to ${TYPE_LABEL[change.type] ?? change.type} change in script`,
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); reveal(); }
      } } : {}),
  };
  const label = <div className="compare-type">{TYPE_LABEL[change.type] ?? change.type}</div>;
  if (mode === "inline") {
    return <div {...props}>{label}<div className="compare-text">{inlineBody(change)}{tagFor(change)}</div></div>;
  }
  const left = change.kind === "added" ? null : change.words ? <Words parts={change.words} side="base" /> : change.kind === "deleted" ? <del>{change.baseText}</del> : change.baseText;
  const right = change.kind === "deleted" ? null : change.words ? <Words parts={change.words} side="revised" /> : change.kind === "added" ? <ins>{change.revisedText}</ins> : change.revisedText;
  return (
    <div {...props}>
      {label}
      <div className={`compare-text ${left === null ? "blank" : ""}`}>{left ?? "Not in the earlier draft"}</div>
      <div className={`compare-text ${right === null ? "blank" : ""}`}>{right ?? "Not in this draft"}{tagFor(change)}</div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { added: "Added", omitted: "Omitted", changed: "Changed", moved: "Moved" };

function Summary({ comparison }: { comparison: Comparison }) {
  const { scenes, paragraphs, wordsAdded, wordsDeleted } = comparison.counts;
  return (
    <div className="compare-summary">
      <div className="compare-card">
        <h3>Scenes</h3>
        <div><span>{scenes.added} added</span><span>{scenes.omitted} omitted</span><span>{scenes.changed} changed</span><span>{scenes.moved} moved</span><span>{scenes.unchanged} unchanged</span></div>
      </div>
      <div className="compare-card">
        <h3>Paragraphs</h3>
        <div><span>{paragraphs.added} added</span><span>{paragraphs.deleted} deleted</span><span>{paragraphs.changed} changed</span><span>{paragraphs.moved} moved</span></div>
      </div>
      <div className="compare-card">
        <h3>Words</h3>
        <div><span>+{wordsAdded.toLocaleString()}</span><span>−{wordsDeleted.toLocaleString()}</span></div>
      </div>
    </div>
  );
}

function CompareModal() {
  const session = useSession();
  // Re-render shortly after the script changes; the comparison below is then made against the script as it is now.
  useScript(300);
  const [found, setResult] = useState<Result | null>(last && last.sessionId === session.id ? last : null);
  // A result belongs to the document it was made for; if the window opens another file, start over. Edits made
  // while the dialog is open (typing elsewhere, a co-writer) make it compare again, so the list and the
  // highlights never use offsets from an older version of the script.
  const current = found && found.sessionId === session.id ? found : null;
  const result = current ? against(current, session.script()) : null;
  useEffect(() => {
    if (result && result !== found) setResult(result);
  }, [result, found]);
  const [mode, setMode] = useState<"inline" | "side">("inline");
  const [open, setOpen] = useState<Set<number>>(() => defaultOpen(result?.comparison));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const choose = async () => {
    setBusy(true);
    setError("");
    try {
      const [file] = await desktop.invoke<OpenedFile[]>(CHANNELS.openDialog, { title: "Compare with an earlier draft", filters: FILTERS });
      if (!file) return;
      const base = scriptFromFile(file);
      const revised = session.script();
      const next = { sessionId: session.id, fileName: file.name, base, revised, comparison: compareScripts(base, revised) };
      last = next;
      setResult(next);
      setOpen(defaultOpen(next.comparison));
      if (highlighted) setHighlights(true, next.comparison);
    } catch (reason) {
      setError(`Couldn't read that file: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index: number) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(index)) next.add(index);
    return next;
  });

  const shown = result?.comparison.scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => scene.status !== "unchanged") ?? [];
  return (
    <div>
      <div className="compare-bar">
        <button className="button primary" disabled={busy} onClick={() => void choose()}>{result ? "Choose another draft…" : "Choose earlier draft…"}</button>
        {result ? <span className="compare-files">{result.fileName} (earlier) against {session.name} (this script)</span> : <span className="compare-files">Pick a .screenplay, .fdx or .fountain file.</span>}
        <span className="spacer" />
        {result ? (
          <>
            <div className="segmented" aria-label="Layout">
              <button className={mode === "inline" ? "on" : ""} onClick={() => setMode("inline")}>Inline</button>
              <button className={mode === "side" ? "on" : ""} onClick={() => setMode("side")}>Side by side</button>
            </div>
            <button className="button" disabled={!app.editor} title={app.editor ? "" : "Open the script view first"}
              onClick={() => (setHighlights(true, against(result, session.script()).comparison), app.closeModal())}>Highlight in script</button>
          </>
        ) : null}
      </div>
      {error ? <div className="empty-note" role="alert" style={{ color: "var(--error)" }}>{error}</div> : null}
      {result ? (
        <>
          <Summary comparison={result.comparison} />
          {result.comparison.identical ? <div className="empty-note">The two drafts are identical.</div> : (
            <>
              <div className="compare-bar">
                <button className="button" onClick={() => setOpen(new Set(shown.map(({ index }) => index)))}>Expand all</button>
                <button className="button" onClick={() => setOpen(new Set())}>Collapse all</button>
              </div>
              <div className="compare-list">
                {shown.map(({ scene, index }) => (
                  <section key={index}>
                    <button className="compare-scene-head" aria-expanded={open.has(index)} onClick={() => toggle(index)}>
                      <span>{open.has(index) ? "▾" : "▸"}</span>
                      <span>{sceneTitle(scene)}</span>
                      <span className={`compare-badge ${scene.moved && scene.status === "changed" ? "changed" : scene.status}`}>{STATUS_LABEL[scene.status]}</span>
                      {scene.moved && scene.status === "changed" ? <span className="compare-badge moved">Moved</span> : null}
                      <span className="count">{scene.changes.length} change{scene.changes.length === 1 ? "" : "s"}</span>
                    </button>
                    {open.has(index) ? scene.changes.map((change, i) => <ChangeRow key={i} change={change} mode={mode} />) : null}
                  </section>
                ))}
              </div>
              <div className="compare-more">Deleted text is shown here but not in the script. Unchanged scenes are not listed.</div>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Open every changed scene unless there are too many changes to draw at once. */
function defaultOpen(comparison: Comparison | undefined): Set<number> {
  if (!comparison || comparison.changes.length > 250) return new Set();
  return new Set(comparison.scenes.map((scene, index) => (scene.changes.length ? index : -1)).filter((index) => index >= 0));
}

const feature: Feature = {
  id: "compare",
  commands: [
    { id: "compare.open", label: "Compare Drafts…", menu: "Tools", group: "reports", run: (a) => a.openModal("compare.main") },
    { id: "compare.clear", label: "Clear Compare Highlights", menu: "Tools", group: "reports", enabled: () => highlighted, run: () => setHighlights(false) },
  ],
  modals: [{ id: "compare.main", title: "Compare Drafts", width: "wide", component: CompareModal }],
  activate(a) {
    // Highlights belong to the document they were made for.
    return a.onSession(() => {
      last = null;
      if (highlighted) setHighlights(false);
    });
  },
};

export default feature;
