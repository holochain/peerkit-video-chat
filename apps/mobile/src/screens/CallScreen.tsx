import { Feather } from "@expo/vector-icons";
import type { MediaStreamLike } from "@peerkit-video-chat/media";
import { useKeepAwake } from "expo-keep-awake";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { RTCView } from "react-native-webrtc";
import { AvatarMini } from "../components/AvatarMini";
import { ChatOverlay } from "../components/ChatOverlay";
import { makeInitials } from "../lib/identicon";
import { streamUrl } from "../media";
import { useThemedStyles, useTheme, type Palette } from "../theme";
import type { ChatMessage, RoomMember, StreamMap } from "../types";

interface CallScreenProps {
  selfAgentId: string;
  selfName: string;
  selfMic: boolean;
  selfCam: boolean;
  roomName: string;
  members: RoomMember[];
  joinTime: number;
  messages: ChatMessage[];
  localStream: MediaStreamLike | null;
  remoteStreams: StreamMap;
  speakingPeers: ReadonlySet<string>;
  onToggleMic(): void;
  onToggleCam(): void;
  onLeave(): void;
  onSendChat(body: string): void;
}

interface Tile {
  agentId: string;
  displayName: string;
  isSelf: boolean;
}

export function CallScreen({
  selfAgentId,
  selfName,
  selfMic,
  selfCam,
  roomName,
  members,
  joinTime,
  messages,
  localStream,
  remoteStreams,
  speakingPeers,
  onToggleMic,
  onToggleCam,
  onLeave,
  onSendChat,
}: CallScreenProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  // Hold the device awake for the whole call so the screen never dims mid-talk.
  useKeepAwake();
  const [chatOpen, setChatOpen] = useState(false);
  // Re-render every second so the call-duration timer advances live.
  const [now, setNow] = useState(joinTime);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const tiles = useMemo<Tile[]>(
    () => [
      { agentId: selfAgentId, displayName: selfName, isSelf: true },
      ...members
        .filter((member) => member.agentId !== selfAgentId)
        .map((member) => ({ ...member, isSelf: false })),
    ],
    [members, selfAgentId, selfName],
  );

  const elapsed = Math.max(0, Math.floor((now - joinTime) / 1000));
  const timer = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  function tileStream(tile: Tile): MediaStreamLike | null {
    return tile.isSelf ? localStream : remoteStreams.get(tile.agentId) ?? null;
  }

  const columns = tiles.length <= 1 ? 1 : 2;

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <View>
          <Text style={styles.label}>In room</Text>
          <Text style={styles.room}>#{roomName}</Text>
        </View>
        <Text style={styles.timer}>{timer}</Text>
      </View>

      <FlatList
        // FlatList cannot change numColumns on the fly; remount it via key when
        // the column count flips (1 tile -> single column, 2+ -> two columns).
        key={columns}
        contentContainerStyle={styles.grid}
        data={tiles}
        keyExtractor={(tile) => tile.agentId}
        numColumns={columns}
        renderItem={({ item }) => {
          const url = streamUrl(tileStream(item));
          const hasVideo = item.isSelf ? selfCam && url !== null : url !== null;
          const speaking = speakingPeers.has(item.agentId);
          return (
            <View style={[styles.tile, speaking && styles.speaking]}>
              {hasVideo && url !== null ? (
                <RTCView
                  mirror={item.isSelf}
                  objectFit="cover"
                  streamURL={url}
                  style={styles.video}
                />
              ) : (
                <Text style={styles.initials}>{makeInitials(item.displayName)}</Text>
              )}
              <View style={styles.tileMeta}>
                <AvatarMini seed={item.displayName} size={20} />
                <Text numberOfLines={1} style={styles.tileName}>{item.displayName}</Text>
                {item.isSelf && !selfMic ? <Text style={styles.muted}>muted</Text> : null}
              </View>
            </View>
          );
        }}
      />

      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selfMic ? "Mute microphone" : "Unmute microphone"}
          onPress={onToggleMic}
          style={[styles.control, selfMic ? styles.controlOn : styles.controlOff]}
        >
          <Feather
            color={selfMic ? t.textBright : t.dangerText}
            name={selfMic ? "mic" : "mic-off"}
            size={22}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selfCam ? "Turn camera off" : "Turn camera on"}
          onPress={onToggleCam}
          style={[styles.control, selfCam ? styles.controlOn : styles.controlOff]}
        >
          <Feather
            color={selfCam ? t.textBright : t.dangerText}
            name={selfCam ? "video" : "video-off"}
            size={22}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open room chat"
          onPress={() => setChatOpen(true)}
          style={styles.control}
        >
          <Feather color={t.textBright} name="message-square" size={22} />
          {messages.length > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{messages.length}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Leave call"
          onPress={onLeave}
          style={[styles.control, styles.leave]}
        >
          <Feather color={t.dangerText} name="phone-off" size={22} />
        </Pressable>
      </View>

      {chatOpen ? (
        <ChatOverlay
          messages={messages}
          selfAgentId={selfAgentId}
          onClose={() => setChatOpen(false)}
          onSend={onSendChat}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
    },
    head: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      padding: 14,
    },
    label: {
      color: t.accent,
      fontSize: 11,
      fontWeight: "900",
      textTransform: "uppercase",
    },
    room: {
      color: t.textPrimary,
      fontSize: 20,
      fontWeight: "900",
    },
    timer: {
      color: t.textBright2,
      fontSize: 15,
      fontWeight: "900",
    },
    grid: {
      flexGrow: 1,
      gap: 10,
      justifyContent: "center",
      padding: 10,
    },
    tile: {
      alignItems: "center",
      aspectRatio: 1,
      backgroundColor: t.surfaceTile,
      borderColor: t.borderTile,
      borderRadius: 8,
      borderWidth: 1,
      flex: 1,
      justifyContent: "center",
      margin: 5,
      overflow: "hidden",
    },
    speaking: {
      borderColor: t.accent,
      borderWidth: 2,
    },
    video: {
      height: "100%",
      width: "100%",
    },
    initials: {
      color: t.textBright,
      fontSize: 42,
      fontWeight: "900",
    },
    tileMeta: {
      alignItems: "center",
      backgroundColor: t.tileScrim,
      bottom: 8,
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      left: 8,
      maxWidth: "88%",
      padding: 6,
      position: "absolute",
    },
    tileName: {
      color: t.tileText,
      flexShrink: 1,
      fontSize: 12,
      fontWeight: "900",
    },
    muted: {
      color: t.danger,
      fontSize: 10,
      fontWeight: "900",
    },
    controls: {
      alignItems: "center",
      borderTopColor: t.border,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 16,
      justifyContent: "center",
      paddingHorizontal: 10,
      paddingVertical: 14,
    },
    control: {
      alignItems: "center",
      backgroundColor: t.surfaceTile,
      borderColor: t.borderStrong,
      borderRadius: 28,
      borderWidth: 1,
      height: 56,
      justifyContent: "center",
      width: 56,
    },
    controlOn: {
      backgroundColor: t.accentSurface,
      borderColor: t.borderAccent,
    },
    controlOff: {
      backgroundColor: t.dangerSurface,
      borderColor: t.dangerBorder,
    },
    badge: {
      alignItems: "center",
      backgroundColor: t.accent,
      borderRadius: 9,
      justifyContent: "center",
      minWidth: 18,
      paddingHorizontal: 4,
      position: "absolute",
      right: 6,
      top: 6,
    },
    badgeText: {
      color: t.onAccent,
      fontSize: 10,
      fontWeight: "900",
    },
    leave: {
      backgroundColor: t.dangerSurface,
      borderColor: t.dangerBorder,
    },
  });
