import type { WebRtcSignal } from "@peerkit-video-chat/core";

// Baked at build time by electron-vite `define` (see electron.vite.config.ts).
// Both are "" for dev/unsigned builds with no TURN wired — then we run
// STUN-only and skip the TURN entry entirely.
declare const __TURN_REALM__: string;
declare const __TURN_PASSWORD__: string;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

if (__TURN_PASSWORD__ && __TURN_REALM__) {
  // Our own coturn answers STUN on 3478 as well as serving TURN — self-hosted,
  // no third-party dependency. Listed first so it is preferred over Cloudflare.
  ICE_SERVERS.unshift({ urls: `stun:${__TURN_REALM__}:3478` });
  ICE_SERVERS.push({
    urls: [
      `turn:${__TURN_REALM__}:3478?transport=udp`,
      `turn:${__TURN_REALM__}:3478?transport=tcp`,
      // turns over 443/tcp for peers behind firewalls that only permit 443
      `turns:${__TURN_REALM__}:443?transport=tcp`,
    ],
    username: "peerkit-video-chat-user",
    credential: __TURN_PASSWORD__,
  });
} else {
  // No TURN baked (dev build, or a release built without TURN_REALM/
  // TURN_PASSWORD). Calls between peers that can't connect directly will fail.
  console.warn(
    "TURN not configured - running STUN-only; relayed calls will not work",
  );
}

// Whether a TURN server is available. Gates the relay-only recovery rung: with
// no TURN, iceTransportPolicy 'relay' gathers zero candidates and fails at once,
// so that escalation is skipped when TURN is absent.
const HAS_TURN = Boolean(__TURN_PASSWORD__ && __TURN_REALM__);

const peers = new Map<string, RTCPeerConnection>();
// ICE candidates that arrived before the offer was processed (RFC 8829 §4.1.19)
const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
// End-of-candidates received before the peer connection existed
const pendingEoc = new Set<string>();
// Peers for which we are the controlling agent (offerer) — only the offerer restarts ICE
const offererPeers = new Set<string>();
// ICE restart attempts since last successful connection, per peer (RFC 8445 §9)
const iceRestartAttempts = new Map<string, number>();
// Full-reconnect attempts (fresh RTCPeerConnection) since last success, per peer.
// The recovery ladder escalates here once ICE restarts are exhausted.
const reconnectAttempts = new Map<string, number>();
// DTLS-stall watchdogs, per peer. Stored as a disarm function that clears both
// the backstop timer and the transport statechange listener. Armed when ICE
// connects; watches the DTLS transport directly (fail-fast on "failed", plus a
// generous backstop timer for a handshake that hangs without ever failing).
const dtlsWatchdogs = new Map<string, () => void>();
// Acceptor-side give-up timers, per peer. The acceptor is not the controlling
// agent, so it cannot drive recovery; it waits for the offerer's recovery offer
// and reaps the connection if none arrives in time.
const giveupTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Offerer-side per-attempt recovery timers, per peer. Armed after each recovery
// action (ICE restart / full reconnect) is dispatched. RFC 8445 §9 sets no
// timeout on a restart, so a restart offer whose answer never arrives (signal
// loss) — or an ICE/DTLS check that hangs — would otherwise wedge the ladder
// with connectionState stuck at "failed" and no further event to drive it. When
// this fires before the attempt reaches "connected", the ladder advances.
const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Peers with a recovery action in flight — dedupes the case where the failed
// connectionState event and the DTLS watchdog both fire for the same fault.
const recovering = new Set<string>();
// Recovery ladder bounds. ICE restart keeps the pc and its DTLS session; full
// reconnect rebuilds the pc from scratch; past both rungs we give up.
const MAX_ICE_RESTARTS = 3;
const MAX_FULL_RECONNECTS = 2;
// Backstop grace for a DTLS handshake that hangs without firing "failed"
// (generous: DTLS is ~2 RTT, so even a 500ms relay path completes in ~2s — the
// margin avoids false positives on slow relay/direct paths), and how long the
// acceptor waits for a recovery offer before reaping.
const DTLS_STALL_MS = 10000;
const ACCEPTOR_GIVEUP_MS = 30000;
// How long the offerer waits for a dispatched recovery attempt to reach
// "connected" before declaring it stalled and advancing the ladder. Covers the
// full attempt: answer round-trip + ICE checks + DTLS. Kept above DTLS_STALL_MS
// so a healthy-but-slow attempt is not pre-empted before its own DTLS watchdog.
const RECOVERY_ATTEMPT_MS = 12000;
// The outbound video RTCRtpSender per peer. We pre-negotiate a sendrecv video
// m-line at call setup (even when the camera is off), so toggling the camera
// mid-call is a track swap via replaceTrack — no renegotiation required.
const videoSenders = new Map<string, RTCRtpSender>();

