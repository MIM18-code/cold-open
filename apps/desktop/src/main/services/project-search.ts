import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { dialog } from "electron";
import type { ServiceContext } from "../context.ts";
import { isScreenplayFile } from "../recent-files.ts";
import { openForRead } from "../safe-fs.ts";
import { searchScript, scriptFromBytes } from "../workspace/search.ts";
export function register(ctx: ServiceContext): void {
    const chosen = new Map<number, string[]>(), jobs = new Map<number, string>(), watched = new Set<number>();
    ctx.handle("project-search:choose", async (event) => {
        const w = ctx.windowOf(event.sender);
        if (!w)
            throw new Error("Window closed.");
        if (!watched.has(event.sender.id)) {
            const id = event.sender.id;
            watched.add(id);
            event.sender.once("destroyed", () => { jobs.delete(id); chosen.delete(id); watched.delete(id); });
        }
        const result = await dialog.showOpenDialog(w, { title: "Choose scripts to search locally", properties: ["openFile", "multiSelections"], filters: [{ name: "Screenplays", extensions: ["screenplay", "fdx", "fountain", "txt", "spmd"] }] });
        if (result.canceled)
            return null;
        if (result.filePaths.length > 30)
            throw new Error("Choose at most 30 scripts per search.");
        const paths = result.filePaths.filter(isScreenplayFile);
        for (const p of paths)
            ctx.allowReadPath(p);
        chosen.set(event.sender.id, paths);
        return paths.map((path) => ({ path, name: basename(path) }));
    });
    ctx.handle("project-search:cancel", (event) => { jobs.delete(event.sender.id); });
    ctx.handle("project-search:run", async (event, query: unknown, matchCase: unknown) => {
        if (typeof query !== "string" || !query.trim() || query.length > 300)
            throw new Error("Search for 1–300 characters.");
        const paths = chosen.get(event.sender.id) ?? [], token = randomUUID(), results: unknown[] = [], errors: string[] = [];
        if (!paths.length)
            throw new Error("Choose script files first.");
        jobs.set(event.sender.id, token);
        try {
            for (const path of paths) {
                if (jobs.get(event.sender.id) !== token)
                    throw new Error("Search cancelled.");
                try {
                    if (!ctx.isReadablePath(path) || !isScreenplayFile(path))
                        throw new Error("The file is no longer available. Choose it again.");
                    const opened = await openForRead(path);
                    if (!opened)
                        throw new Error("File missing.");
                    let data: Uint8Array;
                    try {
                        if (opened.info.size > 8000000)
                            throw new Error("File exceeds 8 MB search limit.");
                        data = await opened.read();
                    }
                    finally {
                        await opened.close();
                    }
                    if (!ctx.isReadablePath(path))
                        throw new Error("The file location changed.");
                    const hits = searchScript(scriptFromBytes(data), query, matchCase === true, 100);
                    results.push({ path, name: basename(path), hash: createHash("sha256").update(data).digest("hex"), hits, truncated: hits.length === 100 });
                }
                catch (e) {
                    errors.push(`${basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
                }
                await new Promise((r) => setImmediate(r));
            }
            return { results, errors };
        }
        finally {
            if (jobs.get(event.sender.id) === token)
                jobs.delete(event.sender.id);
        }
    });
}
