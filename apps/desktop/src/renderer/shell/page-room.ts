/** Fit width may scroll, but must not turn the draft into a thumbnail. */
// At 900px: 306px sidebar, 16px outer gutters, 10px scrollbar and 16px shadow slack.
// The remaining 552px fits a letter page at 67% (816 * .67 = 546.72px).
export const MIN_FIT_ZOOM = 0.67;
export const PAGE_SHADOW_ROOM = 16;

export function readablePageRoom(paperWidth: number, gutters: number): number {
  return paperWidth * 96 * MIN_FIT_ZOOM + gutters + PAGE_SHADOW_ROOM;
}

export function fitPageZoom(room: number, paperWidth: number): number {
  return Math.max(MIN_FIT_ZOOM, Math.min(2, (room - PAGE_SHADOW_ROOM) / (paperWidth * 96)));
}

export function needsSceneCollapse(width: number, left: number, right: number, page: number): boolean {
  return page > 0 && width - left - right < page;
}