let localStream: MediaStream | null = null;
let preferredCameraId = '';
let preferredMicId = '';
// Whether the camera should be live. When false we never open the camera nor
// hold a video track — toggling it on acquires one on demand (see setCamMuted).
let camEnabled = true;

export function setPreferredDevices(cameraId: string, micId: string): void {
  preferredCameraId = cameraId;
  preferredMicId = micId;
}
let audioCtx: AudioContext | null = null;

// Cleanup functions for per-agent AnalyserNode loops (keyed by agentId, incl. "self")
const analyserCleanup = new Map<string, () => void>();

type StreamCallback = (agentId: string, stream: MediaStream | null) => void;
type SpeakingCallback = (agentId: string, speaking: boolean) => void;

let onRemoteStream: StreamCallback | null = null;
let onSpeakingChange: SpeakingCallback | null = null;

/** Register callback invoked when a remote peer's stream arrives or is removed. */
export function setStreamCallback(cb: StreamCallback): void {
  onRemoteStream = cb;
}

/** Register callback invoked when any peer's speaking state changes. */
export function setSpeakingCallback(cb: SpeakingCallback): void {
  onSpeakingChange = cb;
}

/** Return the local media stream if already acquired, otherwise null. */
export function getLocalStream(): MediaStream | null {
  return localStream;
}

async function acquireLocalStream(): Promise<MediaStream> {
  if (localStream !== null) return localStream;

  // On macOS, trigger the OS-level TCC permission dialog before getUserMedia.
  const access = await window.app.requestMediaAccess();

  const stream = new MediaStream();

  // Microphone — required. Throw with an actionable message if denied.
  if (!access.microphone) {
    throw new Error(
      "Microphone access denied. Open System Settings → Privacy & Security → Microphone and allow access for this app.",
    );
  }
  const audioConstraint = preferredMicId ? { deviceId: { ideal: preferredMicId } } : true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    s.getAudioTracks().forEach((t) => stream.addTrack(t));
  } catch (err) {
    throw new Error(
      err instanceof DOMException && err.name === "NotAllowedError"
        ? "Microphone access denied. Open System Settings → Privacy & Security → Microphone and allow access for this app."
        : "Microphone unavailable. Check that it is not in use by another app.",
    );
  }

  // Camera — optional. Skip when turned off, denied, or unavailable.
  if (access.camera && camEnabled) {
    const videoConstraint = preferredCameraId ? { deviceId: { ideal: preferredCameraId } } : true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
      s.getVideoTracks().forEach((t) => stream.addTrack(t));
    } catch {
      // Camera unavailable — continue audio-only.
    }
  }

  localStream = stream;
  return localStream;
}

/**
 * Acquire local media and start speaking detection for the local participant.
 * Returns the stream so the caller can attach it to a self-preview element.
 */
export async function initLocalMedia(
  selfAgentId: string,
): Promise<MediaStream> {
  const stream = await acquireLocalStream();
  stopSpeakingDetection(selfAgentId);
  startSpeakingDetection(selfAgentId, stream);
  return stream;
}

// ---------------------------------------------------------------------------
// Speaking detection via AudioContext + AnalyserNode
// ---------------------------------------------------------------------------

