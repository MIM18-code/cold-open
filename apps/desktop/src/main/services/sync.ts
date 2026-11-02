// Co-writing and folder sync. Hosting starts the embedded relay (src/main/sync/host.ts) only when a writer chooses
// Share for Co-writing; folder sync keeps per-device update logs next to a saved document (src/main/sync/).
import type { WebContents } from "electron";

import { SYNC } from "../../shared/channels/sync.ts";
import type { ServiceContext } from "../context.ts";
import { registerFolderSync } from "../sync/folder-service.ts";
import { Host, fullUserName } from "../sync/host.ts";

const JOIN_HANDOFF_MS = 30_000;

export function register(ctx: ServiceContext): void {
  // Tests bind to loopback so macOS never asks to allow incoming connections.
  const host = new Host(process.env.SCREENPLAY_E2E ? "127.0.0.1" : "0.0.0.0");
  let pendingJoin: { invite: string; at: number } | null = null;
  let userName: Promise<string> | null = null;
  const watched = new WeakSet<WebContents>();

  ctx.handle(SYNC.hostStart, (event) => {
    const contents = event.sender;
    // One listener per window, however many times it shares and stops.
    if (!watched.has(contents)) {
      watched.add(contents);
      contents.once("destroyed", () => void host.stop(contents.id));
    }
    return host.start(contents.id);
  });
  ctx.handle(SYNC.hostStop, (event) => host.stop(event.sender.id));
  ctx.handle(SYNC.userName, () => (userName ??= fullUserName()));

  ctx.handle(SYNC.queueJoin, (_event, invite: string) => {
    if (typeof invite !== "string") throw new Error("An invite is text.");
    pendingJoin = { invite, at: Date.now() };
  });
  ctx.handle(SYNC.takeJoin, () => {
    const join = pendingJoin;
    pendingJoin = null;
    return join && Date.now() - join.at < JOIN_HANDOFF_MS ? join.invite : null;
  });

  // No quit task for the relay: quitting can still be cancelled at a "Save changes?" prompt, and each window stops
  // its own room when it is destroyed, which closes the relay after the last one.
  registerFolderSync(ctx);
}
