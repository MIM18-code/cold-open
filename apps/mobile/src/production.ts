import { isPhoneProduction, isElementType, type Paragraph, type PhoneProduction } from "@screenplay/engine";

export function folderProduction(raw: string, scriptId: string) {
  if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error("Production snapshot too large.");
  const s = JSON.parse(raw);
  if (s?.v !== 2 || s.scriptId !== scriptId || typeof s.title !== "string"
      || !isPhoneProduction(s.production)
      || !Array.isArray(s.paragraphs) || s.paragraphs.some((p: Paragraph) => !p || typeof p.id !== "string"
        || !isElementType(p.type) || !Array.isArray(p.runs) || p.runs.some(r => typeof r.text !== "string")))
    throw new Error("Invalid production snapshot.");
  return s as { title: string; production: PhoneProduction; paragraphs: Paragraph[] };
}