function getAudioCtx(): AudioContext {
  if (audioCtx === null) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function startSpeakingDetection(agentId: string, stream: MediaStream): void {
  const ctx = getAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  // Smooth rapidly to reduce flicker without hiding speech bursts.
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let smoothedRms = 0;
  let speaking = false;
  let rafId = 0;

  function tick() {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const instantRms = Math.sqrt(sum / buf.length);
    // Additional smoothing on top of the native smoothingTimeConstant.
    smoothedRms = smoothedRms * 0.85 + instantRms * 0.15;

    const nowSpeaking = smoothedRms > 0.015;
    if (nowSpeaking !== speaking) {
      speaking = nowSpeaking;
      onSpeakingChange?.(agentId, speaking);
    }
    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  analyserCleanup.set(agentId, () => {
    cancelAnimationFrame(rafId);
    source.disconnect();
    if (speaking) onSpeakingChange?.(agentId, false);
  });
}

function stopSpeakingDetection(agentId: string): void {
  analyserCleanup.get(agentId)?.();
  analyserCleanup.delete(agentId);
}

// ---------------------------------------------------------------------------
// Peer connection management
// ---------------------------------------------------------------------------

function buildPeerConnection(
  agentId: string,
  relayOnly = false,
): RTCPeerConnection {
  // relayOnly forces all media through TURN (iceTransportPolicy 'relay'): the
  // last recovery rung, for paths where direct/srflx pairs connect ICE but
  // cannot carry media. Only meaningful when TURN is configured.
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    ...(relayOnly && { iceTransportPolicy: "relay" }),
  });

  pc.onicecandidate = ({ candidate }) => {
    // null sentinel = gathering complete; forward as empty string per RFC 8838 §13.4.1
    const payload =
      candidate !== null ? JSON.stringify(candidate.toJSON()) : "";
    window.app
      .sendSignal(agentId, { kind: "ice", candidate: payload })
      .catch((err: unknown) => {
        console.warn(
          `webrtc: ICE send to ${agentId.slice(0, 12)} failed:`,
          err,
        );
      });
  };

  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    if (stream === undefined) return;

    // Notify view layer — it attaches the stream to the peer's video tile.
    onRemoteStream?.(agentId, stream);

    // Start speaking detection when the audio track arrives.
    if (ev.track.kind === "audio") {
      stopSpeakingDetection(agentId);
      startSpeakingDetection(agentId, stream);
    }
  };

  // Arm the DTLS-stall watchdog the moment ICE connectivity is established.
  // ICE "connected"/"completed" means STUN checks passed, but media still needs
  // the DTLS handshake to finish (surfaced as connectionState "connected"). On
  // aggressive NATs the path can pass STUN yet drop the DTLS handshake, leaving
  // the call ICE-connected but permanently silent. If the aggregate state has
  // not reached "connected" within DTLS_STALL_MS, treat the path as dead and
  // run the recovery ladder.
  pc.oniceconnectionstatechange = () => {
    const ice = pc.iceConnectionState;
    if (ice === "connected" || ice === "completed") {
      if (pc.connectionState !== "connected") armDtlsWatchdog(agentId, pc);
    } else if (ice === "failed") {
      void recoverPeer(agentId, pc);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") {
      // Fully established — clear the watchdog and reset the recovery ladder.
      clearRecoveryState(agentId);
      return;
    }
    // A successful (re)negotiation moving us back into checking clears the
    // re-entry guard so the next genuine fault can advance the ladder.
    if (state === "connecting") {
      recovering.delete(agentId);
      return;
    }
    if (state === "failed") {
      void recoverPeer(agentId, pc);
    } else if (state === "closed") {
      closePeer(agentId);
    }
  };

  peers.set(agentId, pc);
  return pc;
}

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
 *
 * `pc` is the connection that faulted; ignore the call if it has already been
 * superseded (e.g. a later full reconnect replaced it).
 */
