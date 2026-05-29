import Store from "electron-store";

import {
  startChatNode,
  type ChatNode,
  type IncomingChat,
  type NetworkRoomEntry,
  type PeerStats,
  type RoomStateView,
  type WebRtcSignal,
} from "@peerkit-video-chat/core";
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  systemPreferences,
} from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface StoreSchema {
  username: string;
  savedRooms: Array<{ name: string; lastUsed: number }>;
  theme: "system" | "light" | "dark";
  devices: { camera: string; microphone: string; speaker: string };
}

// Clean, stable app name for the userData directory and window title. NOTE:
// this does NOT control the Linux window identity used for taskbar icon
// matching — on Wayland Electron reads the window app_id from the bundled
// package.json "name" during native startup, before this JS runs. The packaged
// build pins that name to "peerkit-video-chat" via electron-builder's
// extraMetadata so the Wayland app_id matches the installed
// peerkit-video-chat.desktop and the icon resolves. Set before Store reads
// userData.
app.setName("peerkit-video-chat");

const store = new Store<StoreSchema>();

let chat: ChatNode | undefined;
let mainWindow: BrowserWindow | undefined;
let relayAddr: string | undefined;

function emit(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

// Baked-in relay so packaged builds work out of the box. Override at runtime
// with PEERKIT_RELAY_ADDR (e.g. to point at a local dev relay).
const DEFAULT_RELAY_ADDR = "/ip4/178.62.198.220/tcp/9000/ws";

function getRelayAddress(): string {
  const addr = process.env["PEERKIT_RELAY_ADDR"]?.trim();
  if (addr === undefined || addr === "") return DEFAULT_RELAY_ADDR;
  return addr;
}

async function createWindow(): Promise<void> {
  // Allow audio and video media in the renderer — Electron 20+ denies by default.
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => permission === "media",
  );
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(permission === "media");
    },
  );

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: "#0c0a18",
    title: "peerkit-video-chat (showcase)",
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("chat:init", async (_event, displayName: string) => {
  if (chat !== undefined) {
    // Node already running — e.g. the renderer reloaded on laptop wake while
    // the chat node kept its room membership. Report the live room state so the
    // UI can route straight back into the active call instead of the lobby
    // (where re-joining would fail with "already in a room").
    return {
      agentId: chat.agentId,
      relayAddr: relayAddr ?? "",
      room: chat.room.getStateView(),
    };
  }
  relayAddr = getRelayAddress();
  chat = await startChatNode({
    bootstrapRelays: [relayAddr],
    displayName,
    events: {
      onState: (view: RoomStateView) => emit("chat:state", view),
      onChat: (incoming: IncomingChat) => emit("chat:chat", incoming),
      onSignal: (fromAgent: string, signal: WebRtcSignal) =>
        emit("rtc:signal", { fromAgent, signal }),
    },
    onNetworkRooms: (rooms: NetworkRoomEntry[]) =>
      emit("chat:networkRooms", rooms),
    onPeerStats: (stats: PeerStats) => emit("chat:peerStats", stats),
  });
  return { agentId: chat.agentId, relayAddr, room: chat.room.getStateView() };
});

ipcMain.handle("chat:peerStats", () => chat?.getPeerStats() ?? null);

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

ipcMain.handle(
  "rtc:sendSignal",
  async (_event, toAgent: string, signal: WebRtcSignal) => {
    if (chat === undefined) throw new Error("chat node not initialized");
    await chat.sendSignal(toAgent, signal);
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

ipcMain.handle("store:load", () => store.store);

ipcMain.handle("store:set", (_event, key: string, value: unknown) => {
  store.set(key as keyof StoreSchema, value as StoreSchema[keyof StoreSchema]);
});

ipcMain.handle("app:openExternal", async (_event, url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked non-http(s) URL: ${parsed.protocol}`);
  }
  await shell.openExternal(url);
});

app.on("before-quit", async () => {
  await chat?.shutDown();
});

ipcMain.handle("app:requestMediaAccess", async () => {
  if (process.platform !== "darwin") {
    return { camera: true, microphone: true };
  }
  const camera = await systemPreferences.askForMediaAccess("camera");
  const microphone = await systemPreferences.askForMediaAccess("microphone");
  return { camera, microphone };
});
