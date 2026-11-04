import { useEffect, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import type { InstalledModel, ModelPin, ModelProgress } from "../../../main/models/ollama.ts";
interface Status {
    installed: InstalledModel[];
    pins: ModelPin[];
    progress: ModelProgress | null;
    downloading: boolean;
    source: string;
}
function ModelManager() {
    const [status, setStatus] = useState<Status | null>(null), [progress, setProgress] = useState<ModelProgress | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const refresh = async () => { try {
        const s = await desktop.invoke<Status>("models:status");
        setStatus(s);
        setProgress(s.progress);
        setError("");
    }
    catch (e) {
        setError("Could not check the formatting model. Choose Set up formatting on this Mac to start Ollama and check again.");
    } };
    useEffect(() => { void refresh(); return desktop.on("models:progress", (value) => setProgress(value as ModelProgress)); }, []);
    const run = async (channel: string, ...args: unknown[]) => { setBusy(true); setError(""); try {
        await desktop.invoke(channel, ...args);
        await refresh();
    }
    catch (e) {
        setError(String(e));
    }
    finally {
        setBusy(false);
    } };
    const source = status?.installed.find((m) => m.name === status.source), percent = progress?.total && progress.completed !== undefined ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : null;
    return <section className="roadmap-dialog"><h3>Local formatting model</h3><p>Cold Open manages a pinned version of the formatter through Ollama on this Mac. Writing needs neither. The selected version does not silently change when a newer download arrives.</p>
    <p>Cold Open can install Ollama and download the writing model for you. Allow about 4 GB for the download. Your script stays on this Mac.</p>
    <button className="button" disabled={busy} onClick={() => void refresh()}>Refresh model status</button>
    <button className="button primary" disabled={busy || !!status?.downloading} onClick={() => void run("models:pull")}>{source ? "Repair / check for a newer formatter…" : "Set up formatting on this Mac…"}</button>
    {(busy || status?.downloading) && <button className="button" onClick={() => void desktop.invoke("models:cancel")}>Pause this window’s download</button>}
    {progress && <div role="status"><p>{progress.status}{percent !== null ? ` · ${percent}% of current layer` : ""}</p>{percent !== null && <progress aria-label="Model download progress" max={100} value={percent}/>}</div>}
    {source && <section><strong>{source.name}</strong><p>{(source.size / 1024 ** 3).toFixed(2)} GB · SHA-256 {source.digest}</p><button className="button" disabled={busy} onClick={() => void run("models:use", source.digest)}>Pin and use this version for Format Draft</button></section>}
    <h3>Pinned versions</h3>{status?.pins.map((pin) => <article key={pin.name}><strong>{pin.name}</strong><small>{pin.installedAt} · {(pin.size / 1024 ** 3).toFixed(2)} GB logical model size</small><p>{pin.digest}</p><button className="button" disabled={busy} onClick={() => void run("models:select-pin", pin.name)}>Use this pinned version</button><button className="button" disabled={busy} onClick={async () => {
        const response = await messageBox({ type: "warning", message: `Remove pinned alias “${pin.name}”?`, detail: "Formatting stops using this pinned version; shared source weights are not deleted.", buttons: ["Keep", "Remove"], defaultId: 0, cancelId: 0 });
        if (response !== 1) return;
        await run("models:remove", pin.name);
    }}>Remove pinned alias…</button></article>)}
    <p>Shared source weights are not deleted here. Ollama verifies downloads and owns its shared storage; removing an alias may free no disk space. Pause cancels this app’s request, not another app’s concurrent pull.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
const feature: Feature = { id: "model-manager", settings: [{ id: "modelManager", title: "Formatting models", order: 21, component: ModelManager }], commands: [{ id: "models.open", label: "Manage Local Formatting Models…", menu: "Tools", group: "settings", run: () => app.openModal("workspace.settings", { section: "modelManager" }) }] };
export default feature;
