// Settings shared by every window. Values are plain JSON; secrets go through the ai service's keychain store instead.
import { CHANNELS } from "../../shared/api.ts";
import type { ServiceContext } from "../context.ts";

/**
 * Main owns files.* (startup file grants), grants.* (native dialog choices) and phone.* (validated phone settings).
 * Pages can read these values but must use the owning service to change them.
 */
export const MAIN_OWNED_PREFIXES: readonly string[] = ["files.", "grants.", "phone."];

export function register(ctx: ServiceContext): void {
  ctx.handle(CHANNELS.settingsGet, () => ctx.settings.all());
  ctx.handle(CHANNELS.settingsSet, (_event, key: string, value: unknown) => {
    // Names Object.prototype has ("__proto__", "constructor") are never settings; the store has no prototype anyway.
    if (typeof key !== "string" || !key || key in Object.prototype) throw new Error("A setting needs a key.");
    if (MAIN_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) throw new Error("That setting is managed by the app.");
    ctx.settings.set(key, value);
  });
}