async function recoverPeer(agentId: string, pc: RTCPeerConnection): Promise<void> {
  if (peers.get(agentId) !== pc) return; // superseded — stale event
  if (recovering.has(agentId)) return; // collapse the failed-state/watchdog double-fire
  recovering.add(agentId);
  clearDtlsWatchdog(agentId);

  if (!offererPeers.has(agentId)) {
    // Acceptor: can't drive recovery. Wait for the offerer's recovery offer.
    armAcceptorGiveup(agentId);
    return;
  }

  const iceTries = iceRestartAttempts.get(agentId) ?? 0;
  if (iceTries < MAX_ICE_RESTARTS) {
    iceRestartAttempts.set(agentId, iceTries + 1);
    await restartIce(agentId, pc);
    armRecoveryTimeout(agentId);
    return;
  }

  const fullTries = reconnectAttempts.get(agentId) ?? 0;
  if (fullTries < MAX_FULL_RECONNECTS) {
    reconnectAttempts.set(agentId, fullTries + 1);
    // Escalate: the first full reconnect retries direct (a fresh pc may gather a
    // new NAT mapping that connects). Subsequent attempts force relay-only when
    // TURN exists, for paths that connect ICE directly but can't carry media.
    const relayOnly = HAS_TURN && fullTries >= 1;
    await fullReconnect(agentId, relayOnly);
    armRecoveryTimeout(agentId);
    return;
  }

  // Ladder exhausted.
  closePeer(agentId);
}

/**
 * Arm the offerer's per-attempt recovery timeout. If the dispatched attempt has
 * not reached "connected" when it fires, the attempt stalled (lost answer, or a
 * hung ICE/DTLS check that never surfaced as "failed"): clear the in-flight
 * guard and re-enter recoverPeer, which advances to the next ladder rung. A
 * successful attempt clears this via clearRecoveryState on reaching "connected".
 */
function armRecoveryTimeout(agentId: string): void {
  clearRecoveryTimeout(agentId);
  const id = setTimeout(() => {
    recoveryTimers.delete(agentId);
    const pc = peers.get(agentId);
    if (pc === undefined) return; // already closed
    if (pc.connectionState === "connected") return; // attempt succeeded
    console.warn(
      `webrtc: recovery attempt to ${agentId.slice(0, 12)} stalled (conn=${pc.connectionState}) — advancing ladder`,
    );
    recovering.delete(agentId); // release the guard so the next rung can run
    void recoverPeer(agentId, pc);
  }, RECOVERY_ATTEMPT_MS);
  recoveryTimers.set(agentId, id);
}

function clearRecoveryTimeout(agentId: string): void {
  const id = recoveryTimers.get(agentId);
  if (id !== undefined) {
    clearTimeout(id);
    recoveryTimers.delete(agentId);
  }
}

/**
 * Tear down the current pc and rebuild it with a fresh offer, preserving the
 * recovery counters so the ladder keeps its place across the rebuild. Resets
 * only the ICE-restart rung, which belongs to the now-discarded pc.
 *
 * `relayOnly` builds the replacement pc with iceTransportPolicy 'relay' (final
 * rung): the offerer forcing relay routes its media through TURN, which carries
 * both directions, so the acceptor needs no matching change.
 */
async function fullReconnect(agentId: string, relayOnly = false): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await acquireLocalStream();
  } catch (err) {
    console.warn(`webrtc: full reconnect to ${agentId.slice(0, 12)} aborted (no media):`, err);
    closePeer(agentId);
    return;
  }

  // Discard the dead pc and its per-pc buffers, but keep offererPeers and the
  // reconnectAttempts ladder so recoverPeer can continue escalating.
  peers.get(agentId)?.close();
  peers.delete(agentId);
  pendingCandidates.delete(agentId);
  pendingEoc.delete(agentId);
  videoSenders.delete(agentId);
  clearDtlsWatchdog(agentId);
  iceRestartAttempts.delete(agentId);

  if (relayOnly) {
    console.warn(`webrtc: forcing relay-only reconnect to ${agentId.slice(0, 12)}`);
  }
  const pc = buildPeerConnection(agentId, relayOnly);
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
  }
  trackVideoSender(pc, agentId, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await window.app.sendSignal(agentId, { kind: "offer", sdp: offer.sdp ?? "" });
  } catch (err) {
    console.warn(`webrtc: full reconnect offer to ${agentId.slice(0, 12)} failed:`, err);
    closePeer(agentId);
    return;
  }
  recovering.delete(agentId);
}

