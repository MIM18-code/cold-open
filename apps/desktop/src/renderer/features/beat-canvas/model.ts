import type { ScreenplayDoc } from "@screenplay/engine";
import { RECORD_PREFIX, type ProjectRecord } from "../rewrite/records.ts";
export const CANVAS_PREFIX = "workbench.canvas.";
export interface BeatPlacement {
    x: number;
    y: number;
    lane: string;
    sceneId?: string;
    revision: string;
}
export function placement(value: unknown, index = 0): BeatPlacement {
    const v = value as Partial<BeatPlacement> | null;
    return { x: Number.isFinite(v?.x) ? Math.min(2800, Math.max(0, v!.x!)) : 24 + (index % 4) * 300, y: Number.isFinite(v?.y) ? Math.min(1800, Math.max(0, v!.y!)) : 24 + Math.floor(index / 4) * 220, lane: typeof v?.lane === "string" ? v.lane.slice(0, 80) : "", ...(typeof v?.sceneId === "string" ? { sceneId: v.sceneId } : {}), revision: typeof v?.revision === "string" ? v.revision : "" };
}
export function placeBeat(doc: ScreenplayDoc, id: string, next: BeatPlacement, expected: string): void {
    const record = doc.meta.get(RECORD_PREFIX + id) as ProjectRecord | undefined;
    if (record?.kind !== "beat")
        throw new Error("This beat was removed. Nothing was moved.");
    const key = CANVAS_PREFIX + id, current = placement(doc.meta.get(key));
    if (current.revision !== expected)
        throw new Error("Someone moved this beat. Review its new position before moving it again.");
    if (![next.x, next.y].every(Number.isFinite))
        throw new Error("Invalid canvas position.");
    doc.meta.set(key, { ...placement(next), revision: crypto.randomUUID() });
}
