import { ACCENT_CHANNELS, accentText } from "../../shared/accent.ts";
import { desktop } from "../core/platform.ts";

function resolvedSystemColour(keyword: string): string | null {
  if (!CSS.supports("color", keyword)) return null;
  const probe = document.createElement("span");
  probe.style.color = keyword;
  probe.hidden = true;
  document.documentElement.append(probe);
  const channels = getComputedStyle(probe).color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  probe.remove();
  return channels ? `#${channels.slice(1).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}` : null;
}

export function applySystemAccent(value: unknown): void {
  if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) return;
  const root = document.documentElement;
  const text = accentText(value);
  // Parsing the keyword is insufficient: Chromium may return a generic colour instead of the Mac preference.
  const nativeCSS = resolvedSystemColour("AccentColor")?.toLowerCase() === value.toLowerCase();
  root.style.setProperty("--native-accent", nativeCSS ? "AccentColor" : value);
  root.style.setProperty("--native-accent-text",
    nativeCSS && resolvedSystemColour("AccentColorText") === text ? "AccentColorText" : text);
  // Hover/press move away from the text colour, preserving its contrast.
  root.style.setProperty("--accent-shade", text === "#ffffff" ? "#000000" : "#ffffff");
}

export function watchSystemAccent(): () => void {
  const cssAccent = resolvedSystemColour("AccentColor");
  if (cssAccent) applySystemAccent(cssAccent);
  if (desktop.platform === "browser") return () => {};
  let changed = false;
  const off = desktop.on(ACCENT_CHANNELS.changed, (value) => {
    changed = true;
    applySystemAccent(value);
  });
  void desktop.invoke(ACCENT_CHANNELS.get).then((value) => {
    if (!changed) applySystemAccent(value);
  }).catch((error) => console.warn("System accent unavailable; using CSS fallback", error));
  return () => { changed = true; off(); };
}
