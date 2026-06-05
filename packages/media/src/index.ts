import type { WebRtcSignal } from "@peerkit-video-chat/core";

export type MediaStreamLike = MediaStream;

export type StreamCallback = (
  agentId: string,
  stream: MediaStreamLike | null,
) => void;

export type SpeakingCallback = (agentId: string, speaking: boolean) => void;

export type LogLevel = "info" | "warn";

/** Resolves an agentId to a human-readable display name for log lines. */
export type PeerNameResolver = (agentId: string) => string | undefined;

export interface MediaAccess {
  camera: boolean;
  microphone: boolean;
}

export interface MediaControllerDeps {
  sendSignal(toAgent: string, signal: WebRtcSignal): Promise<void>;
  requestMediaAccess(): Promise<MediaAccess>;
  iceServers: RTCIceServer[];
  /**
   * Optional sink for connection/ICE diagnostics. The desktop renderer forwards
   * these into its shared log file; when absent the controller falls back to the
   * platform console so web/react-native still surface the same lines.
   */
  log?(level: LogLevel, message: string): void;
}

export interface MediaController {
  initLocalMedia(selfAgentId: string): Promise<MediaStreamLike>;
  initiateCall(toAgentId: string): Promise<void>;
  handleSignal(fromAgentId: string, signal: WebRtcSignal): Promise<void>;
  setMuted(muted: boolean): void;
  setCamMuted(muted: boolean): Promise<void>;
  setPreferredDevices(cameraId: string, micId: string): void;
  setStreamCallback(cb: StreamCallback): void;
  setSpeakingCallback(cb: SpeakingCallback): void;
  setPeerNameResolver(resolve: PeerNameResolver): void;
  getLocalStream(): MediaStreamLike | null;
  closePeer(agentId: string): void;
  closeAll(): void;
}

export declare function createMediaController(
  deps: MediaControllerDeps,
): MediaController;
