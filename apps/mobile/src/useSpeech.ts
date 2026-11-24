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
// How long to wait for the recognizer's last words after Stop before giving up on them.
const FINISH_LIMIT = 5000;
export type SpeechPhase = "idle" | "starting" | "listening" | "finishing";

/** On-device dictation. `begin` runs as a take starts; `heard` gets the take's whole transcript so far.
 * Events reach only the screen that started the take, so a hidden screen never receives another's words. */
export function useSpeech(begin: () => void, heard: (text: string) => void) {
  const [phase, setPhase] = useState<SpeechPhase>("idle"), [error, setError] = useState("");
  const held = useRef(false), active = useRef(false), mounted = useRef(true);
  const handlers = useRef({ begin, heard });
  const stall = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Counts presses, so a start the give-up timer abandoned cannot answer for a later press.
  const run = useRef(0), startedBy = useRef(0);
  handlers.current = { begin, heard };
  useEffect(() => {
    mounted.current = true;
    const result = speech.addListener("result", e => { if (active.current) handlers.current.heard(e.text); });
    const end = speech.addListener("ended", e => {
      if (!active.current) return;
      clearTimeout(stall.current);
      active.current = false; held.current = false; setPhase("idle");
      const message = speechError(e.error);
      if (message) setError(message);
    });
    const watch = AppState.addEventListener("change", s => {
      if (s === "background") { held.current = false; if (active.current) { setPhase("finishing"); speech.finish(); giveUpLater(); } }
    });
    return () => {
      mounted.current = false; held.current = false; clearTimeout(stall.current);
      result.remove(); end.remove(); watch.remove();
      if (active.current) { active.current = false; speech.cancel(); }
    };
  }, []);
  async function start() {
    if (held.current || active.current) return;
    clearTimeout(stall.current);
    held.current = true; setError(""); setPhase("starting");
    const mine = ++run.current;
    try {
      if (!(await speech.authorize())) throw new Error("Allow microphone and speech access in Settings.");
      // A release and a new press during authorization: the new press owns `held` and starts the recognizer itself.
      if (mine !== run.current || !mounted.current || !held.current) return;
      handlers.current.begin();
      active.current = true; startedBy.current = mine;
      await speech.start();
      // Stop a recognizer that started late for an abandoned press, unless a newer press has started its own.
      if (mine !== run.current) { if (startedBy.current === mine) speech.finish(); return; }
      if (!mounted.current || !held.current) { speech.finish(); return; }
      setPhase("listening");
    } catch (e) {
      if (mine !== run.current) return;
      clearTimeout(stall.current);
      active.current = false; held.current = false;
      if (mounted.current) setError(speechError(errorText(e)) || errorText(e));
    } finally { if (mounted.current && !active.current && mine === run.current) setPhase("idle"); }
  }
  // A recognizer that never answers after Stop would leave the note read-only. Cancel it; the words heard so far
  // are already in the note.
  function giveUpLater() {
    clearTimeout(stall.current);
    const owner = startedBy.current;
    stall.current = setTimeout(() => {
      if (!active.current || startedBy.current !== owner) return;
      active.current = false; held.current = false; speech.cancel();
      if (mounted.current) setPhase("idle");
    }, FINISH_LIMIT);
  }
  function finish() { held.current = false; if (active.current) { setPhase("finishing"); speech.finish(); giveUpLater(); } }
  return { phase, error, setError, start, finish, toggle: () => active.current || held.current ? finish() : void start(),
    held, active };
}
