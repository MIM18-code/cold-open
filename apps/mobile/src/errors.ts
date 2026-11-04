/** The text of an error for the writer: its message, without the "Error:" prefix String() adds. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
