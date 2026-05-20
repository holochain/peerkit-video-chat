import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain } from "electron";

import {
  startChatNode,
  type ChatNode,
  type IncomingChat,
  type RoomStateView,
} from "@peerkit-video-chat/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let chat: ChatNode | undefined;
let mainWindow: BrowserWindow | undefined;

function emit(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function getRelayAddress(): string {
  const addr = process.env["PEERKIT_RELAY_ADDR"]?.trim();
  if (addr === undefined || addr === "") {
    throw new Error(
      "No relay address. Set PEERKIT_RELAY_ADDR to a bootstrap relay multiaddr " +
        "(the dev relay prints one to copy: `npm run dev:relay`).",
    );
  }
  return addr;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    title: "peerkit-video-chat (showcase)",
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("chat:init", async (_event, displayName: string) => {
  if (chat !== undefined) {
    return { agentId: chat.agentId };
  }
  const relayAddress = getRelayAddress();
  chat = await startChatNode({
    bootstrapRelays: [relayAddress],
    displayName,
    events: {
      onState: (view: RoomStateView) => emit("chat:state", view),
      onChat: (incoming: IncomingChat) => emit("chat:chat", incoming),
    },
  });
  return { agentId: chat.agentId };
});

ipcMain.handle("chat:setDisplayName", (_event, name: string) => {
  if (chat === undefined) throw new Error("chat node not initialized");
  chat.setDisplayName(name);
});

ipcMain.handle("chat:joinRoom", async (_event, name: string) => {
  if (chat === undefined) throw new Error("chat node not initialized");
  await chat.room.join(name);
});

ipcMain.handle("chat:leaveRoom", async () => {
  if (chat === undefined) throw new Error("chat node not initialized");
  await chat.room.leave();
});

ipcMain.handle("chat:sendChat", async (_event, body: string) => {
  if (chat === undefined) throw new Error("chat node not initialized");
  await chat.room.sendChat(body);
});

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
  await chat?.shutDown();
});
