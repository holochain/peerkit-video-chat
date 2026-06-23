/**
 * React Native binding for the shared media controller.
 *
 * Supplies the react-native-webrtc constructors (read off the global scope, where
 * `registerGlobals()` installs them — see the app entrypoint), its `mediaDevices`,
 * and a `getStats()` audioLevel speaking detector (no Web Audio on RN). All call
 * logic — the recovery ladder, DTLS watchdog, candidate buffering — lives in
 * {@link SharedMediaController}; this file only wires platform globals to it.
 *
 * It intentionally reads from `globalThis` rather than importing
 * `react-native-webrtc` so the package still type-checks and builds under the
 * Node toolchain (the native module is an optional peer dep, absent off-device).
 */

import type {
  MediaController,
  MediaControllerDeps,
  MediaStreamLike,
} from "./index.js";
import {
  SharedMediaController,
  type MediaPlatform,
  type SpeakingDetector,
  type SpeakingSource,
} from "./peer-connection.js";

export type {
  MediaAccess,
  MediaController,
  MediaControllerDeps,
  MediaStreamLike,
  SpeakingCallback,
  StreamCallback,
} from "./index.js";

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
}

interface ReactNativeMediaGlobals {
  RTCPeerConnection?: typeof RTCPeerConnection;
  RTCIceCandidate?: typeof RTCIceCandidate;
  MediaStream?: new () => MediaStreamLike;
  navigator?: { mediaDevices?: MediaDevicesLike };
}

const STATS_INTERVAL_MS = 250;
const SPEAKING_THRESHOLD = 0.015;

/**
 * Speaking detection by polling `getStats()` audioLevel. RN has no Web Audio, so
 * the level is read from the peer connection's stats reports. The local
 * participant has no peer connection (no `getStats`), so self-detection is a
 * no-op here — remote participants drive the speaking indicator.
 */
class StatsSpeakingDetector implements SpeakingDetector {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly state = new Map<string, boolean>();
  private readonly notify = new Map<string, (speaking: boolean) => void>();

  start(
    agentId: string,
    source: SpeakingSource,
    onChange: (speaking: boolean) => void,
  ): void {
    this.stop(agentId);
    const getStats = source.getStats;
    if (getStats === undefined) return; // local participant — no stats source
    this.notify.set(agentId, onChange);
    let smoothedLevel = 0;
    const timer = setInterval(() => {
      void getStats()
        .then((stats: RTCStatsReport) => {
          // Drop late-resolving polls from an already-stopped/restarted timer.
          if (this.timers.get(agentId) !== timer) return;
          let level = 0;
          stats.forEach((report: RTCStats) => {
            const maybeLevel = (report as RTCStats & { audioLevel?: number }).audioLevel;
            if (typeof maybeLevel === "number") {
              level = Math.max(level, maybeLevel);
            }
          });
          smoothedLevel = smoothedLevel * 0.85 + level * 0.15;
          const speaking = smoothedLevel > SPEAKING_THRESHOLD;
          if (this.state.get(agentId) !== speaking) {
            this.state.set(agentId, speaking);
            this.notify.get(agentId)?.(speaking);
          }
        })
        .catch(() => {
          // Keep the polling loop alive; ignore transient getStats() failures.
        });
    }, STATS_INTERVAL_MS);
    this.timers.set(agentId, timer);
  }

  stop(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer !== undefined) clearInterval(timer);
    this.timers.delete(agentId);
    if (this.state.get(agentId) === true) {
      this.notify.get(agentId)?.(false);
    }
    this.state.delete(agentId);
    this.notify.delete(agentId);
  }

  stopAll(): void {
    for (const agentId of [...this.timers.keys()]) this.stop(agentId);
  }
}

function ctor<K extends keyof ReactNativeMediaGlobals>(
  name: K,
): NonNullable<ReactNativeMediaGlobals[K]> {
  const value = (globalThis as ReactNativeMediaGlobals)[name];
  if (value === undefined) {
    throw new Error(
      `react-native-webrtc global "${String(name)}" is missing — call registerGlobals() at app startup`,
    );
  }
  return value as NonNullable<ReactNativeMediaGlobals[K]>;
}

function reactNativePlatform(): MediaPlatform {
  const devices = (globalThis as ReactNativeMediaGlobals).navigator?.mediaDevices;
  if (devices === undefined) {
    throw new Error(
      "react-native-webrtc mediaDevices is missing — call registerGlobals() at app startup",
    );
  }
  return {
    RTCPeerConnection: ctor("RTCPeerConnection"),
    RTCIceCandidate: ctor("RTCIceCandidate"),
    MediaStream: ctor("MediaStream"),
    getUserMedia: (constraints) => devices.getUserMedia(constraints),
    speaking: new StatsSpeakingDetector(),
  };
}

export function createMediaController(deps: MediaControllerDeps): MediaController {
  return new SharedMediaController(deps, reactNativePlatform());
}
