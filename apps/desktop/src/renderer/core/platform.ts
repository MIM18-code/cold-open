// The renderer's route to the main process. In Electron this is window.desktop from the preload. In a plain
// browser (vite dev server, tests) a fallback keeps the app usable: settings in localStorage, files through
// download and file inputs, and no native services.
import { CHANNELS, type DesktopBridge, type OpenedFile } from "../../shared/api.ts";
import { confirmResponse } from "./message-box.ts";

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

type Listener = (...args: unknown[]) => void;

function browserBridge(): DesktopBridge {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach((listener) => listener(...args));
  const settings = (): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem("screenplay.settings") ?? "{}");
    } catch {
      return {};
    }
  };
  const memoryFiles = new Map<string, Uint8Array | string>();
  const handlers: Record<string, (...args: any[]) => unknown> = {
    [CHANNELS.settingsGet]: () => settings(),
    [CHANNELS.settingsSet]: (key: string, value: unknown) => {
      const next = settings();
      if (value === undefined || value === null) delete next[key];
      else next[key] = value;
      localStorage.setItem("screenplay.settings", JSON.stringify(next));
      emit(CHANNELS.settingsChanged, key, value);
    },
    [CHANNELS.openDialog]: (options: { multiple?: boolean; filters?: { extensions: string[] }[] } = {}) =>
      new Promise<OpenedFile[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = !!options.multiple;
        const extensions = options.filters?.flatMap((filter) => filter.extensions).filter((ext) => ext !== "*");
        if (extensions?.length) input.accept = extensions.map((ext) => `.${ext}`).join(",");
        input.onchange = async () => {
          const files = await Promise.all([...(input.files ?? [])].map(async (file) => ({
            path: `browser:${file.name}`, name: file.name, data: new Uint8Array(await file.arrayBuffer()),
          })));
          resolve(files);
        };
        input.oncancel = () => resolve([]);
        input.click();
      }),
    [CHANNELS.saveDialog]: (options: { defaultPath?: string } = {}) => {
      const name = window.prompt("Save as", options.defaultPath?.split("/").pop() ?? "Untitled.screenplay");
      return name ? `browser:${name}` : null;
    },
    [CHANNELS.writeFile]: (path: string, data: Uint8Array | string) => {
      memoryFiles.set(path, data);
      const blob = new Blob([typeof data === "string" ? data : new Uint8Array(data)]);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = path.replace(/^browser:/, "");
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    },
    [CHANNELS.readFile]: (path: string) => {
      const data = memoryFiles.get(path);
      if (data === undefined) throw new Error("File not available in the browser.");
      return { path, name: path.replace(/^browser:/, ""), data: typeof data === "string" ? new TextEncoder().encode(data) : data };
    },
    [CHANNELS.recentFiles]: () => [],
    [CHANNELS.addRecent]: () => undefined,
    [CHANNELS.setMenu]: () => undefined,
    [CHANNELS.setWindowState]: (state: { title: string }) => void (document.title = state.title),
    [CHANNELS.closeAllowed]: () => undefined,
    [CHANNELS.newWindow]: () => void window.open(location.pathname, "_blank"),
    [CHANNELS.newTab]: () => void window.open(location.pathname, "_blank"),
    [CHANNELS.openExternal]: (url: string) => void window.open(url, "_blank"),
    "shell:message-box": (options: { message: string; detail?: string; buttons?: string[]; cancelId?: number }) => {
      const buttons = options.buttons ?? ["OK"];
      if (buttons.length <= 1) {
        window.alert([options.message, options.detail].filter(Boolean).join("\n\n"));
        return { response: 0 };
      }
      const action = buttons[confirmResponse(buttons, options.cancelId, true)];
      const text = [options.message, options.detail, `OK: ${action}`].filter(Boolean).join("\n\n");
      return { response: confirmResponse(buttons, options.cancelId, window.confirm(text)) };
    },
  };
  return {
    invoke: async <T,>(channel: string, ...args: unknown[]) => {
      const handler = handlers[channel];
      if (!handler) throw new Error(`${channel} needs the desktop app.`);
      return (await handler(...args)) as T;
    },
    on: (channel, listener) => {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
    spelling: { isMisspelled: () => false, suggestions: () => [], addToDictionary: () => undefined },
    platform: "browser",
  };
}

export const desktop: DesktopBridge = window.desktop ?? browserBridge();
export const isDesktop = !!window.desktop;

/** Show a native message box. Returns the index of the button pressed. */
export async function messageBox(options: {
  message: string; detail?: string; buttons?: string[]; type?: "none" | "info" | "error" | "question" | "warning";
  defaultId?: number; cancelId?: number;
}): Promise<number> {
  const result = await desktop.invoke<{ response: number }>("shell:message-box", options);
  return result.response;
}