/**
 * Arm (or re-arm) the DTLS-stall watchdog for a peer.
 *
 * Watches the DTLS transport directly rather than a candidate-type proxy, so it
 * neither false-positives on slow (relay or high-RTT direct) paths nor misses a
 * stalled handshake on a relayed path:
 *   - fail-fast: transport "failed" → recover immediately, no timer wait.
 *   - backstop: a handshake that hangs without ever firing "failed" is caught by
 *     a generous timer (DTLS_STALL_MS) that only acts if DTLS is not connected.
 *
 * Media-only connections have no SCTP transport, so the DTLS transport is read
 * off a sender. If none is resolvable (no senders / older engine), fall back to
 * a backstop timer keyed on aggregate connectionState.
 */
function armDtlsWatchdog(agentId: string, pc: RTCPeerConnection): void {
  clearDtlsWatchdog(agentId);

  const dtls = pc.getSenders().find((s) => s.transport)?.transport ?? null;

  const onStateChange = () => {
    if (peers.get(agentId) !== pc) return; // superseded
    if (dtls!.state === "connected") {
      clearDtlsWatchdog(agentId);
    } else if (dtls!.state === "failed") {
      console.warn(`webrtc: DTLS failed to ${agentId.slice(0, 12)} — recovering`);
      void recoverPeer(agentId, pc);
    }
  };

  const timer = setTimeout(() => {
    if (peers.get(agentId) !== pc) return; // superseded
    if (pc.connectionState === "connected") return; // healed in the meantime
    console.warn(
      `webrtc: DTLS stall to ${agentId.slice(0, 12)} (ice=${pc.iceConnectionState}, dtls=${dtls?.state ?? "n/a"}, conn=${pc.connectionState}) — recovering`,
    );
    void recoverPeer(agentId, pc);
  }, DTLS_STALL_MS);

  if (dtls !== null) {
    dtls.addEventListener("statechange", onStateChange);
  }

  dtlsWatchdogs.set(agentId, () => {
    clearTimeout(timer);
    if (dtls !== null) dtls.removeEventListener("statechange", onStateChange);
  });
}

function clearDtlsWatchdog(agentId: string): void {
  const disarm = dtlsWatchdogs.get(agentId);
  if (disarm !== undefined) {
    disarm();
    dtlsWatchdogs.delete(agentId);
  }
}

/**
 * Acceptor-side bounded wait for the offerer's recovery offer. If the offer
 * arrives, handleSignal clears this timer; if it never comes, reap the peer so
 * the UI does not show a dead tile forever.
 */
function armAcceptorGiveup(agentId: string): void {
  if (giveupTimers.has(agentId)) return;
  const id = setTimeout(() => {
    giveupTimers.delete(agentId);
    if (peers.get(agentId)?.connectionState !== "connected") {
      closePeer(agentId);
    }
  }, ACCEPTOR_GIVEUP_MS);
  giveupTimers.set(agentId, id);
}

function clearAcceptorGiveup(agentId: string): void {
  const id = giveupTimers.get(agentId);
  if (id !== undefined) {
    clearTimeout(id);
    giveupTimers.delete(agentId);
  }
}

/** Clear all recovery bookkeeping after a peer reaches a healthy state. */
function clearRecoveryState(agentId: string): void {
  iceRestartAttempts.delete(agentId);
  reconnectAttempts.delete(agentId);
  recovering.delete(agentId);
  clearDtlsWatchdog(agentId);
  clearAcceptorGiveup(agentId);
  clearRecoveryTimeout(agentId);
}

/**
 * Locate this peer's video transceiver, force it `sendrecv`, and remember its
 * sender so the camera can be toggled later via `replaceTrack`. When no video
 * m-line exists yet (camera off at setup) and `createIfMissing` is set, reserve
 * one so the offer still negotiates a sendrecv video section up front.
 */
