// Co-writing and folder sync. Hosting starts the embedded relay (src/main/sync/host.ts) only when a writer chooses
// Share for Co-writing; folder sync keeps per-device update logs next to a saved document (src/main/sync/).
import type { WebContents } from "electron";

import { SYNC } from "../../shared/channels/sync.ts";
import type { ServiceContext } from "../context.ts";
import { registerFolderSync } from "../sync/folder-service.ts";
import { Host, fullUserName } from "../sync/host.ts";

export function register(ctx: ServiceContext): void {
  // Tests bind to loopback so macOS never asks to allow incoming connections.
  const host = new Host(process.env.SCREENPLAY_E2E ? "127.0.0.1" : "0.0.0.0");
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

  // No quit task for the relay: quitting can still be cancelled at a "Save changes?" prompt, and each window stops
  // its own room when it is destroyed, which closes the relay after the last one.
  registerFolderSync(ctx);
}
