/**
 * Test harness for the renderer WebRTC layer.
 *
 * webrtc.ts is browser code with no DOM in the vitest (node) env and keeps its
 * recovery logic in module-private functions. So the suite drives it black-box —
 * through the exported initiateCall / handleSignal / closePeer surface — against
 * a hand-rolled RTCPeerConnection mock whose state transitions the test fires by
 * hand, asserting on the signals emitted via window.app.sendSignal.
 */

import { vi } from "vitest";

// Recovery timer constants — mirror the (module-private) values in webrtc.ts so
// tests can advance fake timers past each one. Keep in sync with that file.
export const DTLS_STALL_MS = 10_000;
export const ACCEPTOR_GIVEUP_MS = 30_000;
export const RECOVERY_ATTEMPT_MS = 12_000;

/** Every mock peer connection constructed since the last reset, in order. */
export const createdPeers: MockPeerConnection[] = [];

export function resetPeers(): void {
  createdPeers.length = 0;
}

/** Build an SDP blob carrying a given DTLS fingerprint (all webrtc.ts reads). */
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
 * Minimal RTCPeerConnection mock. Implements only what webrtc.ts touches.
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

/** Captured outbound signals: one entry per window.app.sendSignal call. */
export type SentSignal = { to: string; signal: { kind: string; sdp?: string; candidate?: string } };

export type Harness = {
  sent: SentSignal[];
  sendSignal: ReturnType<typeof vi.fn>;
};

/**
 * Install all browser globals webrtc.ts reads, plus window.app. Call before
 * importing the module under test. Returns the captured-signal harness.
 */
export function installGlobals(): Harness {
  const sent: SentSignal[] = [];
  const sendSignal = vi.fn(async (to: string, signal: SentSignal["signal"]) => {
    sent.push({ to, signal });
  });

  let trackId = 0;
  const getUserMedia = vi.fn(async (c: { audio?: unknown; video?: unknown }) => {
    const s = new MockMediaStream();
    if (c.audio) s.addTrack(new MockMediaStreamTrack("audio", `a${trackId++}`));
    if (c.video) s.addTrack(new MockMediaStreamTrack("video", `v${trackId++}`));
    return s;
  });

  // Some of these (navigator, window) are getter-only in the node env, so they
  // must be installed with defineProperty rather than plain assignment.
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  };

  define("RTCPeerConnection", MockPeerConnection);
  define(
    "RTCIceCandidate",
    class {
      constructor(public init: unknown) {}
    },
  );
  define("MediaStream", MockMediaStream);
  define("requestAnimationFrame", () => 0);
  define("cancelAnimationFrame", () => {});
  define("navigator", { mediaDevices: { getUserMedia } });
  define("window", {
    app: {
      sendSignal,
      requestMediaAccess: vi.fn(async () => ({ camera: true, microphone: true })),
    },
  });

  return { sent, sendSignal };
}

/** Flush pending microtasks so awaited recovery chains settle. */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
