import type {
  IncomingChat,
  NetworkRoomEntry,
  PeerStats,
  RoomStateView,
} from "@peerkit-video-chat/core";
import type { MediaStreamLike } from "./media";

export type Screen = "identity" | "initializing" | "lobby" | "prejoin" | "call";

export type ThemePref = "system" | "light" | "dark";

export type DeviceKind = "camera" | "microphone" | "speaker";

export interface SavedRoom {
  name: string;
  lastUsed: number;
}

export interface RoomMember {
  agentId: string;
  displayName: string;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  displayName: string;
  body: string;
  t: number;
}

export interface StoredSettings {
  username?: string;
  savedRooms: SavedRoom[];
  theme: ThemePref;
  devices: Record<DeviceKind, string>;
}

export interface Toast {
  id: string;
  message: string;
  kind: "error" | "warn" | "info";
}

export interface ChatState {
  agentId: string;
  status: "idle" | "starting" | "online" | "error";
  error: string;
  relayAddr: string;
  relayConnected: boolean;
  peerStats: PeerStats | null;
  room: RoomStateView;
  networkRooms: NetworkRoomEntry[];
  chatMessages: ChatMessage[];
}

export type StreamMap = ReadonlyMap<string, MediaStreamLike>;

export interface IncomingChatWithSelf extends IncomingChat {
  isSelf: boolean;
}
