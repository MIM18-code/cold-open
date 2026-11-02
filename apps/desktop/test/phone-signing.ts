import { createHmac } from "node:crypto";

export function signEnvelope<T extends { deviceId: string; scriptId: string }>(item: T, tokenHash: string) {
  const fields = item as T & Record<string, unknown>;
  const message = JSON.stringify(["inklot-take-v1", item.deviceId, item.scriptId, fields.id,
    fields.kind, fields.text, fields.paragraphId, fields.sourceText]);
  const sig = createHmac("sha256", Buffer.from(tokenHash, "hex")).update(message).digest("base64url");
  return { ...item, sig };
}
