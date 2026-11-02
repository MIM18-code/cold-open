// Keep expensive Final Draft pagination off the editor's typing thread.
// Each request is a self-contained, plain-data snapshot; this worker never reads the live Yjs document.
import { paginateForPrint, type PrintSettings } from "./options.ts";
import type { PageLock, Pagination, Script } from "@screenplay/engine";

interface Request { id: number; script: Script; settings: PrintSettings; locks: PageLock[] | null; }
type SerializedPagination = Omit<Pagination, "positions"> & { positions: [string, { page: number; line: number }][] };
interface Response { id: number; pagination?: SerializedPagination; error?: string; }

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, script, settings, locks } = event.data;
  try {
    const pagination = paginateForPrint(script, settings, locks);
    const response: Response = { id, pagination: { ...pagination, positions: [...pagination.positions] } };
    self.postMessage(response);
  } catch (error) {
    const response: Response = { id, error: error instanceof Error ? error.message : String(error) };
    self.postMessage(response);
  }
};
