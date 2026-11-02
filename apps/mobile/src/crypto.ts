import { digest, CryptoDigestAlgorithm } from "expo-crypto";
import type { Sha256 } from "./signing.ts";

export const sha256: Sha256 = async bytes =>
  new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
