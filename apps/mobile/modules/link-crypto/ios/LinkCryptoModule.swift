import ExpoModulesCore

/// The sealed link's primitives for JavaScript (apps/mobile/src/link-crypto.ts). Synchronous, because the link's
/// code is; `Data` arrives from and returns to JavaScript as a Uint8Array.
public final class LinkCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("InklotLinkCrypto")
    Function("hkdf") { (ikm: Data, salt: Data, info: Data, length: Int) throws -> Data in
      try LinkCryptoCore.hkdf(ikm: ikm, salt: salt, info: info, length: length)
    }
    Function("seal") { (key: Data, nonce: Data, aad: Data, plaintext: Data) throws -> Data in
      try LinkCryptoCore.seal(key: key, nonce: nonce, aad: aad, plaintext: plaintext)
    }
    Function("open") { (key: Data, nonce: Data, aad: Data, sealed: Data) throws -> Data in
      try LinkCryptoCore.open(key: key, nonce: nonce, aad: aad, sealed: sealed)
    }
    Function("random") { (length: Int) throws -> Data in
      try LinkCryptoCore.random(length: length)
    }
  }
}
