import CryptoKit
import Foundation
import Security

private func linkCryptoError(_ message: String) -> NSError {
  NSError(domain: "InklotLinkCrypto", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// The sealed link's primitives, all from CryptoKit and the system random source. No Expo import, so a test can
/// compile this file on its own and check it against the Mac's node:crypto provider.
enum LinkCryptoCore {
  static let tagLength = 16

  /// HKDF-SHA256 (RFC 5869), extract and expand in one call.
  static func hkdf(ikm: Data, salt: Data, info: Data, length: Int) throws -> Data {
    guard length > 0, length <= 255 * 32 else { throw linkCryptoError("Invalid key length.") }
    let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info,
                                     outputByteCount: length)
    return key.withUnsafeBytes { Data($0) }
  }

  /// AES-256-GCM with a 12-byte nonce. Returns the ciphertext followed by the 16-byte tag.
  static func seal(key: Data, nonce: Data, aad: Data, plaintext: Data) throws -> Data {
    guard key.count == 32, nonce.count == 12 else { throw linkCryptoError("Invalid key or nonce.") }
    let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce),
                               authenticating: aad)
    return box.ciphertext + box.tag
  }

  /// Opens what `seal` made. Throws when it does not authenticate.
  static func open(key: Data, nonce: Data, aad: Data, sealed: Data) throws -> Data {
    guard key.count == 32, nonce.count == 12 else { throw linkCryptoError("Invalid key or nonce.") }
    guard sealed.count >= tagLength else { throw linkCryptoError("The sealed message is too short.") }
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce),
                                    ciphertext: sealed.prefix(sealed.count - tagLength),
                                    tag: sealed.suffix(tagLength))
    return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
  }

  static func random(length: Int) throws -> Data {
    guard length > 0, length <= 4096 else { throw linkCryptoError("Invalid random length.") }
    var bytes = Data(count: length)
    let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, length, $0.baseAddress!) }
    guard status == errSecSuccess else { throw linkCryptoError("The system could not make random bytes.") }
    return bytes
  }
}
