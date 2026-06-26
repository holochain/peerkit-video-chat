import type { JSX } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useThemedStyles, type Palette } from "../theme";
import type { DeviceKind, ThemePref } from "../types";

interface SettingsSheetProps {
  visible: boolean;
  theme: ThemePref;
  devices: Record<DeviceKind, string>;
  onTheme(theme: ThemePref): void;
  onClose(): void;
}

const THEMES: ThemePref[] = ["system", "light", "dark"];

export function SettingsSheet({
  visible,
  theme,
  devices,
  onTheme,
  onClose,
}: SettingsSheetProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>Settings</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.label}>Theme</Text>
          <View style={styles.segment}>
            {THEMES.map((nextTheme) => (
              <Pressable
                key={nextTheme}
                onPress={() => onTheme(nextTheme)}
                style={[styles.segmentItem, theme === nextTheme && styles.segmentActive]}
              >
                <Text style={styles.segmentText}>{nextTheme}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>Devices</Text>
          <Text style={styles.note}>
            Camera: {devices.camera || "default"}{"\n"}
            Microphone: {devices.microphone || "default"}{"\n"}
            Speaker: {devices.speaker || "default"}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  scrim: {
    backgroundColor: t.scrim,
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: t.surfaceRaised,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    gap: 14,
    padding: 18,
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    color: t.textPrimary,
    fontSize: 20,
    fontWeight: "900",
  },
  close: {
    padding: 8,
  },
  closeText: {
    color: t.accent,
    fontWeight: "800",
  },
  label: {
    color: t.textMuted,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  segment: {
    borderColor: t.borderInput,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    overflow: "hidden",
  },
  segmentItem: {
    alignItems: "center",
    flex: 1,
    paddingVertical: 12,
  },
  segmentActive: {
    backgroundColor: t.accentSurfaceAlt,
  },
  segmentText: {
    color: t.textBright,
    fontWeight: "800",
  },
  note: {
    color: t.textNote,
    fontSize: 13,
    lineHeight: 20,
  },
});
