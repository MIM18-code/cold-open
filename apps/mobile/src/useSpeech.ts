import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { NativeModule, requireNativeModule } from "expo";
import { errorText } from "./errors";
import { speechError } from "./speech-errors";

declare class Speech extends NativeModule<{
  result: (e: { text: string }) => void; ended: (e: { error?: string }) => void;
}> {
  authorize(): Promise<boolean>; start(): Promise<void>; finish(): void; cancel(): void;
}
const speech = requireNativeModule<Speech>("InklotLocalSpeech");
export type SpeechPhase = "idle" | "starting" | "listening" | "finishing";

/** On-device dictation. `begin` runs as a take starts; `heard` gets the take's whole transcript so far.
 * Events reach only the screen that started the take, so a hidden screen never receives another's words. */
export function useSpeech(begin: () => void, heard: (text: string) => void) {
  const [phase, setPhase] = useState<SpeechPhase>("idle"), [error, setError] = useState("");
  const held = useRef(false), active = useRef(false), mounted = useRef(true);
  const handlers = useRef({ begin, heard });
  handlers.current = { begin, heard };
  useEffect(() => {
    mounted.current = true;
    const result = speech.addListener("result", e => { if (active.current) handlers.current.heard(e.text); });
    const end = speech.addListener("ended", e => {
      if (!active.current) return;
      active.current = false; held.current = false; setPhase("idle");
      const message = speechError(e.error);
      if (message) setError(message);
    });
    const watch = AppState.addEventListener("change", s => {
      if (s === "background") { held.current = false; if (active.current) speech.finish(); }
    });
    return () => {
      mounted.current = false; held.current = false;
      result.remove(); end.remove(); watch.remove();
      if (active.current) { active.current = false; speech.cancel(); }
    };
  }, []);
  async function start() {
    if (held.current || active.current) return;
    held.current = true; setError(""); setPhase("starting");
    try {
      if (!(await speech.authorize())) throw new Error("Allow microphone and speech access in Settings.");
      if (!mounted.current || !held.current) return;
      handlers.current.begin();
      active.current = true;
      await speech.start();
      if (!mounted.current || !held.current) { speech.finish(); return; }
      setPhase("listening");
    } catch (e) {
      active.current = false; held.current = false;
      if (mounted.current) setError(speechError(errorText(e)) || errorText(e));
    } finally { if (mounted.current && !active.current) setPhase("idle"); }
  }
  function finish() { held.current = false; if (active.current) { setPhase("finishing"); speech.finish(); } }
  return { phase, error, setError, start, finish, toggle: () => active.current || held.current ? finish() : void start(),
    held, active };
}
