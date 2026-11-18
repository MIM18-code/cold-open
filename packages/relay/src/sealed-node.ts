// The sealed link's primitives on the Mac and in tests, from node:crypto: BoringSSL inside Electron, OpenSSL in
// plain Node. The cipher is AES-256-GCM because both have it; Electron's BoringSSL has no ChaCha20-Poly1305.
// apps/desktop/test/electron-link-crypto.test.ts runs this file in Electron's runtime. The iPhone has its own
// provider built on CryptoKit (apps/mobile/src/link-crypto.ts); the two must agree byte for byte, which
// apps/mobile/test/link-crypto-native.test.ts checks.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { LinkCrypto } from "./sealed.ts";

const TAG = 16;
function check(key: Uint8Array, nonce: Uint8Array) {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("Invalid key or nonce.");
}
const bytes = (data: Buffer | ArrayBuffer) =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

export const nodeLinkCrypto: LinkCrypto = {
  hkdf: (ikm, salt, info, length) => bytes(hkdfSync("sha256", ikm, salt, info, length)),
  seal(key, nonce, aad, plaintext) {
    check(key, nonce);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
    cipher.setAAD(aad);
    return bytes(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  open(key, nonce, aad, sealed) {
    check(key, nonce);
    if (sealed.length < TAG) throw new Error("The sealed message is too short.");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return bytes(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]));
  },
  random: (length) => bytes(randomBytes(length)),
};
