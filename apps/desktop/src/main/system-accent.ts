import { app, nativeTheme, systemPreferences } from "electron";
import { ACCENT_CHANNELS, normalizeAccent } from "../shared/accent.ts";
import type { ServiceContext } from "./context.ts";

/** Called after app.ready, before any renderer loads. This is system state, not a saved preference. */
export function registerSystemAccent(ctx: ServiceContext): void {
  const read = () => process.platform === "darwin" ? normalizeAccent(systemPreferences.getAccentColor()) : null;
  let accent = read();
  ctx.handle(ACCENT_CHANNELS.get, read);
  const update = () => {
    const next = read();
    if (next === accent) return;
    accent = next;
    ctx.broadcast(ACCENT_CHANNELS.changed, accent);
  };
  systemPreferences.on("accent-color-changed", update);
  nativeTheme.on("updated", update);
  app.on("browser-window-focus", update);
  // Electron's accent-color-changed event is Windows/Linux only. AppKit supplies the Mac notification.
  const local = process.platform === "darwin"
    ? systemPreferences.subscribeLocalNotification("NSSystemColorsDidChangeNotification", update) : null;
  const distributed = process.platform === "darwin"
    ? systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", update) : null;
  ctx.onQuit(() => {
    systemPreferences.removeListener("accent-color-changed", update);
    nativeTheme.removeListener("updated", update);
    app.removeListener("browser-window-focus", update);
    if (local !== null) systemPreferences.unsubscribeLocalNotification(local);
    if (distributed !== null) systemPreferences.unsubscribeNotification(distributed);
  });
}
