import AsyncStorage from "@react-native-async-storage/async-storage";
import type { IAgentKeyStore } from "@peerkit/api";
import type { DeviceKind, StoredSettings, ThemePref } from "./types";

const PREFIX = "pkvc:";

const AGENT_KEY = `${PREFIX}agentKey`;

const DEFAULT_DEVICES: Record<DeviceKind, string> = {
  camera: "",
  microphone: "",
  speaker: "",
};

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function loadSettings(): Promise<StoredSettings> {
  const entries = await AsyncStorage.multiGet([
    `${PREFIX}username`,
    `${PREFIX}savedRooms`,
    `${PREFIX}theme`,
    `${PREFIX}devices`,
  ]);
  const values = Object.fromEntries(entries);
  return {
    username: values[`${PREFIX}username`] ?? undefined,
    savedRooms: parseJsonOr<StoredSettings["savedRooms"]>(values[`${PREFIX}savedRooms`], []),
    theme: (values[`${PREFIX}theme`] as ThemePref | null) ?? "system",
    devices: {
      ...DEFAULT_DEVICES,
      ...parseJsonOr<Partial<Record<DeviceKind, string>>>(values[`${PREFIX}devices`], {}),
    },
  };
}

export async function setStoredValue(
  key: "username" | "savedRooms" | "theme" | "devices",
  value: unknown,
): Promise<void> {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  await AsyncStorage.setItem(`${PREFIX}${key}`, encoded);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function fromHex(hex: string): Uint8Array {
  // parseInt() yields NaN on bad pairs (coerced to 0 by Uint8Array) and odd
  // lengths get truncated, so a corrupted value would silently decode to a
  // different-but-valid-looking key. Reject anything that is not clean,
  // even-length hex up front.
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Stored agent key is not valid hex.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Persists the node's Ed25519 private key in AsyncStorage so the agent keeps a
// stable identity across restarts. PeerKit generates and stores a fresh key on
// first run when loadKey returns undefined. Hermes has no Buffer, so the key is
// hex-encoded by hand.
export const agentKeyStore: IAgentKeyStore = {
  loadKey: async (): Promise<Uint8Array | undefined> => {
    const hex = await AsyncStorage.getItem(AGENT_KEY);
    return hex ? fromHex(hex) : undefined;
  },
  storeKey: async (privateKey: Uint8Array): Promise<void> => {
    await AsyncStorage.setItem(AGENT_KEY, toHex(privateKey));
  },
};
