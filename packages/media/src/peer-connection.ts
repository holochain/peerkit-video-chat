/**
 * Shared WebRTC media controller.
 *
 * Platform-neutral: holds the recovery ladder (ICE restart, then full reconnect,
 * then relay-only), the DTLS-stall watchdog, pending-candidate buffering, DTLS
 * fingerprint routing, and transceiver/`replaceTrack` camera toggling. It reaches
 * for no browser or react-native global at import time — every platform binding
 * (the WebRTC constructors, `getUserMedia`, the speaking detector) is injected
 * via {@link MediaPlatform}. `index.web.ts` and `index.rn.ts` are thin files that
 * build a platform and hand it here, so both consumers run the *same* resilience
 * logic instead of diverging reimplementations.
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
} from "./index.js";

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
 * Per-platform speaking detector. The web build reads the stream through an
 * `AnalyserNode`; the react-native build polls `getStats()` audioLevel. Each
 * tracks its own per-agent state and emits a trailing `false` on stop.
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

  private localStream: MediaStreamLike | null = null;
  private preferredCameraId = "";
  private preferredMicId = "";
  // Whether the camera should be live. When false we never open the camera nor
  // hold a video track — toggling it on acquires one on demand (see setCamMuted).
  private camEnabled = true;

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
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    // Reserve a sendrecv video m-line even when the camera is off, so it can be
    // enabled mid-call via replaceTrack without renegotiating.
    this.trackVideoSender(pc, toAgentId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.deps.sendSignal(toAgentId, { kind: "offer", sdp: offer.sdp ?? "" });
  }

  async handleSignal(fromAgentId: string, signal: WebRtcSignal): Promise<void> {
    if (signal.kind === "offer") {
      const existingPc = this.peers.get(fromAgentId);
      if (existingPc !== undefined) {
        // A recovery offer landed — cancel the acceptor's give-up timer.
        this.clearAcceptorGiveup(fromAgentId);
        const incomingFp = sdpFingerprint(signal.sdp);
        const currentFp = sdpFingerprint(existingPc.currentRemoteDescription?.sdp ?? "");
        if (incomingFp !== "" && incomingFp === currentFp) {
          // Same DTLS identity = ICE restart from the remote offerer (RFC 8445 §9).
          // Apply to the existing pc to preserve its DTLS session (fast path).
          // Clear stale pre-restart candidates — fresh ones will follow.
          this.pendingCandidates.delete(fromAgentId);
          this.pendingEoc.delete(fromAgentId);
          await existingPc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
          const answer = await existingPc.createAnswer();
          await existingPc.setLocalDescription(answer);
          await this.deps.sendSignal(fromAgentId, { kind: "answer", sdp: answer.sdp ?? "" });
          return;
        }
        // Different DTLS identity = the remote rebuilt its connection (full
        // reconnect or page reload). Our pc is stale and its m-lines won't match
        // the fresh offer — discard it and accept the offer on a new pc by
        // falling through to the fresh-acceptor path below.
        existingPc.close();
        this.peers.delete(fromAgentId);
        this.pendingCandidates.delete(fromAgentId);
        this.pendingEoc.delete(fromAgentId);
        this.videoSenders.delete(fromAgentId);
        this.clearDtlsWatchdog(fromAgentId);
        this.recovering.delete(fromAgentId);
      }
      this.logPeer(fromAgentId, "received offer — answering");
      const stream = await this.acquireLocalStream();
      const pc = this.buildPeerConnection(fromAgentId);
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      // Match the offerer's reserved video m-line so we can enable our camera
      // mid-call via replaceTrack (offer already carries a sendrecv video section).
      this.trackVideoSender(pc, fromAgentId, false);
      // Drain any candidates that arrived before the offer (RFC 8829 §4.1.19)
      await this.drainPendingCandidates(pc, fromAgentId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.deps.sendSignal(fromAgentId, { kind: "answer", sdp: answer.sdp ?? "" });
      return;
    }

    const pc = this.peers.get(fromAgentId);

    if (signal.kind === "ice") {
      if (signal.candidate === "") {
        // End-of-candidates (RFC 8838 §13.4.1)
        if (pc !== undefined) {
          await pc.addIceCandidate({ candidate: "" });
        } else {
          this.pendingEoc.add(fromAgentId);
        }
        return;
      }
      let init: RTCIceCandidateInit;
      try {
        init = JSON.parse(signal.candidate) as RTCIceCandidateInit;
      } catch {
        this.warnPeer(fromAgentId, "malformed ICE candidate received");
        return;
      }
      if (pc === undefined) {
        // Offer not yet processed — buffer for drain after setRemoteDescription
        const buf = this.pendingCandidates.get(fromAgentId) ?? [];
        buf.push(init);
        this.pendingCandidates.set(fromAgentId, buf);
        return;
      }
      await pc.addIceCandidate(new this.platform.RTCIceCandidate(init));
      return;
    }

    // answer
    if (pc === undefined) return;
    this.logPeer(fromAgentId, "received answer");
    await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    await this.drainPendingCandidates(pc, fromAgentId);
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
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
        t.stop();
        this.localStream.removeTrack(t);
      }
      for (const sender of this.videoSenders.values()) {
        void sender.replaceTrack(null);
      }
      return;
    }

    // Unmute: acquire a fresh video track, add it to the local stream for our own
    // preview, and push it to every existing peer connection via replaceTrack so
    // remote participants actually see the camera (the bug this guards against).
    if (this.localStream.getVideoTracks().length > 0) return; // already on
    const s = await this.platform.getUserMedia({ video: this.videoConstraint() });
    const track = s.getVideoTracks()[0];
    if (track === undefined) return;
    // getUserMedia is async: a mute toggle (or call teardown) may have raced ahead
    // while it was pending. If the camera is no longer wanted, or the call is gone,
    // discard the freshly acquired track instead of streaming it to peers.
    if (!this.camEnabled || this.localStream === null) {
      track.stop();
      return;
    }
    this.localStream.addTrack(track);
    await Promise.all(
      [...this.videoSenders.values()].map((sender) => sender.replaceTrack(track)),
    );
  }

  closePeer(agentId: string): void {
    this.peers.get(agentId)?.close();
    this.peers.delete(agentId);
    this.pendingCandidates.delete(agentId);
    this.pendingEoc.delete(agentId);
    this.offererPeers.delete(agentId);
    this.iceRestartAttempts.delete(agentId);
    this.reconnectAttempts.delete(agentId);
    this.recovering.delete(agentId);
    this.clearDtlsWatchdog(agentId);
    this.clearAcceptorGiveup(agentId);
    this.clearRecoveryTimeout(agentId);
    this.videoSenders.delete(agentId);
    this.remoteStreamsByPeer.delete(agentId);
    this.platform.speaking.stop(agentId);
    this.onRemoteStream?.(agentId, null);
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
    for (const disarm of this.dtlsWatchdogs.values()) disarm();
    this.dtlsWatchdogs.clear();
    for (const id of this.giveupTimers.values()) clearTimeout(id);
    this.giveupTimers.clear();
    for (const id of this.recoveryTimers.values()) clearTimeout(id);
    this.recoveryTimers.clear();
    this.videoSenders.clear();
    this.remoteStreamsByPeer.clear();
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

    // Trigger the OS-level permission prompt before getUserMedia.
    const access = await this.deps.requestMediaAccess();

    const stream = new this.platform.MediaStream();

    // Microphone — required. Throw with an actionable message if denied.
    if (!access.microphone) {
      throw new Error(
        "Microphone access denied. Grant microphone permission for this app and try again.",
      );
    }
    try {
      const s = await this.platform.getUserMedia({ audio: this.audioConstraint() });
      s.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (err) {
      throw new Error(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied. Grant microphone permission for this app and try again."
          : "Microphone unavailable. Check that it is not in use by another app.",
      );
    }

    // Camera — optional. Skip when turned off, denied, or unavailable.
    if (access.camera && this.camEnabled) {
      try {
        const s = await this.platform.getUserMedia({ video: this.videoConstraint() });
        s.getVideoTracks().forEach((t) => stream.addTrack(t));
      } catch {
        // Camera unavailable — continue audio-only.
      }
    }

    this.localStream = stream;
    return this.localStream;
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

    pc.onicecandidate = ({ candidate }) => {
      // null sentinel = gathering complete; forward as empty string per RFC 8838 §13.4.1
      const payload = candidate !== null ? JSON.stringify(candidate.toJSON()) : "";
      this.deps
        .sendSignal(agentId, { kind: "ice", candidate: payload })
        .catch((err: unknown) => {
          this.warnPeer(agentId, `ICE send failed: ${String(err)}`);
        });
    };

    pc.ontrack = (ev) => {
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
        void this.recoverPeer(agentId, pc);
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
        void this.logConnectedPath(agentId, pc);
        return;
      }
      // A successful (re)negotiation moving us back into checking clears the
      // re-entry guard so the next genuine fault can advance the ladder.
      if (state === "connecting") {
        this.recovering.delete(agentId);
        return;
      }
      if (state === "failed") {
        void this.recoverPeer(agentId, pc);
      } else if (state === "closed") {
        this.closePeer(agentId);
      }
    };

    this.peers.set(agentId, pc);
    return pc;
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
      for (const init of buffered) {
        await pc.addIceCandidate(new this.platform.RTCIceCandidate(init));
      }
    }
    if (this.pendingEoc.has(agentId)) {
      this.pendingEoc.delete(agentId);
      await pc.addIceCandidate({ candidate: "" });
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
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await this.deps.sendSignal(agentId, { kind: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      this.warnPeer(agentId, `ICE restart failed: ${String(err)}`);
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
      this.warnPeer(agentId, `full reconnect aborted (no media): ${String(err)}`);
      this.closePeer(agentId);
      return;
    }

    // Discard the dead pc and its per-pc buffers, but keep offererPeers and the
    // reconnectAttempts ladder so recoverPeer can continue escalating.
    this.peers.get(agentId)?.close();
    this.peers.delete(agentId);
    this.pendingCandidates.delete(agentId);
    this.pendingEoc.delete(agentId);
    this.videoSenders.delete(agentId);
    this.clearDtlsWatchdog(agentId);
    this.iceRestartAttempts.delete(agentId);

    const pc = this.buildPeerConnection(agentId, relayOnly);
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    this.trackVideoSender(pc, agentId, true);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.deps.sendSignal(agentId, { kind: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      this.warnPeer(agentId, `full reconnect offer failed: ${String(err)}`);
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

  // -------------------------------------------------------------------------
  // Logging / diagnostics
  // -------------------------------------------------------------------------

  /** Route a diagnostic line to the injected sink, or the console as fallback. */
  private emit(level: LogLevel, message: string): void {
    if (this.deps.log !== undefined) {
      this.deps.log(level, message);
    } else if (level === "warn") {
      console.warn(message);
    } else {
      console.info(message);
    }
  }

  /** Short, stable peer tag for log lines: "name (abc123def456)" or the short id. */
  private tag(agentId: string): string {
    const name = this.resolvePeerName(agentId);
    const short = agentId.slice(0, 12);
    return name !== undefined ? `${name} (${short})` : short;
  }

  /** Positive lifecycle log for a peer (info level). */
  private logPeer(agentId: string, msg: string): void {
    this.emit("info", `webrtc: ${this.tag(agentId)} ${msg}`);
  }

  /** Fault/warning log for a peer (warn level). */
  private warnPeer(agentId: string, msg: string): void {
    this.emit("warn", `webrtc: ${this.tag(agentId)} ${msg}`);
  }

  /**
   * After a connection establishes, read the selected candidate pair and log the
   * path type (host / srflx / relay) and round-trip time. The relay case is the
   * signal to watch in multi-party tests — it means the direct path failed and we
   * fell back through TURN. Best-effort; silent if stats are unavailable.
   */
  private async logConnectedPath(
    agentId: string,
    pc: RTCPeerConnection,
  ): Promise<void> {
    try {
      const stats = await pc.getStats();
      let pairType: string | undefined;
      let rttMs: number | undefined;
      const local = new Map<string, string>();
      stats.forEach((r: { type?: string; id?: string; candidateType?: string }) => {
        if (r.type === "local-candidate" && r.id && r.candidateType) {
          local.set(r.id, r.candidateType);
        }
      });
      stats.forEach(
        (r: {
          type?: string;
          state?: string;
          nominated?: boolean;
          localCandidateId?: string;
          currentRoundTripTime?: number;
        }) => {
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
            pairType = r.localCandidateId ? local.get(r.localCandidateId) : undefined;
            if (r.currentRoundTripTime != null) rttMs = Math.round(r.currentRoundTripTime * 1000);
          }
        },
      );
      const path = pairType ?? "unknown";
      const rtt = rttMs != null ? `, rtt=${rttMs}ms` : "";
      this.logPeer(agentId, `connected via ${path}${path === "relay" ? " (TURN)" : ""}${rtt}`);
    } catch {
      this.logPeer(agentId, "connected (path stats unavailable)");
    }
  }
}
