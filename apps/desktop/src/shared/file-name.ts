// Names that end up in a save dialog. A script's name can come from someone else (a co-writing host publishes it and
// the guest's window takes it), and the dialog opens wherever its default path points, so a name such as
// "../../Library/LaunchAgents/agent" would start the writer's Save in a folder the other person chose.

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A name with no path in it: separators become spaces, and it cannot be "." or "..", or start hidden. */
export function plainFileName(name: string): string {
  return name.replace(CONTROL, "").replace(/[/\\]+/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 200);
}

/** The file name a save dialog may start with: the last part of what the page asked for, never a folder. */
export function saveDialogName(defaultPath: unknown): string | undefined {
  if (typeof defaultPath !== "string") return undefined;
  const name = plainFileName(defaultPath.split(/[/\\]/).pop() ?? "");
  return name || undefined;
}
