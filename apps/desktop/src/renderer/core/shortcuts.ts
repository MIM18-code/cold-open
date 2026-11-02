import type { Command } from "./app.ts";
export type BindingMap = Record<string, string | null>;
const cache = new WeakMap<Command, { value: string | undefined; command: Command }>();
export function resolveCommands(commands: Command[], raw: unknown): Command[] {
  const bindings = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as BindingMap : {};
  return commands.map((command) => {
    if (!Object.prototype.hasOwnProperty.call(bindings,command.id)) return command;
    const bound = bindings[command.id];
    if (bound !== null && (typeof bound !== "string" || bound.length > 80)) return command;
    const value = bound || undefined;
    const previous = cache.get(command);
    if (previous && previous.value === value) return previous.command;
    const resolved = { ...command, accelerator: value };
    cache.set(command,{value,command:resolved}); return resolved;
  });
}
export function canonicalBinding(value: string, mac = true): string {
  const parts=value.trim().split("+");let key=parts.pop()!;
  if(!key&&parts.at(-1)===""){parts.pop();key="Plus";}
  const aliases:Record<string,string>={command:"cmd",meta:"cmd",super:"cmd",control:"ctrl",option:"alt",cmdorctrl:mac?"cmd":"ctrl",commandorcontrol:mac?"cmd":"ctrl"};
  const mods=parts.map((m)=>aliases[m.toLowerCase()]??m.toLowerCase());
  if(mods.some((m)=>!["cmd","ctrl","alt","shift"].includes(m))||new Set(mods).size!==mods.length)throw new Error("Use CmdOrCtrl, Cmd, Ctrl, Alt or Shift modifiers.");
  key=({return:"enter",escape:"esc",arrowup:"up",arrowdown:"down",arrowleft:"left",arrowright:"right"} as Record<string,string>)[key.toLowerCase()]??key.toLowerCase();
  if(!/^(?:[a-z0-9=\-\[\]\/.,;'\\]|f(?:[1-9]|1[0-9]|2[0-4])|up|down|left|right|enter|tab|space|backspace|delete|home|end|pageup|pagedown|esc|plus)$/.test(key))throw new Error("Choose one letter, number, function key or named navigation key.");
  if(!mods.includes("cmd")&&!mods.includes("ctrl")&&!/^f\d+$/.test(key))throw new Error("Use Command or Control so the shortcut does not replace typing, accent entry or normal navigation.");
  return [...["cmd","ctrl","alt","shift"].filter((m)=>mods.includes(m)),key].join("+");
}
export function validateBindings(commands: Command[], bindings: BindingMap): void {
  const ids=new Set(commands.map((c)=>c.id));
  for(const [id,value] of Object.entries(bindings)){
    if(!ids.has(id))throw new Error(`Unknown command: ${id}`);
    if(value!==null&&typeof value!=="string")throw new Error("A binding must be a shortcut or null.");
    if(value){const key=canonicalBinding(value);if(["cmd+c","cmd+x","cmd+v","cmd+a","cmd+q","cmd+tab","ctrl+tab"].includes(key)&&commands.find((c)=>c.id===id)?.accelerator!==value)throw new Error("That shortcut is reserved for standard editing or window navigation.");}
  }
  const keys=new Map<string,Command>();
  for(const command of resolveCommands(commands,bindings)){
    if(!command.accelerator)continue;
    const key=canonicalBinding(command.accelerator);
    const prior=keys.get(key);
    if(prior&&prior.id!==command.id)throw new Error(`Shortcut collision: ${prior.label} and ${command.label}. Clear one binding first.`);
    keys.set(key,command);
  }
}
/** WriterDuet's documented element subset only; unrelated application commands are unchanged. */
export const WRITERDUET_ELEMENTS: BindingMap = {
  "editor.element.sceneHeading":"CmdOrCtrl+1","editor.element.action":"CmdOrCtrl+2","editor.element.character":"CmdOrCtrl+3",
  "editor.element.parenthetical":"CmdOrCtrl+4","editor.element.dialogue":"CmdOrCtrl+5","editor.element.transition":"CmdOrCtrl+6",
  "editor.element.shot":"CmdOrCtrl+7","editor.element.general":"CmdOrCtrl+8","editor.element.note":"CmdOrCtrl+9",
  "editor.element.section":"CmdOrCtrl+0","editor.element.castList":null,"editor.element.lyrics":null,
};
