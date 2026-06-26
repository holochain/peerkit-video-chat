/**
 * Test harness for the shared WebRTC media controller.
 *
 * The controller takes its WebRTC primitives, getUserMedia, and speaking detector
 * through an injected MediaPlatform (see {@link SharedMediaController}), so the
 * suite drives it under node with no DOM: it builds a mock platform around a
 * hand-rolled RTCPeerConnection whose state transitions the test fires by hand,
 * then asserts on the injected sendSignal callback.
 */

import { vi } from "vitest";

import type { MediaStreamLike } from "../src/media/types";
import {
  ACCEPTOR_GIVEUP_MS,
  DTLS_STALL_MS,
  RECOVERY_ATTEMPT_MS,
  type MediaPlatform,
  type SpeakingDetector,
} from "../src/media/peer-connection";

// Re-export the controller's own recovery-timer constants so tests advance fake
// timers past each rung without re-declaring (and drifting from) the source.
export { ACCEPTOR_GIVEUP_MS, DTLS_STALL_MS, RECOVERY_ATTEMPT_MS };

/** Every mock peer connection constructed since the last reset, in order. */
export const createdPeers: MockPeerConnection[] = [];

export function resetPeers(): void {
  createdPeers.length = 0;
}

/** Build an SDP blob carrying a given DTLS fingerprint (all the core reads). */
export function sdpWithFingerprint(fp: string): string {
  return `v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${fp}\r\n`;
}

type Handler = ((ev: unknown) => void) | null;

class MockDtlsTransport {
  state: RTCDtlsTransportState = "new";
  private _listeners = new Set<() => void>();

  addEventListener(type: string, cb: () => void): void {
    if (type === "statechange") this._listeners.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    if (type === "statechange") this._listeners.delete(cb);
  }
  /** Test hook: move DTLS state and notify listeners. */
  _set(state: RTCDtlsTransportState): void {
    this.state = state;
    for (const cb of [...this._listeners]) cb();
  }
}

class MockSender {
  transport: MockDtlsTransport;
  constructor(
    public track: { kind: string; id: string } | null,
    transport: MockDtlsTransport,
  ) {
    this.transport = transport;
  }
  replaceTrack = vi.fn(async (_t: unknown) => {});
}

let fpCounter = 0;

/**
 * Minimal RTCPeerConnection mock. Implements only what the shared core touches.
 * Tests drive lifecycle with the _set* hooks and read createOffer/sendSignal.
 */
export class MockPeerConnection {
  // Captured constructor config — lets tests assert iceTransportPolicy 'relay'.
  config: RTCConfiguration;
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  currentRemoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;

  onicecandidate: Handler = null;
  ontrack: Handler = null;
  oniceconnectionstatechange: Handler = null;
  onconnectionstatechange: Handler = null;

  // Distinct local DTLS fingerprint per pc; stable across the pc's lifetime so
  // an ICE restart (same pc) re-offers the same fingerprint and a full
  // reconnect (new pc) offers a different one — matching real DTLS behaviour.
  readonly localFingerprint = `FP_LOCAL_${fpCounter++}`;

  readonly dtls = new MockDtlsTransport();
  private _senders: MockSender[] = [];
  private _transceivers: Array<{
    sender: MockSender;
    receiver: { track: { kind: string } };
    direction: RTCRtpTransceiverDirection;
  }> = [];

  closed = false;

  createOffer = vi.fn(async (opts?: { iceRestart?: boolean }) => {
    this._lastOfferWasRestart = opts?.iceRestart === true;
    return { type: "offer", sdp: sdpWithFingerprint(this.localFingerprint) };
  });
  createAnswer = vi.fn(async () => ({
    type: "answer",
    sdp: sdpWithFingerprint(this.localFingerprint),
  }));

  setLocalDescription = vi.fn(async (desc?: { type: string; sdp: string }) => {
    this.localDescription = desc ?? {
      type: "offer",
      sdp: sdpWithFingerprint(this.localFingerprint),
    };
  });
  setRemoteDescription = vi.fn(async (desc: { type: string; sdp: string }) => {
    this.currentRemoteDescription = desc;
  });
  addIceCandidate = vi.fn(async (_c: unknown) => {});

