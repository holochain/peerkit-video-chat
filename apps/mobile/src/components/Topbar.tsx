import type { PeerStats } from "@peerkit-video-chat/core";
import { Feather } from "@expo/vector-icons";
import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme, useThemedStyles, type Palette } from "../theme";
import { AvatarMini } from "./AvatarMini";

interface TopbarProps {
  selfName: string;
  relayConnected: boolean;
  peerStats: PeerStats | null;
  onOpenPeers(): void;
  onOpenSettings(): void;
}

export function Topbar({
  selfName,
  relayConnected,
  peerStats,
  onOpenPeers,
  onOpenSettings,
}: TopbarProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const palette = useTheme();
  const onlineCount = peerStats?.peers.length ?? 0;
  return (
    <View style={styles.bar}>
      <View style={styles.identity}>
        <AvatarMini seed={selfName} size={28} />
        <View>
          <Text numberOfLines={1} style={styles.name}>{selfName}</Text>
          <Text style={styles.meta}>{relayConnected ? "relay online" : "relay pending"}</Text>
        </View>
      </View>
      <View style={styles.right}>
        <Pressable
          onPress={onOpenPeers}
          style={styles.peers}
          accessibilityRole="button"
          accessibilityLabel={`${onlineCount} peers online, show details`}
        >
          <Feather name="users" size={15} color={palette.accentBright} />
          <Text style={styles.peersCount}>{onlineCount}</Text>
          <Text style={styles.peersLabel}>online</Text>
        </Pressable>
        <Pressable onPress={onOpenSettings} style={styles.settings}>
          <Text style={styles.settingsText}>Settings</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  bar: {
    alignItems: "center",
    backgroundColor: t.topbar,
    borderBottomColor: t.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 58,
    paddingHorizontal: 14,
  },
  identity: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 10,
  },
  name: {
    color: t.textPrimary,
    fontSize: 15,
    fontWeight: "800",
    maxWidth: 160,
  },
  meta: {
    color: t.textMutedAlt,
    fontSize: 11,
    fontWeight: "700",
  },
  right: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  peers: {
    alignItems: "center",
    borderColor: t.borderStrong,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  peersCount: {
    color: t.accentBright,
    fontSize: 12,
    fontWeight: "800",
  },
  peersLabel: {
    color: t.textMutedAlt,
    fontSize: 11,
    fontWeight: "700",
  },
  settings: {
    borderColor: t.borderStrong,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  settingsText: {
    color: t.textBright,
    fontSize: 12,
    fontWeight: "800",
  },
});
