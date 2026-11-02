// Matching a key press against an Electron accelerator string ("CmdOrCtrl+Shift+E"). The renderer uses it for
// commands the native menu does not own, and the main process for the menu's own accelerators (src/main/index.ts).

export interface KeyPress {
  /** KeyboardEvent.key, or Electron's input.key. */
  key: string;
  /** KeyboardEvent.code, or Electron's input.code ("KeyB", "Digit1"). */
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  /** Input-method composition owns its keys; native menu routing must not steal them. */
  composing?: boolean;
}

const CODE_NAMES: Record<string, string> = { equal: "=", minus: "-", comma: ",", semicolon: ";", period: ".", slash: "/" };

export function matchesKey(press: KeyPress, accelerator: string, mac: boolean): boolean {
  if (press.composing || press.key === "Process") return false;
  const parts = accelerator.split("+");
  let key = parts.pop()!.toLowerCase();
  // "CmdOrCtrl++" names the plus key: the split leaves an empty string before it.
  if (key === "" && parts.at(-1) === "") (parts.pop(), (key = "plus"));
  key = ({ up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", esc: "escape", return: "enter", space: " " } as Record<string, string>)[key] ?? key;
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  const either = mods.has("cmdorctrl") || mods.has("commandorcontrol");
  const wantMeta = mods.has("cmd") || mods.has("command") || mods.has("meta") || mods.has("super") || (mac && either);
  const wantCtrl = mods.has("ctrl") || mods.has("control") || (!mac && either);
  if (press.meta !== wantMeta || press.control !== wantCtrl) return false;
  if (press.alt !== (mods.has("alt") || mods.has("option"))) return false;
  if (press.shift !== mods.has("shift")) return false;
  const pressed = press.key.toLowerCase();
  if (key === "plus") return pressed === "+";
  if (pressed === key) return true;
  // Option changes the character a key types on a Mac (Option+F types "ƒ"), and some layouts put other characters
  // on the digit row (AZERTY's "&" on 1), so then the physical key counts. A plain character the layout typed is
  // what the writer meant: on Dvorak, Cmd+; sits where QWERTY has Z and must not run Undo.
  const typedPlain = /^[\x21-\x7e]$/.test(press.key) && !/^(Digit|Numpad)/.test(press.code);
  if (typedPlain) return false;
  const physical = press.code.replace(/^(Key|Digit|Numpad)/, "").toLowerCase();
  return physical === key || CODE_NAMES[physical] === key;
}
