import { useEffect, useRef, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { CHANNELS } from "../../../shared/api.ts";
import type { ScriptHit } from "../../../main/workspace/search.ts";
interface Result {
    path: string;
    name: string;
    hash: string;
    hits: ScriptHit[];
    truncated: boolean;
}
// The main process keeps the chosen files granted for this window, so the dialog can offer them again on reopen.
let rememberedFiles: { path: string; name: string }[] = [];
let rememberedQuery = "";
function SearchDialog() {
    const [files, setFilesState] = useState(rememberedFiles), [query, setQueryState] = useState(rememberedQuery), [matchCase, setMatchCase] = useState(false), [busy, setBusy] = useState(false), [results, setResults] = useState<Result[]>([]), [error, setError] = useState("");
    const setFiles = (next: typeof files) => { rememberedFiles = next; setFilesState(next); };
    const setQuery = (next: string) => { rememberedQuery = next; setQueryState(next); };
    const epoch = useRef(0);
    useEffect(() => () => { epoch.current++; void desktop.invoke("project-search:cancel"); }, []);
    const choose = async () => { try {
        const next = await desktop.invoke<typeof files | null>("project-search:choose");
        if (next) {
            setFiles(next);
            setResults([]);
            setError("");
        }
    }
    catch (e) {
        setError(String(e));
    } };
    const search = async () => { const id = ++epoch.current; setBusy(true); setError(""); try {
        const value = await desktop.invoke<{
            results: Result[];
            errors: string[];
        }>("project-search:run", query, matchCase);
        if (id === epoch.current) {
            setResults(value.results);
            setError(value.errors.join("\n"));
        }
    }
    catch (e) {
        if (id === epoch.current)
            setError(String(e));
    }
    finally {
        if (id === epoch.current)
            setBusy(false);
    } };
    return <div className="roadmap-dialog"><p>Search the saved disk versions of up to 30 chosen scripts. Unsaved edits in other windows are not included. Nothing is sent to AI or indexed outside this dialog.</p>
    <button className="button" disabled={busy} onClick={() => void choose()}>Choose script files…</button><p>{files.map((f) => f.name).join(", ") || "No files chosen"}</p>
    <form onSubmit={(e) => { e.preventDefault(); void search(); }}><label className="field"><span>Search across scripts</span><input aria-label="Search across scripts" maxLength={300} value={query} onChange={(e) => setQuery(e.target.value)}/></label><label><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)}/>Match case</label><button className="button primary" disabled={busy || !files.length || !query.trim()}>Search saved scripts</button>{busy && <button type="button" className="button" onClick={() => { epoch.current++; setBusy(false); void desktop.invoke("project-search:cancel"); }}>Cancel search</button>}</form>
    {error && <p role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}<div aria-live="polite">{results.length > 0 && `${results.reduce((n, r) => n + r.hits.length, 0)} matching paragraphs`}</div>
    <div className="roadmap-preview">{results.map((result) => <section key={result.path}><h3>{result.name}</h3><small>{result.path}</small>{result.truncated && <p>First 100 matching paragraphs shown. Refine the search.</p>}{result.hits.map((hit) => <article key={hit.paragraphId}><strong>{hit.heading}</strong><p>{hit.text}</p><button className="button" onClick={() => void desktop.invoke(CHANNELS.newWindow, result.path).catch((e) => setError(String(e)))}>Open script</button>{app.session.path === result.path && <button className="button" onClick={() => { if (app.session.dirty || app.session.fileHash !== result.hash)
        return setError("This window differs from the searched disk version. Search within the current draft instead."); const p = app.session.script().paragraphs[hit.paragraphIndex]; if (!p)
        return; app.closeModal(); app.setView("script"); setTimeout(() => { app.editor?.revealParagraph(p.id); app.editor?.setSelection({ paragraphId: p.id, offset: hit.offset }); }, 0); }}>Locate in this window</button>}</article>)}</section>)}</div>
  </div>;
}
const feature: Feature = { id: "project-search", commands: [{ id: "search.projects", label: "Search Across Script Files…", menu: "Edit", group: "find", run: () => app.openModal("search.projects") }], modals: [{ id: "search.projects", title: "Search across scripts", width: 850, component: SearchDialog }] };
export default feature;
