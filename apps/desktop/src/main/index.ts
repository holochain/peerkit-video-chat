import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startPeer, type Peer } from "@peerkit-video-chat/core";
import type { AgentId } from "@peerkit/api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let peer: Peer | undefined;
let mainWindow: BrowserWindow | undefined;

function emit(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 480,
    title: "peerkit-video-chat (showcase)",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(
      join(__dirname, "../renderer/index.html"),
    );
  }
}

ipcMain.handle("peer:start", async (_event, listenAddress?: string) => {
  if (peer !== undefined) {
    throw new Error("Peer already started");
  }
  try {
    peer = await startPeer({
      id: "desktop",
      listenAddress,
      onMessage: (fromAgent: AgentId, text: string) => {
        emit("peer:message", { fromAgent, text });
      },
    });
    return { agentId: peer.agentId, listenAddress: peer.listenAddress };
  } catch (err) {
    console.error("peer:start failed:", err);
    throw err;
  }
});

ipcMain.handle("peer:connect", async (_event, remoteAddress: string) => {
  if (peer === undefined) {
    throw new Error("Peer not started");
  }
  await peer.connect(remoteAddress);
});

ipcMain.handle(
  "peer:send",
  async (_event, args: { toAgent: AgentId; text: string }) => {
    if (peer === undefined) {
      throw new Error("Peer not started");
    }
    await peer.sendText(args.toAgent, args.text);
  },
);

app.whenReady().then(() => {
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await peer?.shutDown();
});
