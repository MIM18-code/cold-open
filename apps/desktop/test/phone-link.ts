// What a paired iPhone does on home Wi-Fi, for tests: sealed calls to the Mac from a version 2 pairing code.
import assert from "node:assert/strict";
import { LinkClient, linkKeys, linkRoot } from "@screenplay/relay/sealed";

export function phoneLink(pairing: string) {
  const code = JSON.parse(pairing) as { v: number; host: string; secret: string; invite: string };
  assert.equal(code.v, 2, "a home Wi-Fi pairing code is version 2");
  const origin = `http://${code.host}`, keys = linkKeys(linkRoot(code.secret));
  const client = new LinkClient(keys, async body => {
    const response = await fetch(origin + "/link", { method: "POST", headers: { "content-type": "text/plain" }, body });
    if (!response.ok) throw new Error(`The Mac refused the sealed request (${response.status}).`);
    return response.text();
  });
  return {
    origin, keys, secret: code.secret, invite: code.invite,
    get: (path: string) => client.call("GET", path),
    post: (path: string, body: unknown) => client.call("POST", path, body),
  };
}
