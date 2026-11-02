import { BACKLOT_BASELINE, backlotBaseline, newId, type BacklotBaseline } from "@screenplay/engine";
import { PRODUCTION_BASELINE, type SavedProductionBaseline } from "../../../shared/channels/production-baseline.ts";
import { desktop, isDesktop } from "../../core/platform.ts";
import type { DocumentSession, SourceFormat } from "../../core/session.ts";

const baselines = new WeakMap<DocumentSession, BacklotBaseline | null>();
const identities = new WeakMap<DocumentSession, NonNullable<SavedProductionBaseline["identities"]>>();
const listeners = new Set<() => void>();
export const subscribeBaseline = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const compareHandoffs = (a: BacklotBaseline, b: BacklotBaseline) => (a.revision ?? -1) - (b.revision ?? -1) || a.sentAt.localeCompare(b.sentAt);
export function sessionBaseline(session: DocumentSession, projectId?: string): BacklotBaseline | null {
  const projects = new Map<string, BacklotBaseline>();
  const consider = (value: unknown) => {
    const b = backlotBaseline(value);
    if (!b || projectId !== undefined && b.projectId !== projectId) return;
    const previous = projects.get(b.projectId);
    if (!previous || compareHandoffs(b, previous) > 0) projects.set(b.projectId, b);
  };
  consider(baselines.get(session));
  for (const [key, value] of session.doc.meta) if (key.startsWith(BACKLOT_BASELINE + ".")) consider(value);
  return [...projects.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.projectId.localeCompare(a.projectId))[0] ?? null;
}

function recordHandoff(session: DocumentSession, baseline: BacklotBaseline): BacklotBaseline {
  const previous = sessionBaseline(session, baseline.projectId);
  const latest = previous && compareHandoffs(previous, baseline) > 0 ? previous : baseline;
  session.doc.ydoc.transact(() => {
    for (const [key, value] of session.doc.meta) {
      if (key.startsWith(BACKLOT_BASELINE + ".") && backlotBaseline(value)?.projectId === baseline.projectId) session.doc.meta.delete(key);
    }
    // Separate keys preserve both concurrent acceptances until their Backlot revisions can be compared.
    session.doc.meta.set(BACKLOT_BASELINE + "." + newId(), latest);
  }, "backlot-handoff");
  return latest;
}

function remember(session: DocumentSession, baseline: BacklotBaseline | null): void {
  baselines.set(session, baseline);
  for (const listener of listeners) listener();
}

/** Called before publishing an opened session, so restored identities never replace a writer's edits. */
export async function restoreProductionBaseline(session: DocumentSession): Promise<void> {
  if (!isDesktop || !session.path || session.format === "screenplay") return;
  const saved = await desktop.invoke<SavedProductionBaseline | null>(PRODUCTION_BASELINE.get, session.path);
  if (saved?.identities) {
    const script = session.script(), headings = script.paragraphs.filter(p => p.type === "sceneHeading");
    const byId = new Map(saved.identities.headings.map(h => [h.id, h.sceneId]));
    if (saved.identities.fileHash === session.fileHash && headings.length === saved.identities.headings.length) {
      // Fountain and ID-less FDX need the exact saved bytes for positional restoration.
      headings.forEach((heading, i) => Object.assign(heading, saved.identities!.headings[i]));
    } else if (session.format === "fdx") {
      for (const heading of headings) if (byId.has(heading.id)) heading.sceneId = byId.get(heading.id)!;
    }
    session.doc.load(script);
    session.undo.clear();
    session.dirty = false;
  }
  if (session.fileHash) identities.set(session, { fileHash: session.fileHash, headings: productionHeadingIdentities(session) });
  remember(session, saved?.baseline ?? null);
}

export function prepareProductionBaselineSave(session: DocumentSession, format: SourceFormat): BacklotBaseline | null {
  const baseline = sessionBaseline(session);
  if (format === "screenplay" && baseline && ![...session.doc.meta.values()].includes(baseline)) recordHandoff(session, baseline);
  return baseline;
}

export function productionHeadingIdentities(session: DocumentSession): { id: string; sceneId: string }[] {
  return session.script().paragraphs.filter(p => p.type === "sceneHeading").map(p => ({ id: p.id, sceneId: p.sceneId ?? p.id }));
}

export async function persistProductionBaseline(session: DocumentSession, baseline: BacklotBaseline | null, savedHeadings?: { id: string; sceneId: string }[]): Promise<void> {
  remember(session, baseline);
  if (!isDesktop || !session.path || session.format === "screenplay") return;
  const saved: SavedProductionBaseline | null = baseline ? { baseline } : null;
  if (session.fileHash && (savedHeadings || !session.dirty)) identities.set(session, {
    fileHash: session.fileHash, headings: savedHeadings ?? productionHeadingIdentities(session),
  });
  const savedIds = identities.get(session);
  if (saved && savedIds?.fileHash === session.fileHash) saved.identities = savedIds;
  await desktop.invoke(PRODUCTION_BASELINE.set, session.path, saved);
}

export async function acceptProductionBaseline(session: DocumentSession, baseline: BacklotBaseline): Promise<void> {
  // Capture the on-disk identities before recording the handoff makes the document dirty.
  if (session.fileHash && !session.dirty) identities.set(session, { fileHash: session.fileHash, headings: productionHeadingIdentities(session) });
  await persistProductionBaseline(session, recordHandoff(session, baseline));
}
