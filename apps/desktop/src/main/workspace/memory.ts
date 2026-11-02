// A main-owned restore list. It contains saved files and window geometry, never unsaved text or arbitrary grants.
export const WINDOW_MEMORY_KEY = "files.openWindows.v1";
export interface WindowMemory {
    path: string;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
export function windowMemories(value: unknown): WindowMemory[] {
    if (!Array.isArray(value))
        return [];
    const result: WindowMemory[] = [];
    for (const item of value.slice(0, 20)) {
        if (!item || typeof item.path !== "string" || item.path.length > 4096 || !item.bounds)
            continue;
        const b = item.bounds;
        if (![b.x, b.y, b.width, b.height].every(Number.isFinite))
            continue;
        if (result.some((r) => r.path === item.path))
            continue;
        result.push({ path: item.path, bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.min(3840, Math.max(760, Math.round(b.width))), height: Math.min(2160, Math.max(480, Math.round(b.height))) } });
    }
    return result;
}
export function visibleBounds(bounds: WindowMemory["bounds"], work: {
    x: number;
    y: number;
    width: number;
    height: number;
}): WindowMemory["bounds"] {
    const width = Math.min(bounds.width, Math.max(760, work.width)), height = Math.min(bounds.height, Math.max(480, work.height));
    return { width, height, x: Math.max(work.x, Math.min(bounds.x, work.x + work.width - width)), y: Math.max(work.y, Math.min(bounds.y, work.y + work.height - height)) };
}
/** Freezing before Quit keeps all windows, even while the normal unsaved-change close prompts run. */
export class WorkspaceMemory {
    private live = new Map<number, WindowMemory>();
    private frozen = false;
    private readonly persist: (rows: WindowMemory[]) => void;
    constructor(persist: (rows: WindowMemory[]) => void) { this.persist = persist; }
    update(id: number, row: WindowMemory | null): void { if (row)
        this.live.set(id, row);
    else
        this.live.delete(id); this.flush(); }
    close(id: number): void { this.live.delete(id); this.flush(); }
    quit(): void { if (!this.frozen) {
        this.flush();
        this.frozen = true;
    } }
    cancelQuit(): void { this.frozen = false; this.flush(); }
    flush(): void { if (!this.frozen)
        this.persist(windowMemories([...this.live.values()])); }
}
