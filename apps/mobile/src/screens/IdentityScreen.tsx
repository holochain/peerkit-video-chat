import type { JSX } from "react";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useThemedStyles, useTheme, type Palette } from "../theme";

interface IdentityScreenProps {
  onContinue(name: string): void;
}

export function IdentityScreen({ onContinue }: IdentityScreenProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  const [name, setName] = useState("");
  const canContinue = name.trim().length > 0;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.screen}
    >
      <View style={styles.card}>
        <Text style={styles.eyebrow}>peerkit-video-chat</Text>
        <Text style={styles.title}>Pick a name to show your peers.</Text>
        <Text style={styles.body}>
          Your agent identity stays unique; this name is what people see in rooms and chat.
        </Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={32}
          onChangeText={setName}
          placeholder="e.g. mira"
          placeholderTextColor={t.textFaint}
          style={styles.input}
          value={name}
        />
        <Pressable
          disabled={!canContinue}
          onPress={() => onContinue(name.trim())}
          style={[styles.button, !canContinue && styles.disabled]}
        >
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      justifyContent: "center",
      padding: 20,
    },
    card: {
      gap: 14,
    },
    eyebrow: {
      color: t.accent,
      fontSize: 13,
      fontWeight: "900",
      textTransform: "uppercase",
    },
    title: {
      color: t.textPrimary,
      fontSize: 32,
      fontWeight: "900",
      lineHeight: 38,
    },
    body: {
      color: t.textMuted,
      fontSize: 15,
      lineHeight: 22,
    },
    input: {
      backgroundColor: t.surfaceInput,
      borderColor: t.borderInput,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 17,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    button: {
      alignItems: "center",
      backgroundColor: t.accent,
      borderRadius: 8,
      minHeight: 50,
      justifyContent: "center",
    },
    disabled: {
      opacity: 0.45,
    },
    buttonText: {
      color: t.onAccent,
      fontSize: 16,
      fontWeight: "900",
    },
  });
