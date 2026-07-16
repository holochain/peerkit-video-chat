/**
 * WebRTC media controller for the desktop renderer.
 *
 * Holds the recovery ladder (ICE restart, then full reconnect, then relay-only),
 * the DTLS-stall watchdog, pending-candidate buffering, DTLS fingerprint routing,
 * and transceiver/`replaceTrack` camera toggling. It reaches for no browser global
 * at import time — the WebRTC constructors, `getUserMedia`, and the speaking
 * detector are injected via {@link MediaPlatform}, so this resilience logic stays
 * testable against a mock platform in the node (vitest) env. `index.ts` builds the
 * Chromium platform and hands it here.
 */

import type { WebRtcSignal } from "@peerkit-video-chat/core";
import type {
  LogLevel,
  MediaController,
  MediaControllerDeps,
  MediaStreamLike,
  PeerNameResolver,
  SpeakingCallback,
  StreamCallback,
} from "./types.js";

/** Where a speaking detector reads its signal from. */
export interface SpeakingSource {
  /** The audio-carrying stream (used by the AudioContext detector). */
  stream: MediaStreamLike;
  /**
   * Stats accessor for the peer connection, when one exists (used by the
   * `getStats()` audioLevel detector on platforms without Web Audio). Absent for
   * the local participant, which has no peer connection.
   */
  getStats?: () => Promise<RTCStatsReport>;
}

/**
 * Speaking detector. The Chromium build reads the stream through an
 * `AnalyserNode`. Tracks its own per-agent state and emits a trailing `false`
 * on stop.
 */
export interface SpeakingDetector {
  start(
    agentId: string,
    source: SpeakingSource,
    onChange: (speaking: boolean) => void,
  ): void;
  stop(agentId: string): void;
  stopAll(): void;
}

/** Platform bindings the shared controller needs but cannot reach portably. */
export interface MediaPlatform {
  RTCPeerConnection: typeof RTCPeerConnection;
  RTCIceCandidate: typeof RTCIceCandidate;
  MediaStream: new () => MediaStreamLike;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  speaking: SpeakingDetector;
}

// Recovery ladder bounds. ICE restart keeps the pc and its DTLS session; full
// reconnect rebuilds the pc from scratch; past both rungs we give up.
const MAX_ICE_RESTARTS = 3;
const MAX_FULL_RECONNECTS = 2;
// Backstop grace for a DTLS handshake that hangs without firing "failed"
// (generous: DTLS is ~2 RTT, so even a 500ms relay path completes in ~2s — the
// margin avoids false positives on slow relay/direct paths), and how long the
// acceptor waits for a recovery offer before reaping.
export const DTLS_STALL_MS = 10_000;
export const ACCEPTOR_GIVEUP_MS = 30_000;
// How long the offerer waits for a dispatched recovery attempt to reach
// "connected" before declaring it stalled and advancing the ladder. Covers the
// full attempt: answer round-trip + ICE checks + DTLS. Kept above DTLS_STALL_MS
// so a healthy-but-slow attempt is not pre-empted before its own DTLS watchdog.
export const RECOVERY_ATTEMPT_MS = 12_000;
/** Interval between compact RTP diagnostic samples for connected peers. */
export const RTP_STATS_INTERVAL_MS = 5_000;

interface CandidateDiagnostic {
  candidate?: string | null;
  protocol?: string | null;
  relayProtocol?: string | null;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  type?: string | null;
}

interface SdpMediaSection {
  direction?: string;
  kind: string;
  mid?: string;
}

interface DiagnosticStat {
  audioLevel?: unknown;
  bytesReceived?: unknown;
  bytesSent?: unknown;
  candidateType?: unknown;
  currentRoundTripTime?: unknown;
  framesDecoded?: unknown;
  framesDropped?: unknown;
  framesEncoded?: unknown;
  id?: unknown;
  jitter?: unknown;
  kind?: unknown;
  localCandidateId?: unknown;
  mediaType?: unknown;
  nominated?: unknown;
  packetsLost?: unknown;
  packetsReceived?: unknown;
  packetsSent?: unknown;
  protocol?: unknown;
  relayProtocol?: unknown;
  remoteCandidateId?: unknown;
  selectedCandidatePairId?: unknown;
  selected?: unknown;
  state?: unknown;
  type?: unknown;
}

interface RtpAggregate {
  audioLevel?: number;
  bytes: number;
  direction: "inbound" | "outbound";
  framesDecoded: number;
  framesDropped: number;
  framesEncoded: number;
  jitter?: number;
  kind: string;
  packets: number;
  packetsLost: number;
}

interface RtpCounter {
  bytes: number;
  packets: number;
}

function safeDiagnosticToken(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_.-]{1,32}$/i.test(value)) {
    return "unknown";
  }
  return value.toLowerCase();
}

function candidateDiagnostic(candidate: CandidateDiagnostic): string {
  const tokens = candidate.candidate?.trim().split(/\s+/) ?? [];
  const typeIndex = tokens.indexOf("typ");
  const type = safeDiagnosticToken(
    candidate.type ?? (typeIndex >= 0 ? tokens[typeIndex + 1] : undefined),
  );
  const protocol = safeDiagnosticToken(candidate.protocol ?? tokens[2]);
  const relayProtocol = safeDiagnosticToken(candidate.relayProtocol);
  const mid = safeDiagnosticToken(candidate.sdpMid);
  // sdpMLineIndex arrives from remote JSON, so it may hold any runtime value.
  const mline = Number.isInteger(candidate.sdpMLineIndex)
    ? String(candidate.sdpMLineIndex)
    : "unknown";
  const media = mid !== "unknown" ? `mid=${mid}` : `mline=${mline}`;
  return `type=${type} protocol=${protocol} relayProtocol=${relayProtocol} ${media}`;
}

function isIceCandidateInit(value: unknown): value is RTCIceCandidateInit {
  return (
    typeof value === "object" &&
    value !== null &&
    "candidate" in value &&
    typeof value.candidate === "string"
  );
}

function sdpDiagnostic(sdp: string): string {
  const sections: SdpMediaSection[] = [];
  let sessionDirection: string | undefined;
  let current: SdpMediaSection | undefined;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      const kind = safeDiagnosticToken(line.slice(2).split(/\s+/, 1)[0]);
      current = { kind };
      sections.push(current);
      continue;
    }
    if (line.startsWith("a=mid:") && current !== undefined) {
      current.mid = safeDiagnosticToken(line.slice("a=mid:".length));
      continue;
    }
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line)?.[1];
    if (direction !== undefined) {
      if (current === undefined) sessionDirection = direction;
      else current.direction = direction;
    }
  }
  const media = sections
    .filter((section) => section.kind === "audio" || section.kind === "video")
    .map(
      (section) =>
        `${section.kind}(mid=${section.mid ?? "unknown"},direction=${section.direction ?? sessionDirection ?? "unspecified"})`,
    )
    .join(",");
  return `bytes=${new TextEncoder().encode(sdp).byteLength} media=${media || "none"}`;
}

function numericStat(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? safeDiagnosticToken(error.name) : "unknown";
}

/**
 * Extract the DTLS fingerprint from an SDP blob. The fingerprint is stable for
 * the lifetime of an RTCPeerConnection's DTLS session and changes only when the
 * connection is rebuilt, so it distinguishes an ICE restart (same fingerprint,
 * RFC 8445 §9) from a full reconnect / reload (new fingerprint). Returns "" when
 * absent so a missing fingerprint never matches another.
 */
