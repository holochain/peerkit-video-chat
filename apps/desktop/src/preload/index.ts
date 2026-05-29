import { contextBridge, ipcRenderer } from "electron";

import type {
  IncomingChat,
  NetworkRoomEntry,
  PeerStats,
  RoomStateView,
  WebRtcSignal,
} from "@peerkit-video-chat/core";

const api = {
  init: (
    displayName: string,
  ): Promise<{ agentId: string; relayAddr: string; room: RoomStateView }> =>
    ipcRenderer.invoke("chat:init", displayName),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("app:openExternal", url),
  requestMediaAccess: (): Promise<{ camera: boolean; microphone: boolean }> =>
    ipcRenderer.invoke("app:requestMediaAccess"),
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

  onNetworkRooms: (handler: (rooms: NetworkRoomEntry[]) => void): (() => void) => {
    const listener = (_event: unknown, rooms: NetworkRoomEntry[]): void => handler(rooms);
    ipcRenderer.on("chat:networkRooms", listener);
    return () => {
      ipcRenderer.off("chat:networkRooms", listener);
    };
  },

  getPeerStats: (): Promise<PeerStats | null> =>
    ipcRenderer.invoke("chat:peerStats"),

  onPeerStats: (handler: (stats: PeerStats) => void): (() => void) => {
    const listener = (_event: unknown, stats: PeerStats): void => handler(stats);
    ipcRenderer.on("chat:peerStats", listener);
    return () => {
      ipcRenderer.off("chat:peerStats", listener);
    };
  },

  store: {
    load: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("store:load"),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke("store:set", key, value),
  },

  sendSignal: (toAgent: string, signal: WebRtcSignal): Promise<void> =>
    ipcRenderer.invoke("rtc:sendSignal", toAgent, signal),

  onSignal: (
    handler: (fromAgent: string, signal: WebRtcSignal) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      payload: { fromAgent: string; signal: WebRtcSignal },
    ): void => handler(payload.fromAgent, payload.signal);
    ipcRenderer.on("rtc:signal", listener);
    return () => {
      ipcRenderer.off("rtc:signal", listener);
    };
  },
};

contextBridge.exposeInMainWorld("app", api);

export type AppApi = typeof api;

declare global {
  interface Window {
    app: AppApi;
  }
}
