// Every main-process service. Each module exports register(ctx) and owns the IPC channels for its feature.
import type { ServiceContext } from "../context.ts";
import * as ai from "./ai.ts";
import * as dictation from "./dictation.ts";
import * as files from "./files.ts";
import * as print from "./print.ts";
import * as settings from "./settings.ts";
import * as spelling from "./spelling.ts";
import * as sync from "./sync.ts";
import * as tableRead from "./table-read.ts";
import * as tableReadFiles from "./table-read-files.ts";
import * as history from "./history.ts";
import * as backlot from "./backlot.ts";
import * as phone from "./phone.ts";
import * as modelManager from "./model-manager.ts";
import * as projectSearch from "./project-search.ts";
import * as productionBaseline from "./production-baseline.ts";

export function registerServices(ctx: ServiceContext): void {
  for (const service of [files, settings, spelling, print, sync, dictation, ai, tableRead, tableReadFiles, history, projectSearch, modelManager, phone, backlot, productionBaseline]) service.register(ctx);
}