function sdpFingerprint(sdp: string): string {
  const m = /a=fingerprint:\S+\s+(\S+)/.exec(sdp);
  return m?.[1] ?? "";
}

export class SharedMediaController implements MediaController {
  private readonly peers = new Map<string, RTCPeerConnection>();
  // ICE candidates that arrived before the offer was processed (RFC 8829 §4.1.19)
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  // End-of-candidates received before the peer connection existed
  private readonly pendingEoc = new Set<string>();
  // Peers for which we are the controlling agent (offerer) — only the offerer restarts ICE
  private readonly offererPeers = new Set<string>();
  // ICE restart attempts since last successful connection, per peer (RFC 8445 §9)
  private readonly iceRestartAttempts = new Map<string, number>();
  // Full-reconnect attempts (fresh RTCPeerConnection) since last success, per peer.
  // The recovery ladder escalates here once ICE restarts are exhausted.
  private readonly reconnectAttempts = new Map<string, number>();
  // DTLS-stall watchdogs, per peer. Stored as a disarm function that clears both
  // the backstop timer and the transport statechange listener.
  private readonly dtlsWatchdogs = new Map<string, () => void>();
  // Acceptor-side give-up timers, per peer.
  private readonly giveupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Offerer-side per-attempt recovery timers, per peer.
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Peers with a recovery action in flight — dedupes the failed-state/watchdog double-fire.
  private readonly recovering = new Set<string>();
  // Peers awaiting a fresh remote description during recovery. While set, the pc
  // still carries the failed session's remote description, so incoming ICE belongs
  // to the new generation and must be buffered — applying it against the dead
  // description loses the restart's earliest candidates.
  private readonly awaitingRecoveryDescription = new Set<string>();
  // The outbound video RTCRtpSender per peer. We pre-negotiate a sendrecv video
  // m-line at call setup (even when the camera is off), so toggling the camera
  // mid-call is a track swap via replaceTrack — no renegotiation required.
  private readonly videoSenders = new Map<string, RTCRtpSender>();
  // Aggregated inbound MediaStream per peer. We add each received track to this
  // stream ourselves rather than relying on ev.streams[0]: a video m-line reserved
  // via addTransceiver while the camera is off carries no stream association, so
  // ev.streams is empty and the track would be dropped — yet ontrack does NOT fire
  // again when the peer later enables its camera via replaceTrack. Attaching the
  // track to a stable per-peer stream at negotiation means frames simply start
  // flowing into the already-attached tile when the camera comes on.
  private readonly remoteStreamsByPeer = new Map<string, MediaStreamLike>();
  // Lifecycle observers installed on media tracks and DTLS transports.
  private readonly trackObservers = new Map<string, Array<() => void>>();
  private readonly dtlsObservers = new Map<string, () => void>();
  // Connected-peer RTP samplers and their interval baselines.
  private readonly statsTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  // Maps each peer to the token of its active getStats request, so a stale
  // request from a stopped sampler can neither block nor unblock a new run.
  private readonly statsInFlight = new Map<string, symbol>();
  private readonly previousRtpCounters = new Map<
    string,
    Map<string, RtpCounter>
  >();

  private localStream: MediaStreamLike | null = null;
  // In-flight local media acquisition, so concurrent callers await the same work
  // instead of each opening (and leaking) their own mic/camera streams.
  private localStreamPromise: Promise<MediaStreamLike> | null = null;
  private preferredCameraId = "";
  private preferredMicId = "";
  // Whether the camera should be live. When false we never open the camera nor
  // hold a video track — toggling it on acquires one on demand (see setCamMuted).
  private camEnabled = true;
  // Desired microphone mute state. Recorded even before media exists so a pre-join
  // mute survives into acquireLocalStream() (see setMuted).
  private micMuted = false;

  private onRemoteStream: StreamCallback | null = null;
  private onSpeakingChange: SpeakingCallback | null = null;
  // Resolves an agentId to its room display name so log lines name the peer rather
  // than just showing a truncated id. Set from the view layer, which knows the
  // current roster. Defaults to "unknown" (undefined) until wired.
  private resolvePeerName: PeerNameResolver = () => undefined;

