import type { JSX } from "react";
import { useEffect, useState } from "react";
import {
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { peerColorFromId, shortId } from "../lib/identicon";
import { useThemedStyles, useTheme, type Palette } from "../theme";
import type { ChatMessage } from "../types";

interface ChatOverlayProps {
  messages: ChatMessage[];
  selfAgentId: string;
  onClose(): void;
  onSend(body: string): void;
}

export function ChatOverlay({
  messages,
  selfAgentId,
  onClose,
  onSend,
}: ChatOverlayProps): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  const [draft, setDraft] = useState("");
  // The panel is absolutely anchored to bottom:0. Neither iOS nor Android's
  // edge-to-edge window resizes for the keyboard, so it would sit under it.
  // Track the keyboard height and raise the panel by that much, on both
  // platforms (iOS fires the will* events, Android the did* events).
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  function submit(): void {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft("");
  }

  return (
    <View style={[styles.panel, { bottom: keyboardHeight }]}>
      <View style={styles.head}>
        <View>
          <Text style={styles.title}>Room chat</Text>
          <Text style={styles.meta}>Sent to everyone here</Text>
        </View>
        <Pressable onPress={onClose} style={styles.close}>
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
      <FlatList
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => {
          const self = item.agentId === selfAgentId;
          return (
            <View style={[styles.message, self && styles.selfMessage]}>
              <View style={styles.messageHead}>
                <View style={[styles.dot, { backgroundColor: peerColorFromId(item.agentId) }]} />
                <Text style={styles.sender}>{item.displayName}</Text>
                <Text style={styles.short}>{shortId(item.agentId)}</Text>
              </View>
              <Text style={styles.body}>{item.body}</Text>
            </View>
          );
        }}
        style={styles.list}
      />
      <View style={styles.inputRow}>
        <TextInput
          onChangeText={setDraft}
          placeholder="Send to everyone"
          placeholderTextColor={t.textFaint}
          style={styles.input}
          value={draft}
        />
        <Pressable disabled={!draft.trim()} onPress={submit} style={styles.send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  panel: {
    backgroundColor: t.surface,
    borderTopColor: t.borderSoft,
    borderTopWidth: 1,
    bottom: 0,
    height: "58%",
    left: 0,
    padding: 14,
    position: "absolute",
    right: 0,
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    color: t.textPrimary,
    fontSize: 17,
    fontWeight: "900",
  },
  meta: {
    color: t.textMutedAlt,
    fontSize: 12,
  },
  close: {
    padding: 8,
  },
  closeText: {
    color: t.accent,
    fontWeight: "800",
  },
  list: {
    flex: 1,
    marginVertical: 12,
  },
  message: {
    backgroundColor: t.surfaceInput,
    borderRadius: 8,
    marginBottom: 8,
    padding: 10,
  },
  selfMessage: {
    backgroundColor: t.accentSurface,
  },
  messageHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  sender: {
    color: t.textPrimary,
    fontSize: 13,
    fontWeight: "800",
  },
  short: {
    color: t.textFaint,
    fontSize: 11,
  },
  body: {
    color: t.textBright2,
    fontSize: 14,
    marginTop: 6,
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
  },
  input: {
    backgroundColor: t.surfaceInput,
    borderColor: t.borderInput,
    borderRadius: 8,
    borderWidth: 1,
    color: t.textPrimary,
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  send: {
    alignItems: "center",
    backgroundColor: t.accent,
    borderRadius: 8,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  sendText: {
    color: t.onAccent,
    fontWeight: "900",
  },
});
