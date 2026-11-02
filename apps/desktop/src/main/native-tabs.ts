/** Narrow, testable boundary around macOS's native document tabs. */
export interface TabWindow {
  isDestroyed(): boolean;
  addTabbedWindow(window: TabWindow): void;
  selectNextTab(): void;
  selectPreviousTab(): void;
  toggleTabBar(): void;
  mergeAllWindows(): void;
  moveTabToNewWindow(): void;
}
export type TabAction = "next" | "previous" | "toggle" | "merge" | "detach";
export function attachDocumentTab(platform: string, parent: TabWindow | null | undefined, child: TabWindow): boolean {
  if (platform !== "darwin" || !parent || parent === child || parent.isDestroyed() || child.isDestroyed()) return false;
  parent.addTabbedWindow(child);
  return true;
}
export function performTabAction(platform: string, window: TabWindow | null | undefined, action: unknown): void {
  if (platform !== "darwin" || !window || window.isDestroyed()) return;
  switch (action) {
    case "next": window.selectNextTab(); break;
    case "previous": window.selectPreviousTab(); break;
    case "toggle": window.toggleTabBar(); break;
    case "merge": window.mergeAllWindows(); break;
    case "detach": window.moveTabToNewWindow(); break;
    default: throw new Error("Unknown document tab action.");
  }
}
