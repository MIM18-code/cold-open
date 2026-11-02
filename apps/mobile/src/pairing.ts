import { parseInvite } from "@screenplay/relay/protocol";

export function decodePairing(raw: string, now = Date.now(), restore = false) {
  if (raw.length > 3000) throw new Error("This is not a Cold Open pairing code.");
  // Typed or dictated codes may pick up iOS smart punctuation; the code itself never contains curly quotes.
  const data = JSON.parse(raw.trim().replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"));
  if (data?.v !== 1 || typeof data.url !== "string" || typeof data.invite !== "string") {
    throw new Error("Scan the code in the Mac’s Phone panel.");
  }
  const url = new URL(data.url);
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
  return { invite, origin: url.origin, token: url.hash.slice(1), secure: url.protocol === "https:",
    remembered, deviceId: remembered ? data.deviceId as string : undefined,
    scriptId: remembered ? data.scriptId as string : undefined,
    expiresAt: remembered ? Number.MAX_SAFE_INTEGER : data.expiresAt as number };
}
export type Pairing = ReturnType<typeof decodePairing>;
