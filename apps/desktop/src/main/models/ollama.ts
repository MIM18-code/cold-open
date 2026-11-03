// Fixed catalogue. Setup uses the AI endpoint saved in Settings; formatting uses the loopback service.
export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const FORMATTER_MODEL = "qwen3.5:4b";
export interface InstalledModel {
    name: string;
    digest: string;
    size: number;
}
export interface ModelProgress {
    state: "preparing" | "downloading" | "verifying" | "ready" | "paused" | "error";
    status: string;
    completed?: number;
    total?: number;
}
export interface ModelPin extends InstalledModel {
    source: string;
    installedAt: string;
}
export function validDigest(value: unknown): value is string { return typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(value); }
export function localModels(value: unknown): InstalledModel[] {
    const body = value as {
        models?: unknown[];
    } | null;
    if (!Array.isArray(body?.models))
        throw new Error("Ollama returned an invalid model list.");
    return body.models.slice(0, 2000).flatMap((raw) => {
        const m = raw as any;
        return m && typeof m.name === "string" && m.name.length <= 200 && !/cloud/i.test(m.name) && !m.remote_model && !m.remote_host && validDigest(m.digest) && Number.isFinite(m.size) && m.size > 0
            ? [{ name: m.name, digest: m.digest.replace(/^sha256:/, ""), size: m.size }] : [];
    });
}
export class OllamaModels {
    private readonly request: typeof fetch;
    private readonly origin: string;
    constructor(request: typeof fetch = fetch, origin = OLLAMA_ORIGIN) { this.request = request; this.origin = origin.replace(/\/+$/, ""); }
    private async call(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await this.request(this.origin + path, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(5000), headers: { "content-type": "application/json" } });
        if (!response.ok)
            throw new Error(`Ollama model request failed (${response.status}). Start Ollama and retry.`);
        return response;
    }
    async list(): Promise<InstalledModel[]> {
        const response = await this.call("/api/tags");
        const text = await response.text();
        if (text.length > 2000000)
            throw new Error("Ollama model list is too large.");
        return localModels(JSON.parse(text));
    }
    async pull(signal: AbortSignal, progress: (p: ModelProgress) => void): Promise<InstalledModel> {
        progress({ state: "downloading", status: "Requesting the model manifest" });
        const response = await this.call("/api/pull", { method: "POST", signal, body: JSON.stringify({ model: FORMATTER_MODEL, stream: true, insecure: false }) });
        if (!response.body)
            throw new Error("Ollama returned no download progress.");
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pending = "", success = false;
        const line = (text: string) => {
            if (!text.trim())
                return;
            const value = JSON.parse(text);
            if (typeof value.error === "string")
                throw new Error(value.error.slice(0, 300));
            if (typeof value.status !== "string")
                throw new Error("Invalid model progress.");
            if (value.status === "success")
                success = true;
            const state = /verif|manifest|remov/i.test(value.status) ? "verifying" : "downloading";
            progress({ state, status: value.status.slice(0, 180), ...(Number.isSafeInteger(value.total) && value.total > 0 && value.total < 1e12 ? { total: value.total } : {}), ...(Number.isSafeInteger(value.completed) && value.completed >= 0 && value.completed < 1e12 ? { completed: value.completed } : {}) });
        };
        try {
            while (true) {
                signal.throwIfAborted();
                const part = await reader.read();
                if (part.done)
                    break;
                pending += decoder.decode(part.value, { stream: true });
                if (pending.length > 100000)
                    throw new Error("Invalid model download response.");
                let at: number;
                while ((at = pending.indexOf("\n")) >= 0) {
                    line(pending.slice(0, at));
                    pending = pending.slice(at + 1);
                }
            }
            pending += decoder.decode();
            line(pending);
            signal.throwIfAborted();
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        if (!success)
            throw new Error("The download ended without a verified completion. Resume it before using this model.");
        const model = (await this.list()).find((m) => m.name === FORMATTER_MODEL);
        if (!model)
            throw new Error("Ollama has not registered a complete local model. Resume or repair the download.");
        progress({ state: "ready", status: "Download verified by Ollama" });
        return model;
    }
    /** Stable local aliases keep a later catalogue update from silently changing the chosen formatter. */
    async pin(digest: string): Promise<ModelPin> {
        if (!validDigest(digest))
            throw new Error("Invalid model digest.");
        const source = (await this.list()).find((m) => m.name === FORMATTER_MODEL && m.digest === digest);
        if (!source)
            throw new Error("The source model changed. Refresh its version before pinning it.");
        // Aliases already pinned in Ollama carry the old app name, so it stays in the alias.
        const name = `inklot-format:sha-${digest.slice(0, 24)}`;
        await this.call("/api/copy", { method: "POST", body: JSON.stringify({ source: FORMATTER_MODEL, destination: name }) });
        const pinned = (await this.list()).find((m) => m.name === name && m.digest === digest);
        if (!pinned)
            throw new Error("The copied model did not match the reviewed version. It was not selected.");
        return { ...pinned, source: FORMATTER_MODEL, installedAt: new Date().toISOString() };
    }
    async remove(name: string, digest: string): Promise<void> {
        if (!/^inklot-format:sha-[a-f0-9]{24}$/.test(name) || !validDigest(digest))
            throw new Error("Only a Cold Open-pinned alias can be removed here.");
        const model = (await this.list()).find((m) => m.name === name);
        if (!model || model.digest !== digest)
            throw new Error("The model changed or was already removed. Refresh first.");
        await this.call("/api/delete", { method: "DELETE", body: JSON.stringify({ model: name }) });
    }
}
