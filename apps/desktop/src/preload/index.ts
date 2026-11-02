// Exposes window.desktop to the renderer. The renderer runs sandboxed with context isolation, so this
// small bridge is its only route to the main process.
import { contextBridge, ipcRenderer, webFrame } from "electron";

import type { DesktopBridge } from "../shared/api.ts";

const bridge: DesktopBridge = {
  invoke: async (channel, ...args) => {
    // Electron wraps handler errors as "Error invoking remote method '<channel>': Error: <message>"; keep the message.
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    }
  },
  on: (channel, listener) => {
    const wrapped = (_event: unknown, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  spelling: {
    isMisspelled: (word) => webFrame.isWordMisspelled(word),
    suggestions: (word) => webFrame.getWordSuggestions(word),
    addToDictionary: (word) => void ipcRenderer.invoke("spelling:add-word", word),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("desktop", bridge);
