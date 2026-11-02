// Channels of the print service (src/main/services/print.ts).

export const PRINT_CHANNELS = {
  /** renderer → main: print pages through the system print dialog. Payload: PrintRequest. Returns PrintResult. */
  print: "print:print",
} as const;

export interface PrintRequest {
  /** A complete HTML document with one fixed-size element per page (see features/print/pages.ts). */
  html: string;
  /** Paper size in inches. */
  width: number;
  height: number;
  /** Shown in the print dialog and used as the default name when printing to a PDF file. */
  title: string;
}

export interface PrintResult {
  /** True when the system dialog finished printing; false when the writer cancelled or printing failed. */
  printed: boolean;
  /** Why printing did not happen, as Chromium reports it ("cancelled", "failed"). */
  reason?: string;
  /** End-to-end runs render to PDF instead of opening the dialog; this is the size of that PDF. */
  testBytes?: number;
}

/** Paper sizes outside this range (inches) are not real paper; a huge one would make a huge window. */
const MIN_PAPER = 2, MAX_PAPER = 30;
/** Far more than a 300-page script needs. */
const MAX_HTML = 64 * 1024 * 1024;

/** The main process checks a request with this before it sizes a window or writes to disk. */
export function validPrintRequest(request: unknown): request is PrintRequest {
  const r = request as Partial<PrintRequest> | null;
  const paper = (value: unknown) => typeof value === "number" && value >= MIN_PAPER && value <= MAX_PAPER;
  return !!r && typeof r.html === "string" && r.html.length <= MAX_HTML && paper(r.width) && paper(r.height)
    && typeof r.title === "string";
}
