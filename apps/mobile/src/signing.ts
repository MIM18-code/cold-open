export type Sha256 = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;

const sha256: Sha256 = async bytes =>
  new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));

export async function hmacSha256(key: Uint8Array, message: string, hash: Sha256 = sha256) {
  if (key.length > 64) key = await hash(new Uint8Array(key));
  const bytes = new TextEncoder().encode(message);
  const inner = new Uint8Array(64 + bytes.length), outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) {
    inner[i] = (key[i] ?? 0) ^ 0x36;
    outer[i] = (key[i] ?? 0) ^ 0x5c;
  }
  inner.set(bytes, 64);
  outer.set(await hash(inner), 64);
  return hash(outer);
}

export async function contentHash(item: SignedTake, hash: Sha256 = sha256) {
  const bytes = await hash(new TextEncoder().encode(
    JSON.stringify([item.kind, item.text, item.paragraphId, item.sourceText])));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

type SignedTake = { id: string; kind: string; text: string; paragraphId: string; sourceText: string };
export async function signTake(token: string, deviceId: string, scriptId: string, item: SignedTake,
    hash: Sha256 = sha256) {
  const key = await hash(new TextEncoder().encode(token));
  // Signed domain string; the Mac verifies the same text, so it keeps the old app name.
  const message = JSON.stringify(["inklot-take-v1", deviceId, scriptId, item.id,
    item.kind, item.text, item.paragraphId, item.sourceText]);
  const bytes = await hmacSha256(key, message, hash);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
