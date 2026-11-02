import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpath, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { openForRead } from "../safe-fs.ts";
import type { ImportOptions } from "../../shared/channels/backlot.ts";
export async function readBounded(path: string, max: number): Promise<string> { const opened = await openForRead(path); if (!opened)
    throw new Error("Required local file is missing."); try {
    if (opened.info.size > max)
        throw new Error("Local file exceeds the allowed size.");
    return new TextDecoder().decode(await opened.read());
}
finally {
    await opened.close();
} }
export function runFileFor(project: string, home = homedir()): string { const hint = basename(dirname(project)).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); return join(home, ".backlot", "run", `${hint ? hint + "-" : ""}${createHash("sha256").update(project).digest("hex")}.json`); }
export function validateConnection(value: unknown, project: string): {
    url: string;
    token: string;
    pid: number;
} { const v = value as any; if (!v || v.project !== project || typeof v.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(v.url) || Number(new URL(v.url).port) > 65535 || typeof v.token !== "string" || !/^[-\w]{24,200}$/.test(v.token) || !Number.isSafeInteger(v.pid) || v.pid < 1)
    throw new Error("Backlot’s connection record is invalid. Open this project in Backlot again."); return { url: v.url, token: v.token, pid: v.pid }; }
export class BacklotClient {
    private readonly url: string;
    private readonly token: string;
    private readonly request: typeof fetch;
    constructor(connection: {
        url: string;
        token: string;
    }, request: typeof fetch = fetch) { if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(connection.url))
        throw new Error("Backlot must be a loopback service."); this.url = connection.url; this.token = connection.token; this.request = request; }
    async call(path: "/health" | "/project" | "/breakdown/import", body?: unknown): Promise<any> {
        const response = await this.request(this.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(120000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        if (Number(response.headers.get("content-length") ?? 0) > 8000000)
            throw new Error("Backlot response is too large.");
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error("Backlot returned no response.");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                length += value.length;
                if (length > 8000000) {
                    await reader.cancel();
                    throw new Error("Backlot response is too large.");
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.length;
        }
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (!response.ok)
            throw new Error(typeof value.message === "string" ? value.message.slice(0, 1000) : `Backlot refused the request (${response.status}).`);
        return value;
    }
    async check(project: string, id: string): Promise<{
        title: string;
        revision: number;
    }> { const health = await this.call("/health"); if (health.project !== project || health.diverged || health.refused)
        throw new Error("Backlot’s project changed or is refusing writes. Review it in Backlot first."); const p = await this.call("/project"); if (p.id !== id || p.formatVersion !== 14 || !Number.isSafeInteger(p.revision) || typeof p.meta?.title !== "string")
        throw new Error("This Backlot project/version is not supported by the reviewed bridge."); return { title: p.meta.title, revision: p.revision }; }
    async plan(path: string, options: ImportOptions, token?: string, productionChanges?: unknown): Promise<any> { const value = await this.call("/breakdown/import", { fdxPath: path, ...(productionChanges ? { productionChanges } : {}), mode: "merge", plan: !token, ...(token ? { planToken: token } : {}), ...options, actor: { kind: "user", name: "Cold Open reviewed handoff" } }); if (!value?.plan || typeof value.planToken !== "string" || !Number.isSafeInteger(value.revision) || !Array.isArray(value.plan.unresolved))
        throw new Error("Backlot returned an unsupported import plan."); return value; }
}
export function validateOptions(input: unknown): ImportOptions { const o = input as any; if (!o || !["add", "sync", "none"].includes(o.castMode) || typeof o.revisionLabel !== "string" || o.revisionLabel.length > 120 || !Array.isArray(o.omitSceneIds) || o.omitSceneIds.length > 5000 || o.omitSceneIds.some((v: unknown) => typeof v !== "string" || v.length > 200) || !Array.isArray(o.sceneDecisions) || o.sceneDecisions.length > 5000)
    throw new Error("Invalid import options."); const seen = new Set<string>(), matches = new Set<string>(); for (const d of o.sceneDecisions) {
    if (!d || typeof d.incomingNumber !== "string" || d.incomingNumber.length > 100 || seen.has(d.incomingNumber) || !["new", "match"].includes(d.action) || d.action === "match" && (typeof d.sceneId !== "string" || d.sceneId.length > 200 || matches.has(d.sceneId)))
        throw new Error("Each draft scene and existing match may be chosen only once.");
    seen.add(d.incomingNumber);
    if (d.action === "match")
        matches.add(d.sceneId);
} return { castMode: o.castMode, revisionLabel: o.revisionLabel, omitSceneIds: [...new Set(o.omitSceneIds)] as string[], sceneDecisions: o.sceneDecisions.map((d: any) => ({ incomingNumber: d.incomingNumber, action: d.action, ...(d.action === "match" ? { sceneId: d.sceneId } : {}) })) }; }
/** Immutable source copies stay beside the project so Backlot sourcePath remains portable. Never pruned silently. */
export async function stageDraft(project: string, xml: string): Promise<string> {
    if (typeof xml !== "string" || Buffer.byteLength(xml) > 8000000 || !/<FinalDraft[\s>]/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new Error("A handoff needs a bounded Final Draft document without external entities.");
    // Existing handoff copies live in this folder, so it keeps the old app name.
    const root = await realpath(dirname(project)), folder = join(root, ".inklot-drafts");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (await realpath(folder) !== folder)
        throw new Error("The draft handoff folder must not be a link.");
    const hash = createHash("sha256").update(xml).digest("hex"), path = join(folder, `${hash}.fdx`);
    try {
        const existing = await readBounded(path, 8000000);
        if (createHash("sha256").update(existing).digest("hex") !== hash)
            throw new Error("The captured draft was changed on disk.");
        return path;
    }
    catch (e) {
        if (!(e instanceof Error && e.message === "Required local file is missing."))
            throw e;
    }
    let total = 0;
    for (const name of await readdir(folder)) {
        if (!/^[a-f0-9]{64}\.fdx$/.test(name))
            continue;
        total += (await stat(join(folder, name))).size;
        if (total > 512000000)
            throw new Error("Stored handoff drafts exceed 512 MB. Archive older source copies after checking Backlot references.");
    }
    await writeFile(path, xml, { flag: "wx", mode: 0o600 });
    return path;
}
export async function connectProject(path: string): Promise<{
    client: BacklotClient;
    project: string;
    id: string;
    title: string;
}> {
    const project = await realpath(path), raw = JSON.parse(await readBounded(project, 16000000));
    if (raw.formatVersion !== 14 || typeof raw.id !== "string")
        throw new Error("Choose a current Backlot project JSON file.");
    const connection = validateConnection(JSON.parse(await readBounded(runFileFor(project), 10000)), project);
    try {
        process.kill(connection.pid, 0);
    }
    catch {
        throw new Error("Open this project in Backlot first.");
    }
    const client = new BacklotClient(connection), info = await client.check(project, raw.id);
    return { client, project, id: raw.id, title: info.title };
}
