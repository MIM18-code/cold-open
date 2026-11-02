import { backlotBaseline, type BacklotBaseline } from "@screenplay/engine";

export const PRODUCTION_BASELINE = { get: "production-baseline:get", set: "production-baseline:set" } as const;
export const BASELINE_LIMIT = 8_000_000;
export interface SavedProductionBaseline {
  baseline: BacklotBaseline;
  identities?: { fileHash: string; headings: { id: string; sceneId: string }[] };
}

export function isSavedProductionBaseline(value: unknown): value is SavedProductionBaseline {
  const v = value as SavedProductionBaseline | null;
  return !!v && !!backlotBaseline(v.baseline) && (v.identities === undefined ||
    (!!v.identities && typeof v.identities.fileHash === "string" && /^[a-f0-9]{64}$/.test(v.identities.fileHash) &&
      Array.isArray(v.identities.headings) && v.identities.headings.length <= 10000 &&
      v.identities.headings.every(h => h && [h.id, h.sceneId].every(id => typeof id === "string" && id.length > 0 && id.length <= 20000)) &&
      new Set(v.identities.headings.map(h => h.id)).size === v.identities.headings.length &&
      new Set(v.identities.headings.map(h => h.sceneId)).size === v.identities.headings.length));
}
