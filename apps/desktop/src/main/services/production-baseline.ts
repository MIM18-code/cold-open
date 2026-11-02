import { join } from "node:path";
import { PRODUCTION_BASELINE } from "../../shared/channels/production-baseline.ts";
import type { ServiceContext } from "../context.ts";
import { ProductionBaselineStore, productionPathKey } from "../production/baseline-store.ts";

export function register(ctx: ServiceContext): void {
  const store = new ProductionBaselineStore(join(ctx.paths.userData, "production-baselines"));
  const granted = (path: unknown): string => {
    productionPathKey(path);
    if (typeof path !== "string" || !ctx.isAllowedPath(path)) throw new Error("Open the script before using its production baseline.");
    return path;
  };
  ctx.handle(PRODUCTION_BASELINE.get, (_event, path: unknown) => store.get(granted(path)));
  ctx.handle(PRODUCTION_BASELINE.set, (_event, path: unknown, value: unknown) => store.set(granted(path), value));
  ctx.onQuit(() => store.flush());
}
