import {
  MESH_RECOMMENDED_MAX,
  exceedsMeshRecommendation,
  type WebRtcSignal,
} from "@peerkit-video-chat/core";
import type { MediaController, MediaStreamLike } from "@peerkit-video-chat/media";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar, StyleSheet, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { SettingsSheet } from "./components/SettingsSheet";
import { ToastStack } from "./components/ToastStack";
import { Topbar } from "./components/Topbar";
import { useChatNode } from "./hooks/useChatNode";
import { createMobileMediaController } from "./media";
import { CallScreen } from "./screens/CallScreen";
import { IdentityScreen } from "./screens/IdentityScreen";
import { LobbyScreen } from "./screens/LobbyScreen";
import { PreJoinScreen } from "./screens/PreJoinScreen";
import { loadSettings, setStoredValue } from "./storage";
import { paletteFor, ThemeProvider } from "./theme";
import type {
  DeviceKind,
  RoomMember,
  SavedRoom,
  Screen,
  StreamMap,
  ThemePref,
  Toast,
} from "./types";

const DEFAULT_DEVICES: Record<DeviceKind, string> = {
  camera: "",
  microphone: "",
  speaker: "",
};

function toastMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedRoomName(roomName: string): string {
  return roomName.trim().replace(/\s+/g, "-").toLowerCase();
}

