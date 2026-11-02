export const ACCENT_CHANNELS = {
  get: "theme:accent",
  changed: "theme:accent-changed",
} as const;

export function accentLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

/** Either black or white always provides at least 4.5:1 on an opaque RGB colour. */
export function accentText(hex: string): "#000000" | "#ffffff" {
  const luminance = accentLuminance(hex);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

export function normalizeAccent(value: unknown): string | null {
  return typeof value === "string" && /^[\da-f]{8}$/i.test(value) ? `#${value.slice(0, 6)}` : null;
}
