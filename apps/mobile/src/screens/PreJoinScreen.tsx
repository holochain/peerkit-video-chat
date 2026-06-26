import type { MediaController, MediaStreamLike } from "../media";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { RTCView } from "react-native-webrtc";
import { AvatarMini } from "../components/AvatarMini";
import { makeInitials } from "../lib/identicon";
import { streamUrl } from "../media";
import { useThemedStyles, type Palette } from "../theme";
import type { RoomMember } from "../types";

interface PreJoinScreenProps {
  selfAgentId: string;
  selfName: string;
  roomName: string;
  selfMic: boolean;
  selfCam: boolean;
  activeMembers: RoomMember[];
  media: MediaController;
  onToggleMic(): void;
  onToggleCam(): void;
  onJoin(): void;
  onBack(): void;
  onError(error: unknown): void;
}

export function PreJoinScreen({
  selfAgentId,
  selfName,
  roomName,
  selfMic,
  selfCam,
  activeMembers,
  media,
  onToggleMic,
  onToggleCam,
  onJoin,
  onBack,
  onError,
}: PreJoinScreenProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const [stream, setStream] = useState<MediaStreamLike | null>(null);

  useEffect(() => {
    let active = true;
    media
      .initLocalMedia(selfAgentId)
      .then((localStream) => {
        if (active) setStream(localStream);
      })
      .catch((error: unknown) => {
        if (active) onError(error);
      });
    return () => {
      active = false;
    };
  }, [media, onError, selfAgentId]);

  const url = selfCam ? streamUrl(stream) : null;

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <View>
          <Text style={styles.label}>Joining room</Text>
          <Text style={styles.title}>#{roomName}</Text>
        </View>
        <Pressable onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      </View>
      <View style={styles.preview}>
        {url !== null ? (
          <RTCView mirror objectFit="cover" streamURL={url} style={styles.video} />
        ) : (
          <Text style={styles.initials}>{makeInitials(selfName)}</Text>
        )}
      </View>
      <View style={styles.identity}>
        <AvatarMini seed={selfName} size={24} />
        <Text style={styles.name}>{selfName}</Text>
        <Text style={styles.you}>you</Text>
      </View>
      <View style={styles.controls}>
        <Pressable onPress={onToggleMic} style={[styles.toggle, selfMic && styles.toggleOn]}>
          <Text style={styles.toggleText}>{selfMic ? "Mic on" : "Mic off"}</Text>
        </Pressable>
        <Pressable onPress={onToggleCam} style={[styles.toggle, selfCam && styles.toggleOn]}>
          <Text style={styles.toggleText}>{selfCam ? "Cam on" : "Cam off"}</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>
        {activeMembers.length > 0
          ? `${activeMembers.length} participant${activeMembers.length === 1 ? "" : "s"} already here`
          : "You will be the first participant in this room."}
      </Text>
      <Pressable onPress={onJoin} style={styles.join}>
        <Text style={styles.joinText}>Join call</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      gap: 14,
      padding: 16,
    },
    head: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    label: {
      color: t.accent,
      fontSize: 12,
      fontWeight: "900",
      textTransform: "uppercase",
    },
    title: {
      color: t.textPrimary,
      fontSize: 24,
      fontWeight: "900",
    },
    back: {
      padding: 8,
    },
    backText: {
      color: t.accent,
      fontWeight: "900",
    },
    preview: {
      alignItems: "center",
      aspectRatio: 16 / 10,
      backgroundColor: t.surfaceTile,
      borderRadius: 8,
      justifyContent: "center",
      overflow: "hidden",
    },
    video: {
      height: "100%",
      width: "100%",
    },
    initials: {
      color: t.textBright,
      fontSize: 54,
      fontWeight: "900",
    },
    identity: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    name: {
      color: t.textPrimary,
      fontWeight: "900",
    },
    you: {
      color: t.textMutedAlt,
      fontSize: 12,
    },
    controls: {
      flexDirection: "row",
      gap: 10,
    },
    toggle: {
      alignItems: "center",
      borderColor: t.borderStrong,
      borderRadius: 8,
      borderWidth: 1,
      flex: 1,
      paddingVertical: 13,
    },
    toggleOn: {
      backgroundColor: t.accentSurface,
      borderColor: t.borderAccent,
    },
    toggleText: {
      color: t.textBright,
      fontWeight: "900",
    },
    note: {
      color: t.textMuted,
      fontSize: 14,
    },
    join: {
      alignItems: "center",
      backgroundColor: t.accent,
      borderRadius: 8,
      marginTop: "auto",
      paddingVertical: 15,
    },
    joinText: {
      color: t.onAccent,
      fontSize: 16,
      fontWeight: "900",
    },
  });
