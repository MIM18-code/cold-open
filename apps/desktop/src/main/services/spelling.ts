// The macOS spell checker. Checking happens in the renderer (webFrame); adding words needs the session.
import type { ServiceContext } from "../context.ts";

export function register(ctx: ServiceContext): void {
  ctx.handle("spelling:add-word", (event, word: string) => {
    if (typeof word === "string" && word.length < 64) event.sender.session.addWordToSpellCheckerDictionary(word);
  });
}
