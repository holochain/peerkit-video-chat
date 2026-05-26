import type { WebRtcSignal } from "@peerkit-video-chat/core";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.services.mozilla.com" },
];

const peers = new Map<string, RTCPeerConnection>();
const audioEls = new Map<string, HTMLAudioElement>();
// ICE candidates that arrived before the offer was processed (RFC 8829 §4.1.19)
const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
// End-of-candidates received before the peer connection existed
const pendingEoc = new Set<string>();
let localStream: MediaStream | null = null;

async function acquireLocalStream(): Promise<MediaStream> {
  if (localStream !== null) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return localStream;
}

function buildPeerConnection(agentId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = ({ candidate }) => {
    // null sentinel = gathering complete; forward as empty string per RFC 8838 §13.4.1
    const payload =
      candidate !== null ? JSON.stringify(candidate.toJSON()) : "";
    window.app
      .sendSignal(agentId, { kind: "ice", candidate: payload })
      .catch((err: unknown) => {
        console.warn(`webrtc: ICE send to ${agentId.slice(0, 12)} failed:`, err);
      });
  };

  pc.ontrack = (ev) => {
    let audio = audioEls.get(agentId);
    if (audio === undefined) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      document.getElementById("audio-sink")?.appendChild(audio);
      audioEls.set(agentId, audio);
    }
    audio.srcObject = ev.streams[0] ?? null;
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closePeer(agentId);
    }
  };

  peers.set(agentId, pc);
  return pc;
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
    if (peers.has(fromAgentId)) return;
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
      console.warn(`webrtc: malformed ICE candidate from ${fromAgentId.slice(0, 12)}`);
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
  const audio = audioEls.get(agentId);
  if (audio !== undefined) {
    audio.srcObject = null;
    audio.remove();
    audioEls.delete(agentId);
  }
}

export function closeAll(): void {
  for (const agentId of [...peers.keys()]) {
    closePeer(agentId);
  }
  pendingCandidates.clear();
  pendingEoc.clear();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
}

export function setMuted(muted: boolean): void {
  localStream?.getAudioTracks().forEach((t) => {
    t.enabled = !muted;
  });
}
