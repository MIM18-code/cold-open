import { parseInvite } from "@screenplay/relay/protocol";
import { LINK_VERSION, linkKeys, linkRoot } from "@screenplay/relay/sealed";

/** Shown for a pairing made on Wi-Fi before links were encrypted. It never connects; its waiting takes can still be sent by AirDrop. */
export const PAIR_AGAIN = "Pair again to encrypt this link";

/**
 * Version 1 codes carry an HTTPS URL (Tailscale) and the iPhone presents the token as a bearer inside TLS.
 * Version 2 codes carry the Mac's Wi-Fi address and a secret: the link is sealed with keys derived from the
 * secret, which is never sent. `restore` reads a code this iPhone saved earlier, which may be from an older Mac.
 */
export function decodePairing(raw: string, now = Date.now(), restore = false) {
  if (raw.length > 3000) throw new Error("This is not a Cold Open pairing code.");
  // Typed or dictated codes may pick up iOS smart punctuation; the code itself never contains curly quotes.
  const data = JSON.parse(raw.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  if (Number.isInteger(data?.v) && data.v > LINK_VERSION) throw new Error("Update Cold Open on this iPhone to use this pairing code.");
  const sealed = data?.v === LINK_VERSION;
  if (sealed ? typeof data.host !== "string" || !/^[\d.]+:\d+$/.test(data.host) || typeof data.secret !== "string"
      : data?.v !== 1 || typeof data.url !== "string") throw new Error("Scan the code in the Mac’s Phone panel.");
  if (typeof data.invite !== "string") throw new Error("Scan the code in the Mac’s Phone panel.");
  const url = new URL(sealed ? `http://${data.host}/#${data.secret}` : data.url);
  const lan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.0\.0\.1$)/;
  const tailIp = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  const tailDns = url.hostname.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(url.hostname);
  const privateIp = lan.test(url.hostname) && /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!/^https?:$/.test(url.protocol) || !(privateIp || (tailIp || tailDns) && url.protocol === "https:")
      || !url.port || url.username || url.password
      || url.pathname !== "/" || url.search || !/^#[\w-]{43}$/.test(url.hash)) {
    throw new Error("The code must point to your Mac on private Wi-Fi or HTTPS over Tailscale.");
  }
  // A version 1 code for a Wi-Fi address comes from a Mac that did not encrypt Wi-Fi links.
  const legacy = !sealed && privateIp;
  if (legacy && !restore) throw new Error("Update Cold Open on your Mac, then pair again. This version encrypts Wi-Fi links.");
  if (sealed && !privateIp) throw new Error("The code must point to your Mac on private Wi-Fi or HTTPS over Tailscale.");
  const invite = parseInvite(data.invite);
  if (!invite.readOnly || invite.relay !== url.origin.replace(/^http/, "ws")) {
    throw new Error("The code must contain a read-only invite to the same Mac.");
  }
  const remembered = data.remembered === true;
  if (remembered && (data.expiresAt !== null || typeof data.deviceId !== "string"
      || !/^[-\w]{12,80}$/.test(data.deviceId) || typeof data.scriptId !== "string"
      || !/^[a-f0-9]{64}$/.test(data.scriptId))) throw new Error("Invalid remembered iPhone pairing.");
  if (!remembered && (!Number.isSafeInteger(data.expiresAt) || data.expiresAt > now + 7200000 + 60000)) {
    throw new Error("Invalid pairing lifetime. Check the time on both devices.");
  }
  if (!remembered && !restore && now >= data.expiresAt) throw new Error("Pairing expired. Start a new link on your Mac.");
  const token = url.hash.slice(1);
  return { invite, origin: url.origin, token, legacy,
    /** Wi-Fi: the sealed link's keys. Tailscale pairings have none and rely on HTTPS. */
    link: sealed ? linkKeys(linkRoot(token)) : undefined,
    remembered, deviceId: remembered ? data.deviceId as string : undefined,
    scriptId: remembered ? data.scriptId as string : undefined,
    expiresAt: remembered ? Number.MAX_SAFE_INTEGER : data.expiresAt as number };
}
export type Pairing = ReturnType<typeof decodePairing>;