function trackVideoSender(
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
  videoSenders.set(agentId, tx.sender);
}

async function restartIce(agentId: string, pc: RTCPeerConnection): Promise<void> {
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await window.app.sendSignal(agentId, { kind: "offer", sdp: offer.sdp ?? "" });
  } catch (err) {
    console.warn(`webrtc: ICE restart to ${agentId.slice(0, 12)} failed:`, err);
    closePeer(agentId);
  }
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

/** Apply buffered candidates (and end-of-candidates if received early). */
async function drainPendingCandidates(
  pc: RTCPeerConnection,
  agentId: string,
): Promise<void> {
  const buffered = pendingCandidates.get(agentId);
  if (buffered !== undefined) {
    pendingCandidates.delete(agentId);
    for (const init of buffered) {
      await pc.addIceCandidate(new RTCIceCandidate(init));
    }
  }
  if (pendingEoc.has(agentId)) {
    pendingEoc.delete(agentId);
    await pc.addIceCandidate({ candidate: "" });
  }
}

export async function initiateCall(toAgentId: string): Promise<void> {
  if (peers.has(toAgentId)) return;
  const stream = await acquireLocalStream();
  const pc = buildPeerConnection(toAgentId);
  offererPeers.add(toAgentId);
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
  }
  // Reserve a sendrecv video m-line even when the camera is off, so it can be
  // enabled mid-call via replaceTrack without renegotiating.
  trackVideoSender(pc, toAgentId, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await window.app.sendSignal(toAgentId, {
    kind: "offer",
    sdp: offer.sdp ?? "",
  });
}

