import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useThemedStyles, type Palette } from "../theme";
import type { Toast } from "../types";

interface ToastStackProps {
  toasts: Toast[];
  onDismiss(id: string): void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps): JSX.Element | null {
  const styles = useThemedStyles(makeStyles);
  if (toasts.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={styles.stack}>
      {toasts.map((toast) => (
        <Pressable
          key={toast.id}
          onPress={() => onDismiss(toast.id)}
          style={[
            styles.toast,
            toast.kind === "warn" ? styles.warn : null,
            toast.kind === "info" ? styles.info : null,
          ]}
        >
          <Text style={styles.message}>{toast.message}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  stack: {
    bottom: 18,
    gap: 8,
    left: 16,
    position: "absolute",
    right: 16,
  },
  toast: {
    backgroundColor: t.dangerSurface,
    borderColor: t.dangerBorder,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  warn: {
    backgroundColor: t.warnSurface,
    borderColor: t.warnBorder,
  },
  info: {
    backgroundColor: t.accentSurface,
    borderColor: t.borderAccent,
  },
  message: {
    color: t.toastText,
    fontSize: 13,
    fontWeight: "700",
  },
});