  constructor(
    private readonly deps: MediaControllerDeps,
    private readonly platform: MediaPlatform,
  ) {
    // Bind the public surface so consumers can destructure the controller and
    // call the methods free-standing (the desktop renderer does this) without
    // losing `this`.
    this.setPreferredDevices = this.setPreferredDevices.bind(this);
    this.setStreamCallback = this.setStreamCallback.bind(this);
    this.setSpeakingCallback = this.setSpeakingCallback.bind(this);
    this.setPeerNameResolver = this.setPeerNameResolver.bind(this);
    this.getLocalStream = this.getLocalStream.bind(this);
    this.initLocalMedia = this.initLocalMedia.bind(this);
    this.initiateCall = this.initiateCall.bind(this);
    this.handleSignal = this.handleSignal.bind(this);
    this.setMuted = this.setMuted.bind(this);
    this.setCamMuted = this.setCamMuted.bind(this);
    this.closePeer = this.closePeer.bind(this);
    this.closeAll = this.closeAll.bind(this);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  setPreferredDevices(cameraId: string, micId: string): void {
    this.preferredCameraId = cameraId;
    this.preferredMicId = micId;
  }

  /** Register callback invoked when a remote peer's stream arrives or is removed. */
  setStreamCallback(cb: StreamCallback): void {
    this.onRemoteStream = cb;
  }

  /** Register callback invoked when any peer's speaking state changes. */
  setSpeakingCallback(cb: SpeakingCallback): void {
    this.onSpeakingChange = cb;
  }

  /** Register the roster name resolver used to label peers in webrtc logs. */
  setPeerNameResolver(resolve: PeerNameResolver): void {
    this.resolvePeerName = resolve;
  }

  /** Return the local media stream if already acquired, otherwise null. */
  getLocalStream(): MediaStreamLike | null {
    return this.localStream;
  }

  /**
   * Acquire local media and start speaking detection for the local participant.
   * Returns the stream so the caller can attach it to a self-preview element.
   */
  async initLocalMedia(selfAgentId: string): Promise<MediaStreamLike> {
    const stream = await this.acquireLocalStream();
    this.platform.speaking.stop(selfAgentId);
    this.platform.speaking.start(selfAgentId, { stream }, (speaking) => {
      this.onSpeakingChange?.(selfAgentId, speaking);
    });
    return stream;
  }

  async initiateCall(toAgentId: string): Promise<void> {
    if (this.peers.has(toAgentId)) return;
    this.logPeer(toAgentId, "initiating call (sending offer)");
    const stream = await this.acquireLocalStream();
    const pc = this.buildPeerConnection(toAgentId);
    this.offererPeers.add(toAgentId);
    try {
      this.attachLocalTracks(pc, toAgentId, stream);
      // Reserve a sendrecv video m-line even when the camera is off, so it can be
      // enabled mid-call via replaceTrack without renegotiating.
      this.trackVideoSender(pc, toAgentId, true);
      this.observeDtls(toAgentId, pc);
      const offer = await pc.createOffer();
      this.logSdp(toAgentId, "local", "offer", offer.sdp ?? "");
      await pc.setLocalDescription(offer);
      await this.deps.sendSignal(toAgentId, { kind: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      // buildPeerConnection already registered the pc; tear it down so a retry is
      // not short-circuited by this.peers.has() and no stale callbacks/timers live on.
      this.warnPeer(
        toAgentId,
        `initial offer failed error=${errorDiagnostic(err)}`,
      );
      this.closePeer(toAgentId);
      throw err;
    }
  }

  async handleSignal(fromAgentId: string, signal: WebRtcSignal): Promise<void> {
    if (signal.kind === "offer") {
      this.logSdp(fromAgentId, "remote", "offer", signal.sdp);
      const existingPc = this.peers.get(fromAgentId);
      if (existingPc !== undefined) {
        // A recovery offer landed — cancel the acceptor's give-up timer.
        this.clearAcceptorGiveup(fromAgentId);
        const incomingFp = sdpFingerprint(signal.sdp);
        const currentFp = sdpFingerprint(existingPc.currentRemoteDescription?.sdp ?? "");
        if (incomingFp !== "" && incomingFp === currentFp) {
          // Same DTLS identity = ICE restart from the remote offerer (RFC 8445 §9).
          // Apply to the existing pc to preserve its DTLS session (fast path).
          await existingPc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
          // The new generation's remote description is now in place.
          this.awaitingRecoveryDescription.delete(fromAgentId);
          const answer = await existingPc.createAnswer();
          this.logSdp(fromAgentId, "local", "answer", answer.sdp ?? "");
          await existingPc.setLocalDescription(answer);
          await this.deps.sendSignal(fromAgentId, { kind: "answer", sdp: answer.sdp ?? "" });
          // Apply candidates buffered for this restart generation while we waited.
          await this.drainPendingCandidates(existingPc, fromAgentId);
          return;
        }
        // Different DTLS identity = the remote rebuilt its connection (full
        // reconnect or page reload). Our pc is stale and its m-lines won't match
        // the fresh offer — discard it and accept the offer on a new pc by
        // falling through to the fresh-acceptor path below.
        this.stopStatsSampler(fromAgentId);
        this.clearTrackObservers(fromAgentId);
        this.clearDtlsObserver(fromAgentId);
        existingPc.close();
        this.peers.delete(fromAgentId);
        this.pendingCandidates.delete(fromAgentId);
        this.pendingEoc.delete(fromAgentId);
        this.videoSenders.delete(fromAgentId);
        this.offererPeers.delete(fromAgentId);
        this.clearRecoveryState(fromAgentId);
        // Drop the stale aggregated stream so the new pc's ontrack starts clean
        // rather than appending to ended tracks from the discarded connection.
        this.resetRemoteMedia(fromAgentId);
      }
      this.logPeer(fromAgentId, "received offer — answering");
      const stream = await this.acquireLocalStream();
      const pc = this.buildPeerConnection(fromAgentId);
      try {
        this.attachLocalTracks(pc, fromAgentId, stream);
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        // The fresh remote description is in place; ICE may now apply directly.
        this.awaitingRecoveryDescription.delete(fromAgentId);
        // Match the offerer's reserved video m-line so we can enable our camera
        // mid-call via replaceTrack (offer already carries a sendrecv video section).
        this.trackVideoSender(pc, fromAgentId, false);
        this.observeDtls(fromAgentId, pc);
        // Drain any candidates that arrived before the offer (RFC 8829 §4.1.19)
        await this.drainPendingCandidates(pc, fromAgentId);
        const answer = await pc.createAnswer();
        this.logSdp(fromAgentId, "local", "answer", answer.sdp ?? "");
        await pc.setLocalDescription(answer);
        await this.deps.sendSignal(fromAgentId, { kind: "answer", sdp: answer.sdp ?? "" });
      } catch (err) {
        // buildPeerConnection registered the pc; tear it down so a retry is not
        // short-circuited by an existing entry and no stale callbacks/timers live on.
        this.warnPeer(fromAgentId, `answer failed error=${errorDiagnostic(err)}`);
        this.closePeer(fromAgentId);
        throw err;
      }
      return;
    }

    const pc = this.peers.get(fromAgentId);
    // The offerer already has a pc before the answer is applied, so a present
    // pc is not enough: candidates added before setRemoteDescription completes
    // get dropped. Buffer until a remote description exists.
    // Also buffer while awaiting a recovery offer/answer: the pc still holds the
    // failed session's remote description, so a present one is not enough — these
    // candidates belong to the new generation and must wait for its description.
    const needsRemoteDescription =
      pc === undefined ||
      pc.remoteDescription === null ||
      this.awaitingRecoveryDescription.has(fromAgentId);

    if (signal.kind === "ice") {
      if (signal.candidate === "") {
        this.debugPeer(
          fromAgentId,
          `remote ICE end-of-candidates ${needsRemoteDescription ? "buffering" : "applying"}`,
        );
        // End-of-candidates (RFC 8838 §13.4.1)
        if (!needsRemoteDescription && pc !== undefined) {
          await this.applyIceCandidate(fromAgentId, pc, { candidate: "" });
        } else {
          this.pendingEoc.add(fromAgentId);
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(signal.candidate);
      } catch {
        this.warnPeer(fromAgentId, "malformed ICE candidate received");
        return;
      }
      if (!isIceCandidateInit(parsed)) {
        this.warnPeer(fromAgentId, "malformed ICE candidate received");
        return;
      }
      const init = parsed;
      const summary = candidateDiagnostic(init);
      if (needsRemoteDescription) {
        // Offer/answer not yet processed — buffer for drain after setRemoteDescription
        const buf = this.pendingCandidates.get(fromAgentId) ?? [];
        buf.push(init);
        this.pendingCandidates.set(fromAgentId, buf);
        this.debugPeer(
          fromAgentId,
          `remote ICE ${summary} buffering count=${buf.length}`,
        );
        return;
      }
      this.debugPeer(fromAgentId, `remote ICE ${summary} applying`);
      await this.applyIceCandidate(
        fromAgentId,
        pc,
        new this.platform.RTCIceCandidate(init),
      );
      return;
    }

    // answer
    if (pc === undefined) return;
    this.logPeer(fromAgentId, "received answer");
    this.logSdp(fromAgentId, "remote", "answer", signal.sdp);
    await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    // The (possibly recovery) remote description is in place; ICE may apply now.
    this.awaitingRecoveryDescription.delete(fromAgentId);
    await this.drainPendingCandidates(pc, fromAgentId);
  }

  setMuted(muted: boolean): void {
    // Record intent first so acquireLocalStream() honours a mute toggled before any
    // stream exists (e.g. muted on the pre-join screen before joining).
    this.micMuted = muted;
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    this.emit("debug", `webrtc: local audio ${muted ? "muted" : "unmuted"}`);
    for (const agentId of this.peers.keys()) {
      this.debugPeer(agentId, `outbound audio ${muted ? "muted" : "unmuted"}`);
    }
  }

  async setCamMuted(muted: boolean): Promise<void> {
    // Record intent first so a later acquireLocalStream() honours it even when no
    // stream exists yet (e.g. toggled off on the pre-join screen before joining).
    this.camEnabled = !muted;
    if (this.localStream === null) return;

    if (muted) {
      // Stop and drop the local video track (releases the camera) and stop
      // sending to every peer. The pre-negotiated video m-lines stay in place
      // so the camera can be turned back on without renegotiation.
      for (const t of this.localStream.getVideoTracks()) {
        this.emit("debug", "webrtc: local video track stopped for camera mute");
        t.stop();
        this.localStream.removeTrack(t);
      }
      await Promise.all(
        [...this.videoSenders.entries()].map(async ([agentId, sender]) => {
          try {
            await sender.replaceTrack(null);
            this.debugPeer(agentId, "outbound video track replaced with none");
          } catch (err) {
            this.warnPeer(
              agentId,
              `camera mute failed error=${errorDiagnostic(err)}`,
            );
          }
        }),
      );
      return;
    }

    // Unmute: acquire a fresh video track, add it to the local stream for our own
    // preview, and push it to every existing peer connection via replaceTrack so
    // remote participants actually see the camera (the bug this guards against).
    if (this.localStream.getVideoTracks().length > 0) return; // already on
    const s = await this.platform.getUserMedia({ video: this.videoConstraint() });
    const track = s.getVideoTracks()[0];
    if (track === undefined) return;
    this.emit(
      "debug",
      `webrtc: local video track acquired enabled=${track.enabled} muted=${track.muted} state=${track.readyState}`,
    );
    // getUserMedia is async: a mute toggle (or call teardown) may have raced ahead
    // while it was pending. If the camera is no longer wanted, or the call is gone,
    // discard the freshly acquired track instead of streaming it to peers.
    if (!this.camEnabled || this.localStream === null) {
      track.stop();
      return;
    }
    this.localStream.addTrack(track);
    await Promise.all(
      [...this.videoSenders.entries()].map(async ([agentId, sender]) => {
        try {
          await sender.replaceTrack(track);
          this.debugPeer(agentId, "outbound video track replaced with live track");
          this.observeTrack(agentId, "outbound", track);
        } catch (err) {
          this.warnPeer(
            agentId,
            `camera unmute failed error=${errorDiagnostic(err)}`,
          );
        }
      }),
    );
  }

  /**
   * Drop the aggregated inbound stream and speaking state for a peer whose pc is
   * being discarded. Without this, the next pc's `ontrack` appends fresh tracks to
   * a stream that still holds ended tracks from the closed connection.
   */
  private resetRemoteMedia(agentId: string): void {
    const stream = this.remoteStreamsByPeer.get(agentId);
    stream?.getTracks().forEach((track) => stream.removeTrack(track));
    this.remoteStreamsByPeer.delete(agentId);
    this.platform.speaking.stop(agentId);
    this.onRemoteStream?.(agentId, null);
    this.debugPeer(agentId, "inbound media detached");
  }

  closePeer(agentId: string): void {
    this.logPeer(agentId, "teardown");
    this.stopStatsSampler(agentId);
    this.clearTrackObservers(agentId);
    this.clearDtlsObserver(agentId);
    this.peers.get(agentId)?.close();
    this.peers.delete(agentId);
    this.pendingCandidates.delete(agentId);
    this.pendingEoc.delete(agentId);
    this.offererPeers.delete(agentId);
    this.iceRestartAttempts.delete(agentId);
    this.reconnectAttempts.delete(agentId);
    this.recovering.delete(agentId);
    this.awaitingRecoveryDescription.delete(agentId);
    this.clearDtlsWatchdog(agentId);
    this.clearAcceptorGiveup(agentId);
    this.clearRecoveryTimeout(agentId);
    this.videoSenders.delete(agentId);
    this.resetRemoteMedia(agentId);
  }

  closeAll(): void {
    for (const agentId of [...this.peers.keys()]) {
      this.closePeer(agentId);
    }
    this.pendingCandidates.clear();
    this.pendingEoc.clear();
    this.offererPeers.clear();
    this.iceRestartAttempts.clear();
    this.reconnectAttempts.clear();
    this.recovering.clear();
    this.awaitingRecoveryDescription.clear();
    for (const disarm of this.dtlsWatchdogs.values()) disarm();
    this.dtlsWatchdogs.clear();
    for (const id of this.giveupTimers.values()) clearTimeout(id);
    this.giveupTimers.clear();
    for (const id of this.recoveryTimers.values()) clearTimeout(id);
    this.recoveryTimers.clear();
    this.videoSenders.clear();
    this.remoteStreamsByPeer.clear();
    for (const agentId of [...this.statsTimers.keys()]) {
      this.stopStatsSampler(agentId);
    }
    for (const agentId of [...this.trackObservers.keys()]) {
      this.clearTrackObservers(agentId);
    }
    for (const agentId of [...this.dtlsObservers.keys()]) {
      this.clearDtlsObserver(agentId);
    }
    // Stop all remaining speaking detectors (includes local "self" detection).
    this.platform.speaking.stopAll();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }

  // -------------------------------------------------------------------------
  // Local media
  // -------------------------------------------------------------------------

  private audioConstraint(): boolean | MediaTrackConstraints {
    return this.preferredMicId ? { deviceId: { ideal: this.preferredMicId } } : true;
  }

  private videoConstraint(): boolean | MediaTrackConstraints {
    return this.preferredCameraId ? { deviceId: { ideal: this.preferredCameraId } } : true;
  }

  private async acquireLocalStream(): Promise<MediaStreamLike> {
    if (this.localStream !== null) return this.localStream;
    // Dedupe concurrent acquisition: overlapping callers (e.g. initLocalMedia racing
    // an inbound offer) would otherwise each open their own mic/camera streams, and
    // closeAll() only stops the single stream finally assigned to this.localStream.
    if (this.localStreamPromise !== null) return this.localStreamPromise;

    this.localStreamPromise = this.createLocalStream();
    try {
      this.localStream = await this.localStreamPromise;
      return this.localStream;
    } finally {
      this.localStreamPromise = null;
    }
  }

  private async createLocalStream(): Promise<MediaStreamLike> {
    // Trigger the OS-level permission prompt before getUserMedia.
    const access = await this.deps.requestMediaAccess();
    this.emit(
      "debug",
      `webrtc: local permissions camera=${access.camera ? "granted" : "denied"} microphone=${access.microphone ? "granted" : "denied"}`,
    );

    const stream = new this.platform.MediaStream();

    // Microphone — required. Throw with an actionable message if denied.
    if (!access.microphone) {
      throw new Error(
        "Microphone access denied. Grant microphone permission for this app and try again.",
      );
    }
    try {
      const s = await this.platform.getUserMedia({ audio: this.audioConstraint() });
      s.getAudioTracks().forEach((t) => {
        // Honour a mute toggled before media existed, so a pre-join mute is not lost.
        t.enabled = !this.micMuted;
        stream.addTrack(t);
        this.emit(
          "debug",
          `webrtc: local audio track acquired enabled=${t.enabled} muted=${t.muted} state=${t.readyState}`,
        );
      });
    } catch (err) {
      throw new Error(
        typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "NotAllowedError"
          ? "Microphone access denied. Grant microphone permission for this app and try again."
          : "Microphone unavailable. Check that it is not in use by another app.",
      );
    }

    // Camera — optional. Skip when turned off, denied, or unavailable.
    if (access.camera && this.camEnabled) {
      try {
        const s = await this.platform.getUserMedia({ video: this.videoConstraint() });
        s.getVideoTracks().forEach((t) => {
          stream.addTrack(t);
          this.emit(
            "debug",
            `webrtc: local video track acquired enabled=${t.enabled} muted=${t.muted} state=${t.readyState}`,
          );
        });
      } catch {
        // Camera unavailable — continue audio-only.
        this.emit("debug", "webrtc: local video track unavailable; using audio only");
      }
    }

    return stream;
  }

  // -------------------------------------------------------------------------
  // Peer connection lifecycle
  // -------------------------------------------------------------------------

  private buildPeerConnection(agentId: string, relayOnly = false): RTCPeerConnection {
    // relayOnly forces all media through TURN (iceTransportPolicy 'relay'): the
    // last recovery rung, for paths where direct/srflx pairs connect ICE but
    // cannot carry media. Only meaningful when TURN is configured.
    const pc = new this.platform.RTCPeerConnection({
      iceServers: this.deps.iceServers,
      ...(relayOnly && { iceTransportPolicy: "relay" }),
    });
    this.debugPeer(
      agentId,
      `peer connection created icePolicy=${relayOnly ? "relay" : "all"} stun=${this.hasStun()} turn=${this.hasTurn()}`,
    );

    pc.onicecandidate = ({ candidate }) => {
      // null sentinel = gathering complete; forward as empty string per RFC 8838 §13.4.1
      const payload = candidate !== null ? JSON.stringify(candidate.toJSON()) : "";
      this.debugPeer(
        agentId,
        candidate === null
          ? "local ICE end-of-candidates"
          : `local ICE ${candidateDiagnostic(candidate)} sending`,
      );
      this.deps
        .sendSignal(agentId, { kind: "ice", candidate: payload })
        .catch((err: unknown) => {
          this.warnPeer(
            agentId,
            `ICE send failed error=${errorDiagnostic(err)}`,
          );
        });
    };

    pc.ontrack = (ev) => {
      this.observeTrack(agentId, "inbound", ev.track);
      // Aggregate every received track into one stable per-peer stream. Don't rely
      // on ev.streams[0] — it is empty for a track on a transceiver reserved
      // without a stream (camera-off join), and ontrack won't fire again when the
      // camera is later enabled via replaceTrack.
      let stream = this.remoteStreamsByPeer.get(agentId);
      if (stream === undefined) {
        stream = new this.platform.MediaStream();
        this.remoteStreamsByPeer.set(agentId, stream);
      }
      if (!stream.getTracks().some((t) => t.id === ev.track.id)) {
        stream.addTrack(ev.track);
      }

      // Notify view layer — it attaches the stream to the peer's video tile.
      // Whether the peer's video is actually showing is driven by an explicit
      // camera-state message over the room channel (see the view layer), not by
      // the inbound track's mute state, which Chromium reports unreliably for
      // replaceTrack(null).
      this.onRemoteStream?.(agentId, stream);

      // Start speaking detection when the audio track arrives.
      if (ev.track.kind === "audio") {
        this.platform.speaking.stop(agentId);
        this.platform.speaking.start(
          agentId,
          { stream, getStats: () => pc.getStats() },
          (speaking) => this.onSpeakingChange?.(agentId, speaking),
        );
      }
    };

    pc.onsignalingstatechange = () => {
      this.debugPeer(agentId, `signaling -> ${pc.signalingState}`);
    };

    pc.onicegatheringstatechange = () => {
      this.debugPeer(agentId, `ice gathering -> ${pc.iceGatheringState}`);
    };

    // Arm the DTLS-stall watchdog the moment ICE connectivity is established.
    // ICE "connected"/"completed" means STUN checks passed, but media still needs
    // the DTLS handshake to finish (surfaced as connectionState "connected"). On
    // aggressive NATs the path can pass STUN yet drop the DTLS handshake, leaving
    // the call ICE-connected but permanently silent.
    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState;
      // Log every transition. The transient "disconnected" (ICE consent loss)
      // that precedes "failed" is the key signal when diagnosing connection flap.
      this.logPeer(agentId, `ice -> ${ice}`);
      if (ice === "connected" || ice === "completed") {
        if (pc.connectionState !== "connected") this.armDtlsWatchdog(agentId, pc);
      } else if (ice === "failed") {
        this.stopStatsSampler(agentId);
        void this.recoverPeer(agentId, pc);
      } else if (ice === "disconnected" || ice === "closed") {
        this.stopStatsSampler(agentId);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.logPeer(agentId, `conn -> ${state}`);
      if (state === "connected") {
        // Fully established — clear the watchdog and reset the recovery ladder.
        // Read the attempt counters before clearing: a non-zero count means this
        // "connected" is the result of a recovery, not a first-time connect.
        const recovered =
          (this.iceRestartAttempts.get(agentId) ?? 0) > 0 ||
          (this.reconnectAttempts.get(agentId) ?? 0) > 0;
        this.clearRecoveryState(agentId);
        if (recovered) this.logPeer(agentId, "recovered");
        this.startStatsSampler(agentId, pc);
        return;
      }
      this.stopStatsSampler(agentId);
      // A successful (re)negotiation moving us back into checking clears the
      // re-entry guard so the next genuine fault can advance the ladder.
      if (state === "connecting") {
        this.recovering.delete(agentId);
        return;
      }
      if (state === "failed") {
        void this.recoverPeer(agentId, pc);
      } else if (state === "closed") {
        // The new-fingerprint offer path and fullReconnect() close the old pc
        // before installing a replacement. Ignore a late "closed" from a
        // superseded instance so it does not tear down the live connection.
        if (this.peers.get(agentId) !== pc) return;
        this.closePeer(agentId);
      }
    };

    this.peers.set(agentId, pc);
    return pc;
  }

  /** Attaches local tracks to one peer and records their lifecycle. */
  private attachLocalTracks(
    pc: RTCPeerConnection,
    agentId: string,
    stream: MediaStreamLike,
  ): void {
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
      this.observeTrack(agentId, "outbound", track);
    }
  }

  /** Records attachment and lifecycle events without device or track identifiers. */
  private observeTrack(
    agentId: string,
    direction: "inbound" | "outbound",
    track: MediaStreamTrack,
  ): void {
    this.debugPeer(
      agentId,
      `${direction} track attached kind=${track.kind} enabled=${track.enabled} muted=${track.muted} state=${track.readyState}`,
    );
    const onMute = (): void => {
      this.debugPeer(agentId, `${direction} track muted kind=${track.kind}`);
    };
    const onUnmute = (): void => {
      this.debugPeer(agentId, `${direction} track unmuted kind=${track.kind}`);
    };
    const onEnded = (): void => {
      this.debugPeer(agentId, `${direction} track ended kind=${track.kind}`);
    };
    // Some test and React Native shims implement only the track fields.
    if (typeof track.addEventListener !== "function") return;
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);
    const cleanups = this.trackObservers.get(agentId) ?? [];
    cleanups.push(() => {
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
      track.removeEventListener("ended", onEnded);
    });
    this.trackObservers.set(agentId, cleanups);
  }

  private clearTrackObservers(agentId: string): void {
    for (const cleanup of this.trackObservers.get(agentId) ?? []) cleanup();
    this.trackObservers.delete(agentId);
  }

  /** Installs a persistent DTLS transition observer once senders expose it. */
  private observeDtls(agentId: string, pc: RTCPeerConnection): void {
    this.clearDtlsObserver(agentId);
    const transport = pc.getSenders().find((sender) => sender.transport)?.transport;
    if (transport === null || transport === undefined) {
      this.debugPeer(agentId, "dtls transport unavailable");
      return;
    }
    this.debugPeer(agentId, `dtls -> ${transport.state}`);
    const onStateChange = (): void => {
      if (this.peers.get(agentId) !== pc) return;
      this.debugPeer(agentId, `dtls -> ${transport.state}`);
    };
    transport.addEventListener("statechange", onStateChange);
    this.dtlsObservers.set(agentId, () => {
      transport.removeEventListener("statechange", onStateChange);
    });
  }

  private clearDtlsObserver(agentId: string): void {
    this.dtlsObservers.get(agentId)?.();
    this.dtlsObservers.delete(agentId);
  }

  /**
   * Locate this peer's video transceiver, force it `sendrecv`, and remember its
   * sender so the camera can be toggled later via `replaceTrack`. When no video
   * m-line exists yet (camera off at setup) and `createIfMissing` is set, reserve
   * one so the offer still negotiates a sendrecv video section up front.
   */
  private trackVideoSender(
    pc: RTCPeerConnection,
    agentId: string,
    createIfMissing: boolean,
  ): void {
    let tx = pc
      .getTransceivers()
      .find(
        (t) =>
          t.sender.track?.kind === "video" || t.receiver.track?.kind === "video",
      );
    if (tx === undefined && createIfMissing) {
      tx = pc.addTransceiver("video", { direction: "sendrecv" });
    }
    if (tx === undefined) return;
    if (tx.direction !== "sendrecv") tx.direction = "sendrecv";
    this.videoSenders.set(agentId, tx.sender);
  }

  /** Apply buffered candidates (and end-of-candidates if received early). */
  private async drainPendingCandidates(
    pc: RTCPeerConnection,
    agentId: string,
  ): Promise<void> {
    const buffered = this.pendingCandidates.get(agentId);
    if (buffered !== undefined) {
      this.pendingCandidates.delete(agentId);
      this.debugPeer(agentId, `remote ICE draining count=${buffered.length}`);
      for (const init of buffered) {
        this.debugPeer(
          agentId,
          `remote ICE ${candidateDiagnostic(init)} draining`,
        );
        await this.applyIceCandidate(agentId, pc, new this.platform.RTCIceCandidate(init));
      }
    }
    if (this.pendingEoc.has(agentId)) {
      this.pendingEoc.delete(agentId);
      this.debugPeer(agentId, "remote ICE end-of-candidates draining");
      await this.applyIceCandidate(agentId, pc, { candidate: "" });
    }
  }

  /**
   * Add one ICE candidate, swallowing a rejection so a single bad candidate cannot
   * abort signaling — notably it must not block the fresh-offer flow from creating
   * and sending its answer (the rest of the candidates still establish the path).
   */
  private async applyIceCandidate(
    agentId: string,
    pc: RTCPeerConnection,
    candidate: RTCIceCandidate | RTCIceCandidateInit,
  ): Promise<void> {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      this.warnPeer(
        agentId,
        `ICE candidate rejected error=${errorDiagnostic(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Recovery ladder
  // -------------------------------------------------------------------------

  /**
   * Recovery ladder for a faulted peer connection.
   *
   * Offerer (controlling agent) drives recovery:
   *   1. ICE restart up to MAX_ICE_RESTARTS — keeps the pc and DTLS session.
   *   2. Full reconnect up to MAX_FULL_RECONNECTS — rebuilds the pc from scratch.
   *   3. Give up — close the peer.
   *
   * Acceptor cannot initiate negotiation, so it waits for the offerer's recovery
   * offer behind a bounded give-up timer (see armAcceptorGiveup).
   */
  private async recoverPeer(agentId: string, pc: RTCPeerConnection): Promise<void> {
    if (this.peers.get(agentId) !== pc) return; // superseded — stale event
    if (this.recovering.has(agentId)) return; // collapse failed-state/watchdog double-fire
    this.recovering.add(agentId);
    this.clearDtlsWatchdog(agentId);

    if (!this.offererPeers.has(agentId)) {
      // Acceptor: can't drive recovery. Wait for the offerer's recovery offer.
      this.logPeer(agentId, "connection lost — awaiting peer's recovery offer (acceptor)");
      // The pc still holds the failed session's remote description; mark that a
      // fresh one is pending so the restart's ICE is buffered, and drop stale
      // candidates from the dead generation that would otherwise be drained into it.
      this.awaitingRecoveryDescription.add(agentId);
      this.pendingCandidates.delete(agentId);
      this.pendingEoc.delete(agentId);
      this.armAcceptorGiveup(agentId);
      return;
    }

    const iceTries = this.iceRestartAttempts.get(agentId) ?? 0;
    if (iceTries < MAX_ICE_RESTARTS) {
      this.iceRestartAttempts.set(agentId, iceTries + 1);
      this.logPeer(agentId, `recovery: ICE restart ${iceTries + 1}/${MAX_ICE_RESTARTS}`);
      await this.restartIce(agentId, pc);
      this.armRecoveryTimeout(agentId);
      return;
    }

    const fullTries = this.reconnectAttempts.get(agentId) ?? 0;
    if (fullTries < MAX_FULL_RECONNECTS) {
      this.reconnectAttempts.set(agentId, fullTries + 1);
      // Escalate: the first full reconnect retries direct (a fresh pc may gather a
      // new NAT mapping that connects). Subsequent attempts force relay-only when
      // TURN exists, for paths that connect ICE directly but can't carry media.
      const relayOnly = this.hasTurn() && fullTries >= 1;
      this.logPeer(
        agentId,
        `recovery: full reconnect ${fullTries + 1}/${MAX_FULL_RECONNECTS}${relayOnly ? " (relay-only)" : ""}`,
      );
      await this.fullReconnect(agentId, relayOnly);
      this.armRecoveryTimeout(agentId);
      return;
    }

    // Ladder exhausted.
    this.logPeer(agentId, "recovery exhausted — giving up, closing peer");
    this.closePeer(agentId);
  }

  private async restartIce(agentId: string, pc: RTCPeerConnection): Promise<void> {
    // The pc keeps the old answer as its remote description until the restart's
    // answer arrives. Buffer the new generation's ICE until then, and drop stale
    // candidates from the dead generation so they are not drained into the restart.
    this.awaitingRecoveryDescription.add(agentId);
    this.pendingCandidates.delete(agentId);
    this.pendingEoc.delete(agentId);
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      this.logSdp(agentId, "local", "offer", offer.sdp ?? "");
      await pc.setLocalDescription(offer);
      await this.deps.sendSignal(agentId, { kind: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      this.warnPeer(
        agentId,
        `ICE restart failed error=${errorDiagnostic(err)}`,
      );
      this.closePeer(agentId);
    }
  }

  /**
   * Tear down the current pc and rebuild it with a fresh offer, preserving the
   * recovery counters so the ladder keeps its place across the rebuild. Resets
   * only the ICE-restart rung, which belongs to the now-discarded pc.
   */
  private async fullReconnect(agentId: string, relayOnly = false): Promise<void> {
    let stream: MediaStreamLike;
    try {
      stream = await this.acquireLocalStream();
    } catch (err) {
      this.warnPeer(
        agentId,
        `full reconnect aborted (no media) error=${errorDiagnostic(err)}`,
      );
      this.closePeer(agentId);
      return;
    }

    // Discard the dead pc and its per-pc buffers, but keep offererPeers and the
    // reconnectAttempts ladder so recoverPeer can continue escalating.
    this.stopStatsSampler(agentId);
    this.clearTrackObservers(agentId);
    this.clearDtlsObserver(agentId);
    this.peers.get(agentId)?.close();
    this.peers.delete(agentId);
    this.pendingCandidates.delete(agentId);
    this.pendingEoc.delete(agentId);
    this.videoSenders.delete(agentId);
    this.clearDtlsWatchdog(agentId);
    this.iceRestartAttempts.delete(agentId);
    // Fresh pc means a fresh remote description is pending; buffer its ICE and
    // discard the old generation's aggregated stream so ontrack starts clean.
    this.awaitingRecoveryDescription.add(agentId);
    this.resetRemoteMedia(agentId);

    const pc = this.buildPeerConnection(agentId, relayOnly);
    this.attachLocalTracks(pc, agentId, stream);
    this.trackVideoSender(pc, agentId, true);
    this.observeDtls(agentId, pc);
    try {
      const offer = await pc.createOffer();
      this.logSdp(agentId, "local", "offer", offer.sdp ?? "");
      await pc.setLocalDescription(offer);
      await this.deps.sendSignal(agentId, { kind: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      this.warnPeer(
        agentId,
        `full reconnect offer failed error=${errorDiagnostic(err)}`,
      );
      this.closePeer(agentId);
      return;
    }
    this.recovering.delete(agentId);
  }

  /**
   * Arm the offerer's per-attempt recovery timeout. If the dispatched attempt has
   * not reached "connected" when it fires, the attempt stalled (lost answer, or a
   * hung ICE/DTLS check that never surfaced as "failed"): clear the in-flight
   * guard and re-enter recoverPeer, which advances to the next ladder rung.
   */
  private armRecoveryTimeout(agentId: string): void {
    this.clearRecoveryTimeout(agentId);
    const id = setTimeout(() => {
      this.recoveryTimers.delete(agentId);
      const pc = this.peers.get(agentId);
      if (pc === undefined) return; // already closed
      if (pc.connectionState === "connected") return; // attempt succeeded
      this.warnPeer(
        agentId,
        `recovery attempt stalled (conn=${pc.connectionState}) — advancing ladder`,
      );
      this.recovering.delete(agentId); // release the guard so the next rung can run
      void this.recoverPeer(agentId, pc);
    }, RECOVERY_ATTEMPT_MS);
    this.recoveryTimers.set(agentId, id);
  }

  private clearRecoveryTimeout(agentId: string): void {
    const id = this.recoveryTimers.get(agentId);
    if (id !== undefined) {
      clearTimeout(id);
      this.recoveryTimers.delete(agentId);
    }
  }

  /**
   * Arm (or re-arm) the DTLS-stall watchdog for a peer.
   *
   * Watches the DTLS transport directly rather than a candidate-type proxy, so it
   * neither false-positives on slow paths nor misses a stalled handshake:
   *   - fail-fast: transport "failed" means recover immediately, no timer wait.
   *   - backstop: a handshake that hangs without ever firing "failed" is caught by
   *     a generous timer (DTLS_STALL_MS) that only acts if DTLS is not connected.
   *
   * If no DTLS transport is resolvable (no senders, or a platform like
   * react-native-webrtc that does not expose RTCDtlsTransport), fall back to the
   * backstop timer keyed on aggregate connectionState.
   */
  private armDtlsWatchdog(agentId: string, pc: RTCPeerConnection): void {
    this.clearDtlsWatchdog(agentId);

    const dtls = pc.getSenders().find((s) => s.transport)?.transport ?? null;

    const onStateChange = () => {
      if (this.peers.get(agentId) !== pc) return; // superseded
      if (dtls!.state === "connected") {
        this.clearDtlsWatchdog(agentId);
      } else if (dtls!.state === "failed") {
        this.warnPeer(agentId, "DTLS failed — recovering");
        void this.recoverPeer(agentId, pc);
      }
    };

    const timer = setTimeout(() => {
      if (this.peers.get(agentId) !== pc) return; // superseded
      if (pc.connectionState === "connected") return; // healed in the meantime
      this.warnPeer(
        agentId,
        `DTLS stall (ice=${pc.iceConnectionState}, dtls=${dtls?.state ?? "n/a"}, conn=${pc.connectionState}) — recovering`,
      );
      void this.recoverPeer(agentId, pc);
    }, DTLS_STALL_MS);

    if (dtls !== null) {
      dtls.addEventListener("statechange", onStateChange);
    }

    this.dtlsWatchdogs.set(agentId, () => {
      clearTimeout(timer);
      if (dtls !== null) dtls.removeEventListener("statechange", onStateChange);
    });
  }

  private clearDtlsWatchdog(agentId: string): void {
    const disarm = this.dtlsWatchdogs.get(agentId);
    if (disarm !== undefined) {
      disarm();
      this.dtlsWatchdogs.delete(agentId);
    }
  }

  /**
   * Acceptor-side bounded wait for the offerer's recovery offer. If the offer
   * arrives, handleSignal clears this timer; if it never comes, reap the peer so
   * the UI does not show a dead tile forever.
   */
  private armAcceptorGiveup(agentId: string): void {
    if (this.giveupTimers.has(agentId)) return;
    const id = setTimeout(() => {
      this.giveupTimers.delete(agentId);
      if (this.peers.get(agentId)?.connectionState !== "connected") {
        this.closePeer(agentId);
      }
    }, ACCEPTOR_GIVEUP_MS);
    this.giveupTimers.set(agentId, id);
  }

  private clearAcceptorGiveup(agentId: string): void {
    const id = this.giveupTimers.get(agentId);
    if (id !== undefined) {
      clearTimeout(id);
      this.giveupTimers.delete(agentId);
    }
  }

  /** Clear all recovery bookkeeping after a peer reaches a healthy state. */
  private clearRecoveryState(agentId: string): void {
    this.iceRestartAttempts.delete(agentId);
    this.reconnectAttempts.delete(agentId);
    this.recovering.delete(agentId);
    this.awaitingRecoveryDescription.delete(agentId);
    this.clearDtlsWatchdog(agentId);
    this.clearAcceptorGiveup(agentId);
    this.clearRecoveryTimeout(agentId);
  }

  private hasTurn(): boolean {
    return this.deps.iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
    });
  }

  private hasStun(): boolean {
    return this.deps.iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => url.startsWith("stun:") || url.startsWith("stuns:"));
    });
  }

  // -------------------------------------------------------------------------
  // Logging / diagnostics
  // -------------------------------------------------------------------------

  /** Route a diagnostic line to the injected sink, or the console as fallback. */
  private emit(level: LogLevel, message: string): void {
    if (this.deps.log !== undefined) {
      this.deps.log(level, message);
    } else if (level === "warn") {
      console.warn(message);
    } else if (level === "debug") {
      console.debug(message);
    } else {
      console.info(message);
    }
  }

  /** Short, stable peer tag for log lines: "name (abc123def456)" or the short id. */
  private tag(agentId: string): string {
    // Peer display names come from the room roster (untrusted). Strip control
    // characters so a peer cannot inject newlines/control codes and forge log
    // entries in the persisted diagnostics.
    const name = this.resolvePeerName(agentId)
      ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim();
    const short = agentId.slice(0, 12);
    return name !== undefined && name !== "" ? `${name} (${short})` : short;
  }

  /** Positive lifecycle log for a peer (info level). */
  private logPeer(agentId: string, msg: string): void {
    this.emit("info", `webrtc: ${this.tag(agentId)} ${msg}`);
  }

  /** Detailed lifecycle log for a peer (debug level). */
  private debugPeer(agentId: string, msg: string): void {
    this.emit("debug", `webrtc: ${this.tag(agentId)} ${msg}`);
  }

  /** Fault/warning log for a peer (warn level). */
  private warnPeer(agentId: string, msg: string): void {
    this.emit("warn", `webrtc: ${this.tag(agentId)} ${msg}`);
  }

  /** Logs an offer or answer summary without SDP contents or fingerprints. */
  private logSdp(
    agentId: string,
    direction: "local" | "remote",
    type: "answer" | "offer",
    sdp: string,
  ): void {
    this.debugPeer(agentId, `${direction} ${type} ${sdpDiagnostic(sdp)}`);
  }

  /** Starts an immediate RTP sample followed by five-second samples. */
  private startStatsSampler(agentId: string, pc: RTCPeerConnection): void {
    this.stopStatsSampler(agentId);
    this.debugPeer(agentId, "stats sampler started");
    void this.sampleStats(agentId, pc);
    const timer = setInterval(() => {
      void this.sampleStats(agentId, pc);
    }, RTP_STATS_INTERVAL_MS);
    this.statsTimers.set(agentId, timer);
  }

  private stopStatsSampler(agentId: string): void {
    const timer = this.statsTimers.get(agentId);
    if (timer !== undefined) clearInterval(timer);
    this.statsTimers.delete(agentId);
    this.statsInFlight.delete(agentId);
    this.previousRtpCounters.delete(agentId);
  }

  /** Samples one peer without allowing concurrent getStats calls. */
  private async sampleStats(
    agentId: string,
    pc: RTCPeerConnection,
  ): Promise<void> {
    if (this.statsInFlight.has(agentId)) {
      this.debugPeer(agentId, "stats sample skipped; previous sample in flight");
      return;
    }
    const token = Symbol(agentId);
    this.statsInFlight.set(agentId, token);
    try {
      const stats = await pc.getStats();
      if (
        this.statsInFlight.get(agentId) !== token ||
        this.peers.get(agentId) !== pc ||
        pc.connectionState !== "connected"
      ) {
        return;
      }
      this.debugPeer(agentId, this.formatStatsSample(agentId, stats));
    } catch {
      if (
        this.statsInFlight.get(agentId) === token &&
        this.peers.get(agentId) === pc
      ) {
        this.debugPeer(agentId, "stats sample unavailable");
      }
    } finally {
      if (this.statsInFlight.get(agentId) === token) {
        this.statsInFlight.delete(agentId);
      }
    }
  }

  /** Builds a compact path and RTP summary from a stats report. */
  private formatStatsSample(
    agentId: string,
    stats: RTCStatsReport,
  ): string {
    const reports: DiagnosticStat[] = [];
    stats.forEach((report: unknown) => {
      reports.push(report as DiagnosticStat);
    });
    const reportsById = new Map<string, DiagnosticStat>();
    for (const report of reports) {
      if (typeof report.id === "string") reportsById.set(report.id, report);
    }

    const selectedPairId = reports.find(
      (report) =>
        report.type === "transport" &&
        typeof report.selectedCandidatePairId === "string",
    )?.selectedCandidatePairId;
    const pair =
      (typeof selectedPairId === "string"
        ? reportsById.get(selectedPairId)
        : undefined) ??
      reports.find(
        (report) =>
          report.type === "candidate-pair" &&
          report.state === "succeeded" &&
          (report.nominated === true || report.selected === true),
      );
    const local =
      typeof pair?.localCandidateId === "string"
        ? reportsById.get(pair.localCandidateId)
        : undefined;
    const remote =
      typeof pair?.remoteCandidateId === "string"
        ? reportsById.get(pair.remoteCandidateId)
        : undefined;
    const relayProtocol = safeDiagnosticToken(
      local?.relayProtocol ?? remote?.relayProtocol,
    );
    const rtt =
      typeof pair?.currentRoundTripTime === "number"
        ? `${Math.round(pair.currentRoundTripTime * 1_000)}ms`
        : "unknown";
    const path =
      `path local=${safeDiagnosticToken(local?.candidateType)}/${safeDiagnosticToken(local?.protocol)}` +
      ` remote=${safeDiagnosticToken(remote?.candidateType)}/${safeDiagnosticToken(remote?.protocol)}` +
      ` relayProtocol=${relayProtocol} rtt=${rtt}`;

    const aggregates = new Map<string, RtpAggregate>();
    for (const report of reports) {
      const direction =
        report.type === "inbound-rtp"
          ? "inbound"
          : report.type === "outbound-rtp"
            ? "outbound"
            : undefined;
      if (direction === undefined) continue;
      const kind = safeDiagnosticToken(report.kind ?? report.mediaType);
      if (kind !== "audio" && kind !== "video") continue;
      const key = `${direction}.${kind}`;
      const aggregate = aggregates.get(key) ?? {
        bytes: 0,
        direction,
        framesDecoded: 0,
        framesDropped: 0,
        framesEncoded: 0,
        kind,
        packets: 0,
        packetsLost: 0,
      };
      aggregate.bytes += numericStat(
        direction === "inbound" ? report.bytesReceived : report.bytesSent,
      );
      aggregate.packets += numericStat(
        direction === "inbound" ? report.packetsReceived : report.packetsSent,
      );
      aggregate.packetsLost += numericStat(report.packetsLost);
      aggregate.framesDecoded += numericStat(report.framesDecoded);
      aggregate.framesDropped += numericStat(report.framesDropped);
      aggregate.framesEncoded += numericStat(report.framesEncoded);
      if (typeof report.jitter === "number") {
        aggregate.jitter = Math.max(aggregate.jitter ?? 0, report.jitter);
      }
      if (typeof report.audioLevel === "number") {
        aggregate.audioLevel = Math.max(
          aggregate.audioLevel ?? 0,
          report.audioLevel,
        );
      }
      aggregates.set(key, aggregate);
    }

    const previous = this.previousRtpCounters.get(agentId) ?? new Map();
    const next = new Map<string, RtpCounter>();
    const rtp = [...aggregates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, aggregate]) => {
        const baseline = previous.get(key);
        const byteDelta =
          baseline === undefined ? "initial" : String(aggregate.bytes - baseline.bytes);
        const packetDelta =
          baseline === undefined
            ? "initial"
            : String(aggregate.packets - baseline.packets);
        next.set(key, {bytes: aggregate.bytes, packets: aggregate.packets});
        const jitter =
          aggregate.jitter === undefined
            ? ""
            : ` jitter=${Math.round(aggregate.jitter * 1_000)}ms`;
        const audioLevel =
          aggregate.audioLevel === undefined
            ? ""
            : ` audioLevel=${aggregate.audioLevel.toFixed(3)}`;
        return (
          `${key} bytes=${aggregate.bytes}(+${byteDelta})` +
          ` packets=${aggregate.packets}(+${packetDelta})` +
          ` lost=${aggregate.packetsLost}${jitter}` +
          ` framesEncoded=${aggregate.framesEncoded}` +
          ` framesDecoded=${aggregate.framesDecoded}` +
          ` framesDropped=${aggregate.framesDropped}${audioLevel}`
        );
      })
      .join("; ");
    this.previousRtpCounters.set(agentId, next);
    return `stats ${path} rtp=${rtp || "none"}`;
  }
}
