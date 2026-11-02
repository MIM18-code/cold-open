import type { ProductionChange } from "@screenplay/engine";

export interface SceneDecision {
    incomingNumber: string;
    action: "match" | "new";
    sceneId?: string;
}
export interface ImportOptions {
    castMode: "add" | "sync" | "none";
    revisionLabel: string;
    omitSceneIds: string[];
    sceneDecisions: SceneDecision[];
}
export interface PlanRow {
    sceneId?: string;
    number?: string;
    heading?: string;
    previousNumber?: string;
    previousHeading?: string;
    reason?: string;
    [key: string]: unknown;
}
export interface UnresolvedScene {
    incomingNumber: string;
    heading: string;
    reason: string;
    candidates: {
        sceneId: string;
        number: string;
        heading: string;
    }[];
}
export interface BacklotPlan {
    id: string;
    title: string;
    project: string;
    stagedPath: string;
    revision: number;
    plan: Record<string, PlanRow[] | UnresolvedScene[] | unknown>;
    addedElements: number;
    removedElements: number;
    unresolved: UnresolvedScene[];
}

export interface BacklotProductionState {
    projectId: string;
    scenes: { sceneId: string; headingId?: string; scheduled: boolean; issuedCallSheet: boolean }[];
}

export function reviewForChange(state: BacklotProductionState | null, change: ProductionChange, sceneDecisions: SceneDecision[] = []): NonNullable<ProductionChange["review"]> {
    const headings = [change.before?.headingId, change.after?.headingId].filter((id): id is string => !!id);
    const incomingNumber = change.after?.number || (change.position === null ? undefined : String(change.position));
    const match = change.after && sceneDecisions.find(d => d.incomingNumber === incomingNumber && d.action === "match");
    const linked = state?.scenes.filter(s => s.sceneId === change.sceneId || s.sceneId === match?.sceneId || !!s.headingId && headings.includes(s.headingId)) ?? [];
    const scheduled = linked.some(s => s.scheduled), issuedCallSheet = linked.some(s => s.issuedCallSheet);
    return { scheduled, issuedCallSheet, needsBacklotReview: scheduled || issuedCallSheet };
}
