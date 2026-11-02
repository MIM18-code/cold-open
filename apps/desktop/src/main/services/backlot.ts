import { backlotBaseline, isProductionSnapshot, backlotChanges, type ProductionSnapshot, type ProductionChanges } from "@screenplay/engine";
import { productionState, readProductionState } from "../ai/backlot.ts";
import { AI_SETTINGS } from "../../shared/channels/ai.ts";
import { dialog } from "electron";
import { randomUUID, createHash } from "node:crypto";
import type { ServiceContext } from "../context.ts";
import { connectProject, stageDraft, readBounded, validateOptions } from "../backlot/client.ts";
import { reviewForChange, type BacklotPlan, type ImportOptions } from "../../shared/channels/backlot.ts";
type Connection = Awaited<ReturnType<typeof connectProject>>;
interface Pending {
    id: string;
    token: string;
    path: string;
    hash: string;
    options: ImportOptions;
    result: any;
    snapshot: ProductionSnapshot;
    changes: ProductionChanges;
}
export function register(ctx: ServiceContext): void {
    const connections = new Map<number, Connection>(), pending = new Map<number, Pending>(), busy = new Set<number>();
    const view = (c: Connection, p: Pending): BacklotPlan => ({ id: p.id, title: c.title, project: c.project, stagedPath: p.path, revision: p.result.revision, plan: p.result.plan, addedElements: p.result.addedElements ?? 0, removedElements: p.result.removedElements ?? 0, unresolved: p.result.plan.unresolved });
    ctx.handle("backlot:production-state", async (event) => {
        const c = connections.get(event.sender.id);
        if (c) return productionState(JSON.parse(await readBounded(c.project, 16000000)));
        const path = ctx.settings.get<string>(AI_SETTINGS.backlotPath);
        return path ? readProductionState(path) : null;
    });
    ctx.handle("backlot:choose", async (event) => { const w = ctx.windowOf(event.sender), id = event.sender.id; if (!w || busy.has(id))
        throw new Error("Finish the current Backlot request first."); const choice = await dialog.showOpenDialog(w, { title: "Choose the project already open in Backlot", properties: ["openFile"], filters: [{ name: "Backlot project", extensions: ["json"] }] }); if (choice.canceled || !choice.filePaths[0])
        return null; busy.add(id); try {
        const c = await connectProject(choice.filePaths[0]);
        if (event.sender.isDestroyed())
            return null;
        connections.set(id, c);
        pending.delete(id);
        event.sender.once("destroyed", () => { connections.delete(id); pending.delete(id); });
        return { title: c.title, project: c.project, projectId: c.id };
    }
    finally {
        busy.delete(id);
    } });
    ctx.handle("backlot:preview", async (event, xml: unknown, input: unknown, production: unknown) => {
        const id = event.sender.id, c = connections.get(id);
        if (!c || busy.has(id))
            throw new Error("Choose an open Backlot project and finish the current request first.");
        if (typeof xml !== "string")
            throw new Error("Invalid screenplay source.");
        if (!production || Buffer.byteLength(JSON.stringify(production)) > 8000000)
            throw new Error("Invalid production snapshot.");
        const source = production as { baseline: unknown; current: unknown };
        if (!isProductionSnapshot(source.current) || source.baseline !== null && !backlotBaseline(source.baseline))
            throw new Error("Invalid production snapshot.");
        const baseline = backlotBaseline(source.baseline);
        const changes = backlotChanges(baseline?.projectId === c.id ? baseline : null, source.current);
        const options = validateOptions(input), previous = pending.get(id);
        if (options.omitSceneIds.some(scene => !previous?.result.plan.removed?.some((r: any) => r.sceneId === scene)))
            throw new Error("Only scenes listed as missing in the previous preview can be omitted.");
        for (const d of options.sceneDecisions) {
            const unresolved = previous?.result.plan.unresolved?.find((r: any) => r.incomingNumber === d.incomingNumber);
            const remembered = previous?.options.sceneDecisions.find(r => JSON.stringify(r) === JSON.stringify(d));
            if (!remembered && (!unresolved || d.action === "match" && !unresolved.candidates.some((r: any) => r.sceneId === d.sceneId)))
                throw new Error("Review the available scene matches again.");
        }
        busy.add(id);
        try {
            await c.client.check(c.project, c.id);
            const state = productionState(JSON.parse(await readBounded(c.project, 16000000)));
            for (const change of changes.scenes) change.review = reviewForChange(state, change, options.sceneDecisions);
            const path = await stageDraft(c.project, xml), result = await c.client.plan(path, options, undefined, changes);
            if (event.sender.isDestroyed() || connections.get(id) !== c)
                throw new Error("The project connection changed.");
            const p: Pending = { id: randomUUID(), token: result.planToken, path, hash: createHash("sha256").update(xml).digest("hex"), options, result, snapshot: source.current, changes };
            pending.set(id, p);
            return view(c, p);
        }
        finally {
            busy.delete(id);
        }
    });
    ctx.handle("backlot:apply", async (event, planId: unknown) => {
        const id = event.sender.id, c = connections.get(id), p = pending.get(id), w = ctx.windowOf(event.sender);
        if (!c || !p || p.id !== planId || !w || busy.has(id))
            throw new Error("Review a current import plan first.");
        if (p.result.plan.unresolved.length)
            throw new Error("Resolve ambiguous scene identities and preview again before applying.");
        busy.add(id);
        try {
            const answer = await dialog.showMessageBox(w, { type: "warning", message: `Apply this captured draft to “${c.title}” in Backlot?`, detail: `${p.result.plan.added?.length ?? 0} new scenes; ${p.result.plan.omit?.length ?? 0} explicitly omitted scenes; ${p.result.addedElements ?? 0} new breakdown elements. Cast mode: ${p.options.castMode}. Backlot validates the reviewed project revision and records an undoable transaction. This does not reorder shoot days or send call sheets. The captured FDX stays at ${p.path}. Later Cold Open edits are not part of this import.`, buttons: ["Cancel", "Apply reviewed import"], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1)
                return null;
            if (event.sender.isDestroyed() || connections.get(id) !== c || pending.get(id) !== p)
                throw new Error("The reviewed project changed.");
            const current = await c.client.check(c.project, c.id);
            if (current.revision !== p.result.revision)
                throw new Error("Backlot changed since the preview. Preview again.");
            if (createHash("sha256").update(await readBounded(p.path, 8000000)).digest("hex") !== p.hash)
                throw new Error("The captured FDX changed. Preview again.");
            const result = await c.client.plan(p.path, p.options, p.token, p.changes);
            pending.delete(id);
            return { revision: result.revision, project: c.title, stagedPath: p.path, baseline: { ...p.snapshot, sentAt: new Date().toISOString(), projectId: c.id, revision: result.revision } };
        }
        finally {
            busy.delete(id);
        }
    });
}
