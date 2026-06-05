import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DeviceKind, StoredSettings, ThemePref } from "./types";

const PREFIX = "pkvc:";

const DEFAULT_DEVICES: Record<DeviceKind, string> = {
  camera: "",
  microphone: "",
  speaker: "",
};

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
    savedRooms: JSON.parse(values[`${PREFIX}savedRooms`] ?? "[]") as StoredSettings["savedRooms"],
    theme: (values[`${PREFIX}theme`] as ThemePref | null) ?? "system",
    devices: {
      ...DEFAULT_DEVICES,
      ...(JSON.parse(values[`${PREFIX}devices`] ?? "{}") as Partial<Record<DeviceKind, string>>),
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
