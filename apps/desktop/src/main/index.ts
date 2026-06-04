// Must be imported before @peerkit-video-chat/core so process.env.DEBUG is set
// before libp2p/weald initialises (see logging.ts).
import {
  appendRendererLog,
  closeLogging,
  getLogDir,
  initLogging,
} from "./logging.js";

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
  Menu,
  type MenuItemConstructorOptions,
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
let chatInit: Promise<ChatNode> | undefined;
let mainWindow: BrowserWindow | undefined;
let relayAddr: string | undefined;
// Whether the node has reached a bootstrap relay. Tracked here (not just
// emitted) so chat:init can report the current value to a renderer that
// subscribes after the connect event has already fired.
let relayConnected = false;

function emit(channel: string, payload: unknown): void {
  // Background timers (e.g. the PeerKit peer-stats interval) can fire during
  // quit, after the window's webContents is gone but before chat.shutDown()
  // finishes. `?.` only guards undefined, not a destroyed window — sending to
  // destroyed webContents throws "Object has been destroyed".
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

// Baked-in relay so packaged builds work out of the box. A DNS name (not a raw
// IP) so it survives immutable droplet redeploys, which change the IP. Override
// at runtime with PEERKIT_RELAY_ADDR (e.g. to point at a local dev relay).
const DEFAULT_RELAY_ADDR =
  "/dns4/peerkit-video-chat-demo.holochain.org/tcp/9000/ws";

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

  // Drop the reference once the window is gone so emit() short-circuits.
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("chat:init", async (_event, displayName: string) => {
  if (chat === undefined) {
    // Guard against concurrent init (e.g. a double-click on Continue, which
    // stays enabled) starting two chat nodes: share a single in-flight startup
    // promise so overlapping calls await the same node.
    if (chatInit === undefined) {
      relayAddr = getRelayAddress();
      chatInit = startChatNode({
        bootstrapRelays: [relayAddr],
        displayName,
        events: {
          onState: (view: RoomStateView) => emit("chat:state", view),
          onChat: (incoming: IncomingChat) => emit("chat:chat", incoming),
          onSignal: (fromAgent: string, signal: WebRtcSignal) =>
            emit("rtc:signal", { fromAgent, signal }),
          onMediaState: (fromAgent: string, camera: boolean) =>
            emit("chat:mediaState", { fromAgent, camera }),
        },
        onNetworkRooms: (rooms: NetworkRoomEntry[]) =>
          emit("chat:networkRooms", rooms),
        onPeerStats: (stats: PeerStats) => emit("chat:peerStats", stats),
        onRelayConnected: () => {
          relayConnected = true;
          emit("chat:relayConnected", true);
        },
      });
    }
    chat = await chatInit;
  }
  // Reports live room state too, so a renderer that reloaded mid-call (e.g. on
  // laptop wake) routes straight back into the call instead of the lobby (where
  // re-joining would fail with "already in a room").
  return {
    agentId: chat.agentId,
    relayAddr: relayAddr ?? "",
    relayConnected,
    room: chat.room.getStateView(),
  };
});

ipcMain.handle("chat:peerStats", () => chat?.getPeerStats() ?? null);
ipcMain.handle("chat:relayConnected", () => relayConnected);

ipcMain.handle("chat:setDisplayName", (_event, name: string) => {
  if (chat === undefined) throw new Error("chat node not initialized");
  chat.setDisplayName(name);
});

ipcMain.handle("chat:setCameraState", (_event, on: boolean) => {
  if (chat === undefined) throw new Error("chat node not initialized");
  chat.setCameraState(on);
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

async function openLogsFolder(): Promise<void> {
  const dir = getLogDir();
  if (dir === undefined) return;
  const err = await shell.openPath(dir);
  if (err !== "") console.warn(`main: failed to open logs folder: ${err}`);
}

// Build the application menu, preserving the standard platform roles and adding
// an "Open Logs Folder" item under Help so testers can grab their logs without a
// terminal. setApplicationMenu(null) would drop copy/paste/devtools, so we keep
// the role-based defaults.
function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: "appMenu" as const }]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Open Logs Folder",
          click: () => {
            void openLogsFolder();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    const logPath = await initLogging(app.getPath("logs"));
    console.info(`main: logging to ${logPath}`);
  } catch (err) {
    console.warn("main: failed to initialise file logging:", err);
  }
  buildMenu();
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  // Quit on every platform, including macOS. The usual macOS convention keeps
  // the app running with no window (reopen from the dock), but for this
  // single-window showcase that just looks like the close button "minimised" the
  // app and leaves it stranded in the dock, so closing the window quits.
  app.quit();
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

// Fire-and-forget log lines forwarded from the renderer (webrtc / UI). Uses
// ipcRenderer.send (not invoke) so the renderer never awaits a logging round-trip.
ipcMain.on("app:log", (_event, level: string, line: string) => {
  appendRendererLog(level, line);
});

app.on("before-quit", async () => {
  await chat?.shutDown();
  closeLogging();
});

ipcMain.handle("app:requestMediaAccess", async () => {
  if (process.platform !== "darwin") {
    return { camera: true, microphone: true };
  }
  const camera = await systemPreferences.askForMediaAccess("camera");
  const microphone = await systemPreferences.askForMediaAccess("microphone");
  return { camera, microphone };
});
