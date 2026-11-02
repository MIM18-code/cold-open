import { join } from "node:path";
import type { ServiceContext } from "../context.ts";
import { HistoryStore } from "../history/store.ts";
import { HISTORY, type HistoryRecord } from "../../shared/channels/history.ts";

export function register(ctx: ServiceContext): void {
  const store = new HistoryStore(join(ctx.paths.userData, "draft-history"));
  ctx.handle(HISTORY.list, (_event, key: string) => store.list(key));
  ctx.handle(HISTORY.record, (_event, request: HistoryRecord) => store.record(request));
  ctx.handle(HISTORY.read, (_event, key: string, id: string) => store.read(key, id));
  ctx.handle(HISTORY.remove, (_event, key: string, id: string) => store.remove(key, id));
}
