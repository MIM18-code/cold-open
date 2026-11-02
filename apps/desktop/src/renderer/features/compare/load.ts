// Read a file of any supported format into a plain script, without opening it as a document.
import { parseFdx, parseFountain, type Script } from "@screenplay/engine";

import type { OpenedFile } from "../../../shared/api.ts";
import { decodeNative, isNative } from "../../core/fileformat.ts";

export function scriptFromFile(file: OpenedFile): Script {
  if (isNative(file.data)) return decodeNative(file.data).doc.toScript();
  const text = new TextDecoder().decode(file.data);
  if (/\.fdx$/i.test(file.name) || /<FinalDraft[\s>]/.test(text.slice(0, 400))) return parseFdx(text);
  return parseFountain(text);
}
