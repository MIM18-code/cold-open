import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { ServerOptions } from "node:https";

export interface PhoneCertificateInfo { fingerprint: string; expires: string; }
export interface PhoneTls { options: ServerOptions; info: PhoneCertificateInfo; }
/** Keys stay in the main process. This checks identity/expiry, not whether a phone trusts its issuer. */
export function phoneTls(cert: string, key: string, address: string, now = Date.now()): PhoneTls {
  if (Buffer.byteLength(cert) > 256_000 || Buffer.byteLength(key) > 32_000)
    throw new Error("The certificate or private key is too large.");
  const certificate = new X509Certificate(cert);
  if (certificate.ca) throw new Error("Choose a server certificate, not a certificate authority.");
  if (!(isIP(address) ? certificate.checkIP(address) : certificate.checkHost(address, { wildcards: false, subject: "never" }))) throw new Error("The certificate must include the chosen IP address or DNS name in its Subject Alternative Names.");
  if (!Number.isFinite(Date.parse(certificate.validFrom)) || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now)
    throw new Error("The HTTPS certificate is not currently valid.");
  const privateKey = createPrivateKey(key);
  if (!certificate.checkPrivateKey(privateKey)) throw new Error("The private key does not match the server certificate.");
  const type = certificate.publicKey.asymmetricKeyType, details = certificate.publicKey.asymmetricKeyDetails;
  if ((type === "rsa" && (details?.modulusLength ?? 0) < 2048) || !["rsa", "ec", "ed25519", "ed448"].includes(type ?? ""))
    throw new Error("Use a current RSA (2048 bits or greater), EC or EdDSA server certificate.");
  return { options: { cert, key, minVersion: "TLSv1.2" }, info: { fingerprint: certificate.fingerprint256, expires: certificate.validTo } };
}
