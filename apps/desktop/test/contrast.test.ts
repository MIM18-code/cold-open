import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { accentText, normalizeAccent } from "../src/shared/accent.ts";

const css = readFileSync(new URL("../src/renderer/shell/styles.css", import.meta.url), "utf8");

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test("text meets AA contrast across automatic and explicit themes", () => {
  const tokens = (selector: string): Record<string, string> => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return Object.fromEntries([...css.matchAll(new RegExp(`${escaped} \\{([^{}]*)\\}`, "g"))]
      .flatMap((block) => [...block[1]!.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1]!, match[2]!])));
  };
  const base = tokens(":root");
  const themes = {
    light: base,
    explicitLight: { ...base, ...tokens(':root[data-theme="light"]') },
    automaticDark: { ...base, ...tokens(':root:not([data-theme="light"])') },
    explicitDark: { ...base, ...tokens(':root[data-theme="dark"]') },
  };
  for (const [name, theme] of Object.entries(themes)) {
    for (const background of ["bg", "bg-raised", "bg-sunken", "paper"]) {
      for (const foreground of ["ink", "ink-2", "ink-3"]) {
        assert(theme[foreground] && theme[background], `${name} needs ${foreground} and ${background}`);
        assert(contrast(theme[foreground]!, theme[background]!) >= 4.5, `${name}: ${foreground} on ${background}`);
      }
    }
  }
});


function mix(a: string, b: string, weight: number): string {
  return "#" + [1, 3, 5].map((index) => Math.round(
    parseInt(a.slice(index, index + 2), 16) * weight
    + parseInt(b.slice(index, index + 2), 16) * (1 - weight),
  ).toString(16).padStart(2, "0")).join("");
}

test("system accents keep primary buttons and list selections readable in both themes", () => {
  const fallback = css.match(/--system-accent: (#[\da-f]{6});/)![1]!;
  const accents = [fallback, "#007aff", "#a550a7", "#f44f9e", "#e0383e", "#f7821b",
    "#ffcc00", "#62ba46", "#808080"];
  for (const theme of [
    { name: "light", ink: "#17191c", panel: "#f7f7f6" },
    { name: "dark", ink: "#e9eaec", panel: "#1d1f22" },
  ]) {
    for (const accent of accents) {
      const text = accentText(accent);
      const shade = text === "#ffffff" ? "#000000" : "#ffffff";
      for (const background of [accent, mix(accent, shade, 0.9), mix(accent, shade, 0.8)]) {
        assert(contrast(text, background) >= 4.5, `${theme.name}: button ${accent} on ${background}`);
      }
      assert(contrast(theme.ink, mix(accent, theme.panel, 0.12)) >= 4.5,
        `${theme.name}: selected list text on ${accent}`);
      assert(contrast(mix(accent, theme.ink, 0.5), theme.panel) >= 3,
        `${theme.name}: visible focus ring for ${accent}`);
    }
  }
  assert.equal(accentText("#ffcc00"), "#000000");
  assert.equal(accentText(fallback), "#ffffff");
  for (const selector of [".button.primary"]) {
    const rule = css.slice(css.indexOf(selector + " {")).split("}")[0]!;
    assert.match(rule, /background:\s*var\(--accent\)/);
    assert.match(rule, /color:\s*var\(--accent-ink\)/);
  }
  assert.match(css, /--accent-hover: color-mix\(in srgb, var\(--accent\) 90%, var\(--accent-shade\)\)/);
  assert.match(css, /--accent-pressed: color-mix\(in srgb, var\(--accent\) 80%, var\(--accent-shade\)\)/);
});

test("selected toolbar segments use neutral surfaces with readable text", () => {
  // ink on paper is also checked across explicit and automatic themes above.
  for (const selector of [".panel-tab.on", ".write-primary.on, .plan-trigger.on"]) {
    const rule = css.slice(css.indexOf(selector + " {")).split("}")[0]!;
    assert.match(rule, /background:\s*var\(--paper\)/);
    assert.match(rule, /color:\s*var\(--ink\)/);
  }
});

test("Electron RGBA accents become opaque RGB and malformed values cannot enter CSS", () => {
  assert.equal(normalizeAccent("FFCC00FF"), "#FFCC00");
  assert.equal(normalizeAccent("808080ff"), "#808080");
  for (const value of [null, "", "red", "#007aff", "007aff;", "var(--ink)"]) {
    assert.equal(normalizeAccent(value), null);
  }
});
