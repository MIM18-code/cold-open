// Full-document proofreading and vocabulary scans run outside the typing thread.
// Native dictionary queries remain on the renderer in small batches.
import { type Finding, type FindingKind, type Paragraph, scriptVocabulary } from "@screenplay/engine";
import { scriptFindings } from "./check.ts";

interface Request { id: number; paragraphs: Paragraph[]; kinds: FindingKind[] }
interface Reply { id: number; findings?: Finding[]; vocabulary?: string[]; error?: string }
self.onmessage = (event: MessageEvent<Request>) => {
  const { id, paragraphs, kinds } = event.data;
  try {
    const active = new Set(kinds);
    const findings = scriptFindings(paragraphs, active);
    const vocabulary = active.has("spelling") ? [...scriptVocabulary(paragraphs)] : [];
    self.postMessage({ id, findings, vocabulary } satisfies Reply);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies Reply);
  }
};
