/** Keep the native window fill in step with the renderer while its first frame loads. */
export function windowBackground(theme: unknown, systemDark: boolean): string {
  const dark = theme === "dark" || theme !== "light" && systemDark;
  return dark ? "#141517" : "#e6e7e9";
}