  addTrack = vi.fn((track: { kind: string; id: string }) => {
    const s = new MockSender(track, this.dtls);
    this._senders.push(s);
    return s;
  });
  removeTrack = vi.fn((_s: unknown) => {});
  getSenders = vi.fn(() => [
    ...this._senders,
    ...this._transceivers.map((t) => t.sender),
  ]);
  getTransceivers = vi.fn(() => this._transceivers);
  addTransceiver = vi.fn((kind: string, init?: { direction?: RTCRtpTransceiverDirection }) => {
    const tx = {
      sender: new MockSender(null, this.dtls),
      receiver: { track: { kind } },
      direction: init?.direction ?? ("sendrecv" as RTCRtpTransceiverDirection),
    };
    this._transceivers.push(tx);
    return tx;
  });
  getStats = vi.fn(async () => new Map());
  close = vi.fn(() => {
    this.closed = true;
  });

  private _lastOfferWasRestart = false;

  constructor(config: RTCConfiguration) {
    this.config = config;
    createdPeers.push(this);
  }

  // ---- test hooks ----------------------------------------------------------

  /** Set ICE connection state and fire the handler. */
  _setIce(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
  }
  /** Set aggregate connection state and fire the handler. */
  _setConn(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }
  /** Move DTLS state and notify the watchdog listener. */
  _setDtls(state: RTCDtlsTransportState): void {
    this.dtls._set(state);
  }
  /** Whether the most recent createOffer requested an ICE restart. */
  get lastOfferWasRestart(): boolean {
    return this._lastOfferWasRestart;
  }
}

/** Minimal RTCIceCandidate mock — the core only constructs and forwards it. */
class MockIceCandidate {
  constructor(public init: unknown) {}
}

class MockMediaStreamTrack {
  enabled = true;
  readyState = "live";
  constructor(
    public kind: string,
    public id: string,
  ) {}
  stop = vi.fn();
}

class MockMediaStream {
  private _tracks: MockMediaStreamTrack[] = [];
  readonly id = `stream_${Math.random().toString(36).slice(2)}`;
  addTrack(t: MockMediaStreamTrack): void {
    this._tracks.push(t);
  }
  removeTrack(t: MockMediaStreamTrack): void {
    this._tracks = this._tracks.filter((x) => x !== t);
  }
  getTracks(): MockMediaStreamTrack[] {
    return [...this._tracks];
  }
  getAudioTracks(): MockMediaStreamTrack[] {
    return this._tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): MockMediaStreamTrack[] {
    return this._tracks.filter((t) => t.kind === "video");
  }
}

/**
 * No-op speaking detector. The recovery-ladder suite never asserts on speaking
 * state, and the local/remote detectors are started only off media/track events
 * the suite does not fire, so a stub keeps the injected platform complete.
 */
class MockSpeakingDetector implements SpeakingDetector {
  start(): void {}
  stop(): void {}
  stopAll(): void {}
}

/** Captured outbound signals: one entry per sendSignal call. */
export type SentSignal = { to: string; signal: { kind: string; sdp?: string; candidate?: string } };

export type Harness = {
  sent: SentSignal[];
  sendSignal: ReturnType<typeof vi.fn>;
};

/** Build the captured-signal harness handed to the controller as sendSignal. */
export function makeHarness(): Harness {
  const sent: SentSignal[] = [];
  const sendSignal = vi.fn(async (to: string, signal: SentSignal["signal"]) => {
    sent.push({ to, signal });
  });
  return { sent, sendSignal };
}

/** Build the mock MediaPlatform injected into the controller under test. */
export function createMockPlatform(): MediaPlatform {
  let trackId = 0;
  const getUserMedia = async (
    constraints: MediaStreamConstraints,
  ): Promise<MediaStreamLike> => {
    const stream = new MockMediaStream();
    if (constraints.audio) stream.addTrack(new MockMediaStreamTrack("audio", `a${trackId++}`));
    if (constraints.video) stream.addTrack(new MockMediaStreamTrack("video", `v${trackId++}`));
    return stream as unknown as MediaStreamLike;
  };

  return {
    RTCPeerConnection: MockPeerConnection as unknown as typeof RTCPeerConnection,
    RTCIceCandidate: MockIceCandidate as unknown as typeof RTCIceCandidate,
    MediaStream: MockMediaStream as unknown as new () => MediaStreamLike,
    getUserMedia,
    speaking: new MockSpeakingDetector(),
  };
}

/** Flush pending microtasks so awaited recovery chains settle. */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
