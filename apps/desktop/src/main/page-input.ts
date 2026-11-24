// Checks on values the page hands to the main process. The page is the app's own interface, but a page that has
// been tampered with can send anything, so what it sends is read as data.
import { MENUS, type MenuCommand } from "../shared/api.ts";

/** An address the system browser may open: http or https with a host. */
export function isWebUrl(url: unknown): url is string {
  // The "//" is required of the text itself: the URL parser accepts "https:example.com" and supplies it.
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  try { return !!new URL(url).hostname; } catch { return false; }
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** The menu commands in what the page sent, with anything malformed left out. */
export function menuCommands(value: unknown): MenuCommand[] {
  if (!Array.isArray(value)) return [];
  const out: MenuCommand[] = [];
  for (const entry of value.slice(0, 2000)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, menu, accelerator, group, enabled, checked } = entry as Record<string, unknown>;
    if (!text(id, 200) || !text(label, 200) || !(MENUS as readonly unknown[]).includes(menu)) continue;
    out.push({
      id, label, menu: menu as MenuCommand["menu"],
      ...(text(accelerator, 100) ? { accelerator } : {}),
      ...(text(group, 100) ? { group } : {}),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof checked === "boolean" ? { checked } : {}),
    });
  }
  return out;
}
