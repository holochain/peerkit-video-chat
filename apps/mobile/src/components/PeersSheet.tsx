import type { PeerInfo, PeerStats } from "@peerkit-video-chat/core";
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemedStyles, type Palette } from "../theme";

interface PeersSheetProps {
  visible: boolean;
  peerStats: PeerStats | null;
  onClose(): void;
}

type PeerStatus = "direct" | "relayed" | "discovered";

const STATUS_COLOR: Record<PeerStatus, string> = {
  direct: "#34d399",
  relayed: "#fbbf24",
  discovered: "#8782a5",
};

function peerStatus(peer: PeerInfo): PeerStatus {
  if (!peer.connected) {
    return "discovered";
  }
  return peer.direct ? "direct" : "relayed";
}

function sortPeers(peers: readonly PeerInfo[]): PeerInfo[] {
  return [...peers].sort((a, b) => {
    if (a.connected !== b.connected) {
      return a.connected ? -1 : 1;
    }
    return (a.displayName ?? "").localeCompare(b.displayName ?? "");
  });
}

export function PeersSheet({ visible, peerStats, onClose }: PeersSheetProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const peers = peerStats ? sortPeers(peerStats.peers) : [];
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable
          style={[styles.panel, { top: insets.top + 58 + 6, right: 14 + insets.right }]}
          onPress={(event) => event.stopPropagation()}
        >
          <View style={styles.head}>
            <Text style={styles.headMain}>
              <Text style={styles.headStrong}>{peerStats?.connected ?? 0}</Text> connected
            </Text>
            <Text style={styles.headSub}>
              {peerStats?.direct ?? 0} direct · {peerStats?.relayed ?? 0} relayed
            </Text>
            <Text style={styles.headSub}>{peerStats?.discovered ?? 0} in agent store</Text>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {peers.length === 0 ? (
              <Text style={styles.empty}>No peers yet</Text>
            ) : (
              peers.map((peer) => {
                const status = peerStatus(peer);
                return (
                  <View key={peer.agentId} style={styles.row}>
                    <View style={[styles.dot, { backgroundColor: STATUS_COLOR[status] }]} />
                    <View style={styles.idBlock}>
                      <Text numberOfLines={1} style={styles.peerName}>
                        {peer.displayName ?? "unknown"}
                      </Text>
                      <Text numberOfLines={1} style={styles.peerId}>
                        {peer.agentId.slice(0, 16)}
                      </Text>
                    </View>
                    <Text style={[styles.badge, { color: STATUS_COLOR[status] }]}>{status}</Text>
                  </View>
                );
              })
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  scrim: {
    flex: 1,
  },
  panel: {
    backgroundColor: t.surfaceRaised,
    borderColor: t.border,
    borderRadius: 10,
    borderWidth: 1,
    maxHeight: 360,
    position: "absolute",
    width: 280,
  },
  head: {
    borderBottomColor: t.border,
    borderBottomWidth: 1,
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  headMain: {
    color: t.textMuted,
    fontSize: 13,
    fontWeight: "700",
  },
  headStrong: {
    color: t.textPrimary,
    fontWeight: "900",
  },
  headSub: {
    color: t.textMutedAlt,
    fontSize: 11,
    fontWeight: "600",
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    padding: 6,
  },
  row: {
    alignItems: "center",
    borderRadius: 7,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  dot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  idBlock: {
    flex: 1,
    minWidth: 0,
  },
  peerName: {
    color: t.textPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  peerId: {
    color: t.textMutedAlt,
    fontSize: 10,
  },
  badge: {
    fontSize: 10,
    fontWeight: "700",
  },
  empty: {
    color: t.textMutedAlt,
    paddingVertical: 10,
    textAlign: "center",
  },
});
