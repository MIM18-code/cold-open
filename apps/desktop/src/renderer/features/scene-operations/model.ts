import { captureScriptNotes, isOmitted, moveScene, newId, pageLocks, plainText, sceneNumbersLocked, scenesOf, type Paragraph, type TextPosition } from "@screenplay/engine";
import type { DocumentSession } from "../../core/session.ts";
import { anchorAt, createRecord, putRecord, records, resolveAnchor } from "../rewrite/records.ts";
export type SceneOperation = {
    kind: "duplicate";
    sceneId: string;
    copyNotes: boolean;
} | {
    kind: "move";
    sceneId: string;
    before: string | null;
} | {
    kind: "split";
    sceneId: string;
    at: TextPosition;
    heading: string;
} | {
    kind: "merge";
    sceneId: string;
};
export function applySceneOperation(session: DocumentSession, expected: number, operation: SceneOperation): string {
    if (session.readOnly || session.version !== expected)
        throw new Error("The draft changed. Reopen the scene preview.");
    const doc = session.doc, ps = doc.paragraphs(), scenes = scenesOf(ps), scene = scenes.find(s => s.sceneId === operation.sceneId);
    if (!scene)
        throw new Error("The source scene was removed.");
    if (pageLocks(doc)?.length || sceneNumbersLocked(doc) || scene.paragraphIds.some(id => doc.paragraph(id).sceneNumber))
        throw new Error("This operation needs an unnumbered, unlocked working draft. Reconcile issued production numbers separately.");
    if (isOmitted(doc.paragraph(scene.headingId)))
        throw new Error("Restore an omitted scene before restructuring it.");
    let result = scene.headingId, change: () => void;
    if (operation.kind === "move") {
        if (operation.before && !scenes.some(s => s.sceneId === operation.before))
            throw new Error("The destination scene was removed.");
        change = () => moveScene(doc, scene.sceneId, operation.before);
    }
    else if (operation.kind === "merge") {
        const previous = scenes[scenes.indexOf(scene) - 1];
        if (!previous || previous.end !== scene.start)
            throw new Error("Only adjacent scenes within the same section can merge.");
        if (previous.paragraphIds.some(id => doc.paragraph(id).sceneNumber) || isOmitted(doc.paragraph(previous.headingId)))
            throw new Error("The preceding scene is numbered or omitted.");
        // Keep the heading as an action paragraph, rather than silently deleting words or note targets.
        change = () => { doc.setType(scene.headingId, "action"); };
        result = previous.headingId;
    }
    else if (operation.kind === "split") {
        if (!scene.paragraphIds.includes(operation.at.paragraphId) || operation.at.paragraphId === scene.headingId || !/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s+\S/i.test(operation.heading.trim()) || operation.heading.length > 300)
            throw new Error("Put the caret inside the scene body and supply a scene heading.");
        const p = doc.paragraph(operation.at.paragraphId), length = plainText(p.runs).length;
        if (operation.at.offset < 0 || operation.at.offset > length || p.dual)
            throw new Error("Choose a position outside dual dialogue.");
        const id = newId();
        result = id;
        change = () => { let index = doc.indexOf(p.id); if (operation.at.offset > 0) {
            const tail = doc.splitParagraph(p.id, operation.at.offset, p.type);
            index = doc.indexOf(tail);
        } doc.insertParagraph(index, { id, sceneId: id, type: "sceneHeading", runs: [{ text: operation.heading.trim().toUpperCase() }] }); };
    }
    else {
        const ids = new Map(scene.paragraphIds.map(id => [id, newId()])), dual = new Map<string, string>();
        const copies = ps.slice(scene.start, scene.end).map(p => { const q: Paragraph = structuredClone(p); q.id = ids.get(p.id)!; if (q.sceneId)
            q.sceneId = ids.get(p.id)!; delete q.sceneNumber; if (q.dual) {
            if (!dual.has(q.dual.block))
                dual.set(q.dual.block, newId());
            q.dual.block = dual.get(q.dual.block)!;
        } return q; });
        const all = records(doc), attached = operation.copyNotes ? all.filter(r => (r.kind === "note" || r.kind === "alternative") && r.anchor && ids.has(r.anchor.paragraphId)) : [];
        const replies = all.filter(r => r.parentId && attached.some(parent => parent.id === r.parentId)), copyRecords = [...attached, ...replies];
        if (all.length + copyRecords.length > 400)
            throw new Error("Copying this scene’s notes would exceed the project-item limit.");
        const newRecords = new Map(copyRecords.map(r => [r.id, createRecord(r.kind, r.title, r.text, { ...r })]));
        const targets = new Map(attached.map(r => [r.id, resolveAnchor(doc, r.anchor)]));
        result = copies[0]!.id;
        change = () => { copies.forEach((p, i) => doc.insertParagraph(scene.end + i, p)); for (const r of copyRecords) {
            const next = newRecords.get(r.id)!;
            const target = targets.get(r.id);
            if (target)
                next.anchor = anchorAt(doc, { paragraphId: ids.get(target.paragraphId)!, offset: target.from }, { paragraphId: ids.get(target.paragraphId)!, offset: target.to });
            else
                delete next.anchor;
            if (r.parentId)
                next.parentId = newRecords.get(r.parentId)?.id;
            putRecord(doc, next);
        } captureScriptNotes(doc, true); };
    }
    session.undo.stopCapturing();
    session.edit(change);
    session.undo.stopCapturing();
    return result;
}
