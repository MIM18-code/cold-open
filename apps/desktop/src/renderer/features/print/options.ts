// Printing settings and the pagination options they produce. Everything that paginates in the app (page breaks
// in the editor, the status bar, preview, PDF and print, page numbers and lengths in the navigator, cards,
// outline and reports) goes through paginateForPrint so they agree; the views share one result through
// sharedPagination.
import {
  PAGE, PAGE_A4, paginate, scriptPaginationOptions, type PageLock, type Pagination, type PaginationOptions, type Script,
} from "@screenplay/engine";

export const SETTINGS = {
  sceneNumbers: "print.sceneNumbers",
  autoContinueds: "print.autoContinueds",
  dialogueBreaks: "print.dialogueBreaks",
  header: "print.header",
  titlePage: "print.titlePage",
  paper: "print.paper",
  revisionMarks: "print.revisionMarks",
  revisionColors: "print.revisionColors",
} as const;

export type SceneNumberSide = "both" | "left" | "right" | "none";
export type Paper = "letter" | "a4";

export interface PrintSettings {
  sceneNumbers: SceneNumberSide;
  /** Unset means "as the file says" (an FDX file's own MORE and CONT'D settings), on for other scripts. */
  autoContinueds?: boolean;
  dialogueBreaks?: boolean;
  /** Text printed at the top left of every numbered page. */
  header: string;
  titlePage: boolean;
  paper: Paper;
  /** Revision marks in the right margin of revised lines. Default on. */
  revisionMarks: boolean;
  /** Revised pages printed on their revision's paper color. Default off. */
  revisionColors: boolean;
}

const SIDES: readonly SceneNumberSide[] = ["both", "left", "right", "none"];

export function readPrintSettings(settings: Record<string, unknown>): PrintSettings {
  const side = settings[SETTINGS.sceneNumbers];
  const flag = (key: string) => (typeof settings[key] === "boolean" ? (settings[key] as boolean) : undefined);
  const auto = flag(SETTINGS.autoContinueds), breaks = flag(SETTINGS.dialogueBreaks);
  return {
    sceneNumbers: SIDES.includes(side as SceneNumberSide) ? (side as SceneNumberSide) : "both",
    ...(auto !== undefined ? { autoContinueds: auto } : {}),
    ...(breaks !== undefined ? { dialogueBreaks: breaks } : {}),
    header: typeof settings[SETTINGS.header] === "string" ? (settings[SETTINGS.header] as string) : "",
    titlePage: settings[SETTINGS.titlePage] !== false,
    paper: settings[SETTINGS.paper] === "a4" ? "a4" : "letter",
    revisionMarks: settings[SETTINGS.revisionMarks] !== false,
    revisionColors: settings[SETTINGS.revisionColors] === true,
  };
}

/** The script's own layout (from FDX), with the writer's printing settings and any locked pages on top. */
export function printOptions(script: Script, settings: PrintSettings, locks: readonly PageLock[] | null = null): PaginationOptions {
  const own = scriptPaginationOptions(script);
  const paper = settings.paper === "a4" ? PAGE_A4 : PAGE;
  return scriptPaginationOptions(script, {
    page: { ...(own.page ?? PAGE), width: paper.width, height: paper.height },
    ...(settings.autoContinueds !== undefined ? { autoContinueds: settings.autoContinueds } : {}),
    ...(settings.dialogueBreaks !== undefined ? { dialogueBreaks: settings.dialogueBreaks } : {}),
    ...(locks?.length ? { locks } : {}),
  });
}

export function paginateForPrint(script: Script, settings: PrintSettings, locks: readonly PageLock[] | null = null): Pagination {
  return paginate(script, printOptions(script, settings, locks));
}

/** The settings that change where pages break, as a cache key. */
function paginationKey(settings: PrintSettings): string {
  return JSON.stringify([settings.paper, settings.autoContinueds ?? null, settings.dialogueBreaks ?? null]);
}

const shared = new WeakMap<Script, { key: string; pagination: Pagination }>();

/**
 * paginateForPrint, computed once per script object and printing settings. The app's views pass the open
 * document's script (session.script() returns one object per document version) and its page locks, so the
 * editor's page breaks, the status bar, the preview, the navigator and the reports all read the same pages.
 * Locks are read only when the pagination has to be computed; they belong to the same document version.
 */
export function sharedPagination(script: Script, settings: PrintSettings, locks: () => readonly PageLock[] | null): Pagination {
  const key = paginationKey(settings);
  const cached = shared.get(script);
  if (cached?.key === key) return cached.pagination;
  const pagination = paginateForPrint(script, settings, locks());
  shared.set(script, { key, pagination });
  return pagination;
}
