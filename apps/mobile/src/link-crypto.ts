// The sealed link's primitives on the iPhone, from Apple's CryptoKit through the local InklotLinkCrypto module
// (modules/link-crypto). The app implements no cipher or key derivation of its own. Bytes cross to Swift as
// Uint8Array and come back as Uint8Array: expo-modules-core converts them to and from `Data` in synchronous
// functions, so nothing is base64-encoded on the way.
import { requireNativeModule } from "expo";
import type { LinkCrypto } from "@screenplay/relay/sealed";

interface NativeLinkCrypto {
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array;
  random(length: number): Uint8Array;
}

let native: NativeLinkCrypto | undefined;
const bridge = () => native ??= requireNativeModule<NativeLinkCrypto>("InklotLinkCrypto");

export const linkCrypto: LinkCrypto = {
  hkdf: (ikm, salt, info, length) => bridge().hkdf(ikm, salt, info, length),
  seal: (key, nonce, aad, plaintext) => bridge().seal(key, nonce, aad, plaintext),
  open: (key, nonce, aad, sealed) => bridge().open(key, nonce, aad, sealed),
  random: (length) => bridge().random(length),
};