export async function handleSignal(
  fromAgentId: string,
  signal: WebRtcSignal,
): Promise<void> {
  if (signal.kind === "offer") {
    const existingPc = peers.get(fromAgentId);
    if (existingPc !== undefined) {
      // A recovery offer landed — cancel the acceptor's give-up timer.
      clearAcceptorGiveup(fromAgentId);
      const incomingFp = sdpFingerprint(signal.sdp);
      const currentFp = sdpFingerprint(
        existingPc.currentRemoteDescription?.sdp ?? "",
      );
      if (incomingFp !== "" && incomingFp === currentFp) {
        // Same DTLS identity = ICE restart from the remote offerer (RFC 8445 §9).
        // Apply to the existing pc to preserve its DTLS session (fast path).
        // Clear stale pre-restart candidates — fresh ones will follow.
        pendingCandidates.delete(fromAgentId);
        pendingEoc.delete(fromAgentId);
        await existingPc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        const answer = await existingPc.createAnswer();
        await existingPc.setLocalDescription(answer);
        await window.app.sendSignal(fromAgentId, { kind: "answer", sdp: answer.sdp ?? "" });
        return;
      }
      // Different DTLS identity = the remote rebuilt its connection (full
      // reconnect or page reload). Our pc is stale and its m-lines won't match
      // the fresh offer — discard it and accept the offer on a new pc by
      // falling through to the fresh-acceptor path below.
      existingPc.close();
      peers.delete(fromAgentId);
      pendingCandidates.delete(fromAgentId);
      pendingEoc.delete(fromAgentId);
      videoSenders.delete(fromAgentId);
      clearDtlsWatchdog(fromAgentId);
      recovering.delete(fromAgentId);
    }
    const stream = await acquireLocalStream();
    const pc = buildPeerConnection(fromAgentId);
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
    // Match the offerer's reserved video m-line so we can enable our camera
    // mid-call via replaceTrack (offer already carries a sendrecv video section).
    trackVideoSender(pc, fromAgentId, false);
    // Drain any candidates that arrived before the offer (RFC 8829 §4.1.19)
    await drainPendingCandidates(pc, fromAgentId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await window.app.sendSignal(fromAgentId, {
      kind: "answer",
      sdp: answer.sdp ?? "",
    });
    return;
  }

  const pc = peers.get(fromAgentId);

  if (signal.kind === "ice") {
    if (signal.candidate === "") {
      // End-of-candidates (RFC 8838 §13.4.1)
      if (pc !== undefined) {
        await pc.addIceCandidate({ candidate: "" });
      } else {
        pendingEoc.add(fromAgentId);
      }
      return;
    }
    let init: RTCIceCandidateInit;
    try {
      init = JSON.parse(signal.candidate) as RTCIceCandidateInit;
    } catch {
      console.warn(
        `webrtc: malformed ICE candidate from ${fromAgentId.slice(0, 12)}`,
      );
      return;
    }
    if (pc === undefined) {
      // Offer not yet processed — buffer for drain after setRemoteDescription
      const buf = pendingCandidates.get(fromAgentId) ?? [];
      buf.push(init);
      pendingCandidates.set(fromAgentId, buf);
      return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(init));
    return;
  }

  // answer
  if (pc === undefined) return;
  await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
  await drainPendingCandidates(pc, fromAgentId);
}

export function closePeer(agentId: string): void {
  peers.get(agentId)?.close();
  peers.delete(agentId);
  pendingCandidates.delete(agentId);
  pendingEoc.delete(agentId);
  offererPeers.delete(agentId);
  iceRestartAttempts.delete(agentId);
  reconnectAttempts.delete(agentId);
  recovering.delete(agentId);
  clearDtlsWatchdog(agentId);
  clearAcceptorGiveup(agentId);
  clearRecoveryTimeout(agentId);
  videoSenders.delete(agentId);
  stopSpeakingDetection(agentId);
  onRemoteStream?.(agentId, null);
}

export function closeAll(): void {
  for (const agentId of [...peers.keys()]) {
    closePeer(agentId);
  }
  pendingCandidates.clear();
  pendingEoc.clear();
  offererPeers.clear();
  iceRestartAttempts.clear();
  reconnectAttempts.clear();
  recovering.clear();
  for (const disarm of dtlsWatchdogs.values()) disarm();
  dtlsWatchdogs.clear();
  for (const id of giveupTimers.values()) clearTimeout(id);
  giveupTimers.clear();
  for (const id of recoveryTimers.values()) clearTimeout(id);
  recoveryTimers.clear();
  videoSenders.clear();
  // Stop all remaining analyser nodes (includes local speaking detection).
  for (const agentId of [...analyserCleanup.keys()]) {
    stopSpeakingDetection(agentId);
  }
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
}

export function setMuted(muted: boolean): void {
  localStream?.getAudioTracks().forEach((t) => {
    t.enabled = !muted;
  });
}

export async function setCamMuted(muted: boolean): Promise<void> {
  // Record intent first so a later acquireLocalStream() honours it even when no
  // stream exists yet (e.g. toggled off on the pre-join screen before joining).
  camEnabled = !muted;
  if (localStream === null) return;

  if (muted) {
    // Stop and drop the local video track (releases the camera) and stop
    // sending to every peer. The pre-negotiated video m-lines stay in place
    // so the camera can be turned back on without renegotiation.
    for (const t of localStream.getVideoTracks()) {
      t.stop();
      localStream.removeTrack(t);
    }
    for (const sender of videoSenders.values()) {
      void sender.replaceTrack(null);
    }
    return;
  }

  // Unmute: acquire a fresh video track, add it to the local stream for our own
  // preview, and push it to every existing peer connection via replaceTrack so
  // remote participants actually see the camera (the bug this guards against).
  if (localStream.getVideoTracks().length > 0) return; // already on
  const videoConstraint = preferredCameraId
    ? { deviceId: { ideal: preferredCameraId } }
    : true;
  const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
  const track = s.getVideoTracks()[0];
  if (track === undefined) return;
  // getUserMedia is async: a mute toggle (or call teardown) may have raced ahead
  // while it was pending. If the camera is no longer wanted, or the call is gone,
  // discard the freshly acquired track instead of streaming it to peers.
  if (!camEnabled || localStream === null) {
    track.stop();
    return;
  }
  localStream.addTrack(track);
  await Promise.all(
    [...videoSenders.values()].map((sender) => sender.replaceTrack(track)),
  );
}
