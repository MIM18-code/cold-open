import type { ImportOptions, PlanRow } from "../../../shared/channels/backlot.ts";

const eighths = (n: number) => { const whole = Math.floor(n / 8), rest = n % 8; return whole && rest ? `${whole} ${rest}/8` : whole ? `${whole}` : `${rest}/8`; };
const names = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").join(", ") : "";

/** Backlot's import plan in a writer's words, one group per kind of change, in the order a reviewer reads them. */
export function planGroups(plan: Record<string, unknown>, castMode: ImportOptions["castMode"]): { key: string; title: string; rows: string[] }[] {
  const titles: [string, string][] = [
    ["added", "New scenes"],
    ["removed", "Scenes missing from this draft (they stay active unless you omit them)"],
    ["omit", "Scenes to omit"],
    ["restored", "Omitted scenes coming back"],
    ["renumbered", "Renumbered scenes"],
    ["headingChanged", "Changed headings"],
    ["textChanged", "Scenes whose text changed"],
    ["pagesChanged", "Changed page counts"],
    ["castApplied", "Cast changes Backlot will make"],
    ["castAdded", "Scenes with new speaking cast"],
    ["castRemoved", castMode === "sync" ? "Cast the draft drops (Backlot removes them)" : "Cast the draft no longer lists (kept, because the cast mode only adds)"],
    ["castIgnored", "Names Backlot leaves out of the cast"],
    ["elementsRemoved", "Breakdown elements removed"],
    ["occurrencesChanged", "Breakdown elements that moved scenes"],
    ["synopsisMayBeStale", "Synopses that may be out of date"],
    ["matched", "Scenes matched to existing production scenes"],
    ["baselined", "Scenes recorded for the first time, so later sends can show text changes"],
    ["kept", "Unchanged scenes"],
  ];
  return titles.flatMap(([key, title]) => {
    const rows = plan[key];
    if (!Array.isArray(rows) || !rows.length) return [];
    return [{ key, title, rows: (rows as PlanRow[]).map(row => describe(key, row)) }];
  });
}

function describe(key: string, row: PlanRow): string {
  const scene = [row.number, row.heading].filter(Boolean).join(" · ") || "Scene";
  const pages = row.pagesChanged as { from: number; to: number } | undefined;
  const detail =
    key === "headingChanged" && row.previousHeading ? `was ${row.previousHeading}` :
    key === "renumbered" && row.previousNumber ? `was ${row.previousNumber}` :
    key === "pagesChanged" && pages ? `${eighths(pages.from)} → ${eighths(pages.to)} pages` :
    key === "castAdded" || key === "castApplied" || key === "castRemoved" ? [names(row.castAdded) && `+ ${names(row.castAdded)}`, names(row.castRemoved) && `− ${names(row.castRemoved)}`].filter(Boolean).join("; ") :
    key === "castIgnored" ? names(row.ignoredNames) :
    key === "elementsRemoved" || key === "occurrencesChanged" ? names(row.elements) : "";
  return detail ? `${scene}: ${detail}` : scene;
}
