import { createMediaController } from "./webrtc/index.js";

import { rendererLog } from "./lib/log.js";

// Baked at build time by electron-vite `define` (see electron.vite.config.ts).
// Both are "" for dev/unsigned builds with no TURN wired, so the app runs
// STUN-only and skips the TURN entry entirely.
declare const __TURN_REALM__: string;
declare const __TURN_PASSWORD__: string;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

if (__TURN_PASSWORD__ && __TURN_REALM__) {
  // Self-hosted coturn answers STUN on 3478 and serves TURN.
  ICE_SERVERS.unshift({ urls: `stun:${__TURN_REALM__}:3478` });
  ICE_SERVERS.push({
    urls: [
      `turn:${__TURN_REALM__}:3478?transport=udp`,
      `turn:${__TURN_REALM__}:3478?transport=tcp`,
      `turns:${__TURN_REALM__}:443?transport=tcp`,
    ],
    username: "peerkit-video-chat-user",
    credential: __TURN_PASSWORD__,
  });
} else {
  console.warn(
    "TURN not configured - running STUN-only; relayed calls will not work",
  );
}

export const mediaController = createMediaController({
  sendSignal: window.app.sendSignal,
  requestMediaAccess: window.app.requestMediaAccess,
  iceServers: ICE_SERVERS,
  // Forward webrtc/connection diagnostics into the shared renderer log file —
  // the packaged app has no terminal, and these lines drive call debugging.
  log: rendererLog,
});

export const {
  initLocalMedia,
  initiateCall,
  handleSignal,
  setMuted,
  setCamMuted,
  setPreferredDevices,
  setStreamCallback,
  setSpeakingCallback,
  setPeerNameResolver,
  getLocalStream,
  closePeer,
  closeAll,
} = mediaController;
