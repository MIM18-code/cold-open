import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function phonePathKey(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}
