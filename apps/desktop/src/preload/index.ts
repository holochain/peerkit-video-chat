import { contextBridge, ipcRenderer } from "electron";

const api = {
  start: (listenAddress?: string): Promise<{ agentId: string; listenAddress?: string }> =>
    ipcRenderer.invoke("peer:start", listenAddress),
  connect: (remoteAddress: string): Promise<void> =>
    ipcRenderer.invoke("peer:connect", remoteAddress),
  send: (toAgent: string, text: string): Promise<void> =>
    ipcRenderer.invoke("peer:send", { toAgent, text }),
  onMessage: (handler: (msg: { fromAgent: string; text: string }) => void): (() => void) => {
    const listener = (_event: unknown, msg: { fromAgent: string; text: string }): void =>
      handler(msg);
    ipcRenderer.on("peer:message", listener);
    return () => {
      ipcRenderer.off("peer:message", listener);
    };
  },
};

contextBridge.exposeInMainWorld("peer", api);

declare global {
  interface Window {
    peer: typeof api;
  }
}
