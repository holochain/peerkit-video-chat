import { contextBridge, ipcRenderer } from "electron";

import type {
  IncomingChat,
  RoomStateView,
} from "@peerkit-video-chat/core";

const api = {
  init: (displayName: string): Promise<{ agentId: string }> =>
    ipcRenderer.invoke("chat:init", displayName),
  setDisplayName: (name: string): Promise<void> =>
    ipcRenderer.invoke("chat:setDisplayName", name),
  joinRoom: (name: string): Promise<void> =>
    ipcRenderer.invoke("chat:joinRoom", name),
  leaveRoom: (): Promise<void> => ipcRenderer.invoke("chat:leaveRoom"),
  sendChat: (body: string): Promise<void> =>
    ipcRenderer.invoke("chat:sendChat", body),

  onState: (handler: (view: RoomStateView) => void): (() => void) => {
    const listener = (_event: unknown, view: RoomStateView): void => handler(view);
    ipcRenderer.on("chat:state", listener);
    return () => {
      ipcRenderer.off("chat:state", listener);
    };
  },

  onChat: (handler: (chat: IncomingChat) => void): (() => void) => {
    const listener = (_event: unknown, chat: IncomingChat): void => handler(chat);
    ipcRenderer.on("chat:chat", listener);
    return () => {
      ipcRenderer.off("chat:chat", listener);
    };
  },
};

contextBridge.exposeInMainWorld("app", api);

declare global {
  interface Window {
    app: typeof api;
  }
}
