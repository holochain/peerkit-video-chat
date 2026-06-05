import type { NetworkRoomEntry } from "@peerkit-video-chat/core";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AvatarMini } from "../components/AvatarMini";
import { useThemedStyles, useTheme, type Palette } from "../theme";
import type { SavedRoom } from "../types";

interface LobbyScreenProps {
  selfName: string;
  savedRooms: SavedRoom[];
  activeRooms: NetworkRoomEntry[];
  onJoin(roomName: string): void;
  onRemoveSaved(roomName: string): void;
}

function sanitizeRoomName(value: string): string {
  return value.trim().replace(/\s+/g, "-").toLowerCase();
}

export function LobbyScreen({
  selfName,
  savedRooms,
  activeRooms,
  onJoin,
  onRemoveSaved,
}: LobbyScreenProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  const [draft, setDraft] = useState("");
  const savedNames = useMemo(() => new Set(savedRooms.map((room) => room.name)), [savedRooms]);
  const liveNames = useMemo(() => new Set(activeRooms.map((room) => room.name)), [activeRooms]);
  const liveRooms = useMemo(
    () =>
      [...activeRooms].sort((a, b) => {
        const savedDelta = Number(!savedNames.has(a.name)) - Number(!savedNames.has(b.name));
        return savedDelta !== 0 ? savedDelta : b.members.length - a.members.length;
      }),
    [activeRooms, savedNames],
  );
  const offlineSaved = savedRooms.filter((room) => !liveNames.has(room.name));

  function submit(): void {
    const room = sanitizeRoomName(draft);
    if (!room.replace(/-/g, "")) return;
    setDraft("");
    onJoin(room);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>
          {activeRooms.length} live / {savedRooms.length} saved
        </Text>
        <Text style={styles.title}>Hey {selfName}, where to?</Text>
      </View>
      <View style={styles.joinRow}>
        <Text style={styles.hash}>#</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={48}
          onChangeText={(value) => setDraft(sanitizeRoomName(value))}
          placeholder="room-name"
          placeholderTextColor={t.textFaint}
          style={styles.input}
          value={draft}
        />
        <Pressable disabled={!draft.trim()} onPress={submit} style={styles.joinButton}>
          <Text style={styles.joinText}>Join</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Live now</Text>
      <FlatList
        data={liveRooms}
        keyExtractor={(room) => `live-${room.name}`}
        ListEmptyComponent={<Text style={styles.empty}>No one is in a room right now.</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => onJoin(item.name)} style={styles.room}>
            <View style={styles.roomMain}>
              <Text style={styles.roomName}>#{item.name}</Text>
              <Text style={styles.roomMeta}>{item.members.length} participants</Text>
            </View>
            <View style={styles.avatarStack}>
              {item.members.slice(0, 4).map((member) => (
                <AvatarMini key={member.agentId} seed={member.displayName} size={24} />
              ))}
            </View>
          </Pressable>
        )}
        style={styles.list}
      />

      <Text style={styles.section}>Saved rooms</Text>
      <FlatList
        data={offlineSaved}
        keyExtractor={(room) => `saved-${room.name}`}
        ListEmptyComponent={<Text style={styles.empty}>Rooms you join will show up here.</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => onJoin(item.name)} style={styles.room}>
            <View style={styles.roomMain}>
              <Text style={styles.roomName}>#{item.name}</Text>
              <Text style={styles.roomMeta}>empty</Text>
            </View>
            <Pressable onPress={() => onRemoveSaved(item.name)} style={styles.remove}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </Pressable>
        )}
        style={styles.list}
      />
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      gap: 12,
      padding: 16,
    },
    head: {
      gap: 5,
      paddingTop: 6,
    },
    eyebrow: {
      color: t.accent,
      fontSize: 12,
      fontWeight: "900",
      textTransform: "uppercase",
    },
    title: {
      color: t.textPrimary,
      fontSize: 25,
      fontWeight: "900",
    },
    joinRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    hash: {
      color: t.accent,
      fontSize: 22,
      fontWeight: "900",
    },
    input: {
      backgroundColor: t.surfaceInput,
      borderColor: t.borderInput,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      flex: 1,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 11,
    },
    joinButton: {
      backgroundColor: t.accent,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    joinText: {
      color: t.onAccent,
      fontWeight: "900",
    },
    section: {
      color: t.textPrimary,
      fontSize: 17,
      fontWeight: "900",
      marginTop: 8,
    },
    list: {
      maxHeight: 220,
    },
    empty: {
      color: t.textMutedAlt,
      fontSize: 13,
      padding: 12,
    },
    room: {
      alignItems: "center",
      backgroundColor: t.surfaceTile,
      borderColor: t.borderTile,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 8,
      padding: 12,
    },
    roomMain: {
      flex: 1,
    },
    roomName: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "900",
    },
    roomMeta: {
      color: t.textMutedAlt,
      fontSize: 12,
      marginTop: 3,
    },
    avatarStack: {
      flexDirection: "row",
      gap: -6,
    },
    remove: {
      padding: 8,
    },
    removeText: {
      color: t.danger,
      fontSize: 12,
      fontWeight: "800",
    },
  });