export default function App(): JSX.Element {
  const systemScheme = useColorScheme();
  const chat = useChatNode();
  const [screen, setScreen] = useState<Screen>("initializing");
  const [selfName, setSelfName] = useState("");
  const [selfMic, setSelfMic] = useState(true);
  const [selfCam, setSelfCam] = useState(true);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [joinTime, setJoinTime] = useState(0);
  const [savedRooms, setSavedRooms] = useState<SavedRoom[]>([]);
  const [theme, setTheme] = useState<ThemePref>("system");
  const [devices, setDevices] = useState<Record<DeviceKind, string>>(DEFAULT_DEVICES);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStreamLike | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<StreamMap>(new Map());
  const [speakingPeers, setSpeakingPeers] = useState<ReadonlySet<string>>(new Set());
  const knownPeers = useRef(new Set<string>());
  const mediaRef = useRef<MediaController | null>(null);

  const media = useMemo(() => {
    const controller = createMobileMediaController(async (toAgent, signal) => {
      await chat.sendSignal(toAgent, signal);
    });
    mediaRef.current = controller;
    return controller;
  }, [chat.sendSignal]);

  const roomMembers: RoomMember[] =
    chat.state.room.kind === "inRoom" ? chat.state.room.members : [];
  const activeMembers = chat.state.networkRooms.find((room) => room.name === currentRoom)?.members ?? [];
  const themeResolved = theme === "system" ? (systemScheme === "light" ? "light" : "dark") : theme;
  const palette = paletteFor(themeResolved);

  const pushToast = useCallback((message: string, kind: Toast["kind"] = "error") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  useEffect(() => {
    loadSettings()
      .then((settings) => {
        setSavedRooms(settings.savedRooms);
        setTheme(settings.theme);
        setDevices(settings.devices);
        media.setPreferredDevices(settings.devices.camera, settings.devices.microphone);
        if (settings.username) {
          void handleSetUsername(settings.username);
        } else {
          setScreen("identity");
        }
      })
      .catch(() => {
        setScreen("identity");
      });
  }, [media]);

  useEffect(() => {
    media.setStreamCallback((agentId, stream) => {
      setRemoteStreams((prev) => {
        const next = new Map(prev);
        if (stream === null) {
          next.delete(agentId);
        } else {
          next.set(agentId, stream);
        }
        return next;
      });
    });
    media.setSpeakingCallback((agentId, speaking) => {
      setSpeakingPeers((prev) => {
        const next = new Set(prev);
        if (speaking) {
          next.add(agentId);
        } else {
          next.delete(agentId);
        }
        return next;
      });
    });
  }, [media]);

  // Tear down the media controller and chat node when the app unmounts so peer
  // connections and the libp2p node don't outlive the React tree.
  useEffect(() => {
    return () => {
      media.closeAll();
      void chat.shutDown();
    };
    // `media` and `chat.shutDown` are stable for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (screen !== "call") {
      knownPeers.current.clear();
      return;
    }
    const currentIds = new Set(roomMembers.map((member) => member.agentId));
    for (const agentId of Array.from(knownPeers.current)) {
      if (!currentIds.has(agentId)) knownPeers.current.delete(agentId);
    }
    for (const member of roomMembers) {
      if (member.agentId === chat.state.agentId || knownPeers.current.has(member.agentId)) continue;
      knownPeers.current.add(member.agentId);
      if (chat.state.agentId < member.agentId) {
        media.initiateCall(member.agentId).catch((error: unknown) => {
          pushToast(toastMessage(error));
        });
      }
    }
  }, [chat.state.agentId, media, pushToast, roomMembers, screen]);

  // Warn once when a room reaches the comfortable mesh ceiling; re-arm when it
  // drops back below, so growing past the limit warns again but a steady large
  // room doesn't nag on every roster update (mirrors the desktop latch).
  const meshWarned = useRef(false);
  useEffect(() => {
    if (exceedsMeshRecommendation(roomMembers.length)) {
      if (!meshWarned.current) {
        meshWarned.current = true;
        pushToast(
          `${roomMembers.length} people in this room. Calls are smoothest with ${MESH_RECOMMENDED_MAX} or fewer — audio and video quality may drop beyond that.`,
          "warn",
        );
      }
    } else {
      meshWarned.current = false;
    }
  }, [pushToast, roomMembers.length]);

  async function handleSetUsername(name: string): Promise<void> {
    setSelfName(name);
    await setStoredValue("username", name);
    try {
      await chat.start(name, (fromAgent: string, signal: WebRtcSignal) => {
        mediaRef.current?.handleSignal(fromAgent, signal).catch((error: unknown) => {
          console.warn("handleSignal error:", error);
        });
      });
      setScreen("lobby");
    } catch (error) {
      pushToast(toastMessage(error));
      setScreen("identity");
    }
  }

  function handleJoinIntent(roomName: string): void {
    const normalized = normalizedRoomName(roomName);
    if (!normalized.replace(/-/g, "")) return;
    const existing = savedRooms.find((room) => room.name === normalized);
    const nextSaved = existing
      ? [{ ...existing, lastUsed: Date.now() }, ...savedRooms.filter((room) => room.name !== normalized)]
      : [{ name: normalized, lastUsed: Date.now() }, ...savedRooms];
    setSavedRooms(nextSaved);
    void setStoredValue("savedRooms", nextSaved);
    setCurrentRoom(normalized);
    setScreen("prejoin");
  }

  async function handleConfirmJoin(): Promise<void> {
    if (currentRoom === null) return;
    media.setMuted(!selfMic);
    await media.setCamMuted(!selfCam);
    await chat.joinRoom(currentRoom);
    setJoinTime(Date.now());
    setScreen("call");
  }

  async function handleLeave(): Promise<void> {
    await chat.leaveRoom();
    media.closeAll();
    setLocalStream(null);
    setRemoteStreams(new Map());
    setCurrentRoom(null);
    setScreen("lobby");
  }

  function handleToggleMic(): void {
    media.setMuted(selfMic);
    setSelfMic((prev) => !prev);
  }

  async function handleToggleCam(): Promise<void> {
    await media.setCamMuted(selfCam);
    setSelfCam((prev) => !prev);
    setLocalStream(media.getLocalStream());
  }

  function handleSetTheme(nextTheme: ThemePref): void {
    setTheme(nextTheme);
    void setStoredValue("theme", nextTheme);
  }

  function handleRemoveSaved(roomName: string): void {
    const nextSaved = savedRooms.filter((room) => room.name !== roomName);
    setSavedRooms(nextSaved);
    void setStoredValue("savedRooms", nextSaved);
  }

  const appContent = (() => {
    if (screen === "identity") {
      return <IdentityScreen onContinue={(name) => void handleSetUsername(name)} />;
    }
    if (screen === "initializing") {
      return <View style={styles.fill} />;
    }
    if (screen === "lobby") {
      return (
        <LobbyScreen
          selfName={selfName}
          savedRooms={savedRooms}
          activeRooms={chat.state.networkRooms}
          onJoin={handleJoinIntent}
          onRemoveSaved={handleRemoveSaved}
        />
      );
    }
    if (screen === "prejoin" && currentRoom !== null) {
      return (
        <PreJoinScreen
          selfAgentId={chat.state.agentId}
          selfName={selfName}
          roomName={currentRoom}
          selfMic={selfMic}
          selfCam={selfCam}
          activeMembers={activeMembers}
          media={media}
          onToggleMic={handleToggleMic}
          onToggleCam={() => void handleToggleCam()}
          onJoin={() => {
            handleConfirmJoin().catch((error: unknown) => pushToast(toastMessage(error)));
          }}
          onBack={() => {
            setCurrentRoom(null);
            setScreen("lobby");
          }}
          onError={(error) => pushToast(toastMessage(error))}
        />
      );
    }
    if (screen === "call" && currentRoom !== null) {
      return (
        <CallScreen
          selfAgentId={chat.state.agentId}
          selfName={selfName}
          selfMic={selfMic}
          selfCam={selfCam}
          roomName={currentRoom}
          members={roomMembers}
          joinTime={joinTime}
          messages={chat.state.chatMessages}
          localStream={localStream ?? media.getLocalStream()}
          remoteStreams={remoteStreams}
          speakingPeers={speakingPeers}
          onToggleMic={handleToggleMic}
          onToggleCam={() => void handleToggleCam()}
          onLeave={() => {
            handleLeave().catch((error: unknown) => pushToast(toastMessage(error), "warn"));
          }}
          onSendChat={(body) => {
            chat.sendChat(body).catch((error: unknown) => pushToast(toastMessage(error), "warn"));
          }}
        />
      );
    }
    return <View style={styles.fill} />;
  })();

  return (
    <SafeAreaProvider>
      <ThemeProvider palette={palette}>
        <SafeAreaView style={[styles.shell, { backgroundColor: palette.bg }]}>
          <StatusBar barStyle={palette.barStyle} />
          {screen !== "identity" && screen !== "initializing" ? (
            <Topbar
              selfName={selfName}
              relayConnected={chat.state.relayConnected}
              peerStats={chat.state.peerStats}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : null}
          <View style={styles.fill}>{appContent}</View>
          <SettingsSheet
            visible={settingsOpen}
            theme={theme}
            devices={devices}
            onTheme={handleSetTheme}
            onClose={() => setSettingsOpen(false)}
          />
          <ToastStack
            toasts={toasts}
            onDismiss={(id) => setToasts((prev) => prev.filter((toast) => toast.id !== id))}
          />
        </SafeAreaView>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
});
