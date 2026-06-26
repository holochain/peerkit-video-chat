import type { WebRtcSignal } from "@peerkit-video-chat/core";
import {
  PERMISSIONS,
  RESULTS,
  requestMultiple,
} from "react-native-permissions";
import { Platform } from "react-native";
import { registerGlobals } from "react-native-webrtc";
import { configuredIceServers } from "../config";
import { createMediaController } from "./platform";
import type { MediaController, MediaStreamLike } from "./types";

export type {
  LogLevel,
  MediaAccess,
  MediaController,
  MediaControllerDeps,
  MediaStreamLike,
  PeerNameResolver,
  SpeakingCallback,
  StreamCallback,
} from "./types";

registerGlobals();

type PermissionList = Parameters<typeof requestMultiple>[0];

function mediaPermissions(): PermissionList {
  if (Platform.OS === "ios") {
    return [PERMISSIONS.IOS.CAMERA, PERMISSIONS.IOS.MICROPHONE];
  }
  if (Platform.OS === "android") {
    return [PERMISSIONS.ANDROID.CAMERA, PERMISSIONS.ANDROID.RECORD_AUDIO];
  }
  return [];
}

export function createMobileMediaController(
  sendSignal: (toAgent: string, signal: WebRtcSignal) => Promise<void>,
): MediaController {
  return createMediaController({
    sendSignal,
    requestMediaAccess: async () => {
      const permissions = mediaPermissions();
      if (permissions.length === 0) {
        return { camera: true, microphone: true };
      }
      const result = await requestMultiple(permissions);
      return {
        camera: result[permissions[0]!] === RESULTS.GRANTED,
        microphone: result[permissions[1]!] === RESULTS.GRANTED,
      };
    },
    iceServers: configuredIceServers(),
  });
}

export function streamUrl(stream: MediaStreamLike | null): string | null {
  if (stream === null) return null;
  const maybeStream = stream as MediaStreamLike & { toURL?: () => string };
  return maybeStream.toURL?.() ?? null;
}
