import type { JSX } from "react";
import { View, StyleSheet } from "react-native";
import { identiconCells, peerColorFromId } from "../lib/identicon";
import { useThemedStyles, type Palette } from "../theme";

interface AvatarMiniProps {
  // Stable identity seed for the identicon. Prefer the display name so the
  // avatar stays the same across runs instead of tracking the per-start key.
  seed: string;
  size?: number;
}

export function AvatarMini({ seed, size = 28 }: AvatarMiniProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const cellSize = size / 5;
  const color = peerColorFromId(seed);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      {identiconCells(seed).map((cell, index) => (
        <View
          key={`${cell.x}-${cell.y}-${index}`}
          style={[
            styles.cell,
            {
              backgroundColor: color,
              height: cellSize,
              left: cell.x * cellSize,
              top: cell.y * cellSize,
              width: cellSize,
            },
          ]}
        />
      ))}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  avatar: {
    backgroundColor: t.avatar,
    borderColor: t.borderStrong,
    borderWidth: 1,
    overflow: "hidden",
  },
  cell: {
    position: "absolute",
  },
});
