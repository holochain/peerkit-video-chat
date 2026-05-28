import type { WebRtcSignal } from "@peerkit-video-chat/core";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.services.mozilla.com" },
];

const peers = new Map<string, RTCPeerConnection>();
// ICE candidates that arrived before the offer was processed (RFC 8829 §4.1.19)
const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
// End-of-candidates received before the peer connection existed
const pendingEoc = new Set<string>();
// Peers for which we are the controlling agent (offerer) — only the offerer restarts ICE
const offererPeers = new Set<string>();
// ICE restart attempts since last successful connection, per peer (RFC 8445 §9)
const iceRestartAttempts = new Map<string, number>();

let localStream: MediaStream | null = null;
let preferredCameraId = '';
let preferredMicId = '';

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

  // Camera — optional. Skip silently if denied or unavailable.
  if (access.camera) {
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

function buildPeerConnection(agentId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected" || state === "completed") {
      iceRestartAttempts.delete(agentId);
      return;
    }
    if (state === "failed") {
      if (offererPeers.has(agentId)) {
        const attempts = (iceRestartAttempts.get(agentId) ?? 0) + 1;
        if (attempts <= 3) {
          iceRestartAttempts.set(agentId, attempts);
          void restartIce(agentId, pc);
          return;
        }
      }
      closePeer(agentId);
    } else if (state === "closed") {
      closePeer(agentId);
    }
  };

  peers.set(agentId, pc);
  return pc;
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
      // Accept renegotiation offers only during failure states (ICE restart from
      // the remote offerer, RFC 8445 §9). Drop during healthy states to guard against glare.
      const cs = existingPc.connectionState;
      if (cs !== "failed" && cs !== "disconnected") return;
      // Clear stale pre-restart candidates — fresh ones will follow.
      pendingCandidates.delete(fromAgentId);
      pendingEoc.delete(fromAgentId);
      await existingPc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await existingPc.createAnswer();
      await existingPc.setLocalDescription(answer);
      await window.app.sendSignal(fromAgentId, { kind: "answer", sdp: answer.sdp ?? "" });
      return;
    }
    const stream = await acquireLocalStream();
    const pc = buildPeerConnection(fromAgentId);
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
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
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    if (videoTracks.length) {
      videoTracks.forEach((t) => {
        // If video track has been muted, stop video track and remove it.
        if (muted) {
          t.stop();
          localStream?.removeTrack(t);
        }
      });
    } else if (!muted) {
      // If cam has been enabled but there are no video tracks (camera off),
      // get a new video track and add it to the stream.
      const videoConstraint = preferredCameraId ? { deviceId: { ideal: preferredCameraId } } : true;
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
      s.getVideoTracks().forEach((t) => localStream?.addTrack(t));
    }
  }
}
