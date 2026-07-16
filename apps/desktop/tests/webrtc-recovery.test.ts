/**
 * Recovery-ladder tests for the shared WebRTC media controller.
 *
 * Drives the module black-box: initiateCall / handleSignal / closePeer against a
 * MockPeerConnection, firing lifecycle transitions by hand and asserting on the
 * signals emitted via the injected sendSignal callback. Fake timers exercise the DTLS
 * watchdog, the per-attempt recovery timeout, and the acceptor give-up timer.
 *
 * Globals and the module are (re)installed per test so module-level recovery
 * state never leaks between cases. TURN is configured through the controller
 * dependencies so the relay-only rung is active.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCEPTOR_GIVEUP_MS,
  DTLS_STALL_MS,
  RECOVERY_ATTEMPT_MS,
  RTP_STATS_INTERVAL_MS,
  MockMediaStreamTrack,
  createdPeers,
  flush,
  installGlobals,
  resetPeers,
  sdpWithFingerprint,
  type Harness,
  type MockPeerConnection,
} from "./helpers";

const SELF = "agent-self";
// agent-self < agent-zzz, so when WE initiate we are the offerer. The peer id
// ordering only matters for the app-level offerer election in App.svelte; the
// recovery ladder keys off offererPeers, which initiateCall populates.
const PEER = "agent-zzz";

let h: Harness;
let diagnosticLogs: Array<{ level: string; message: string }>;
// Re-imported per test so the binding picks up freshly-installed globals.
let webrtc: typeof import("../src/renderer/src/webrtc/index");
// A fresh controller instance per test → recovery state never leaks between cases.
let ctrl: import("../src/renderer/src/webrtc/types.js").MediaController;

/** Bring a freshly-initiated offerer connection up to fully connected. */
async function connect(pc: MockPeerConnection): Promise<void> {
  // Answer the initial offer, then walk the transports to connected.
  await ctrl.handleSignal(PEER, {
    kind: "answer",
    sdp: sdpWithFingerprint("FP_REMOTE_0"),
  });
  pc._setIce("connected");
  pc._setDtls("connected");
  pc._setConn("connected");
  await flush();
}

/** The signals emitted to PEER since the start of the test. */
function offersTo(): Array<{ kind: string; sdp?: string }> {
  return h.sent.filter((s) => s.to === PEER).map((s) => s.signal);
}

/**
 * Self-drive the recovery ladder. Once a fault has armed the first per-attempt
 * timeout, each expiry advances one rung and arms the next; rebuilt pcs never
 * connect in the test, so they time out too. Stops early once the peer has been
 * closed (ladder exhausted). `steps` is an upper bound on rungs to walk.
 */
async function pumpLadder(steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(RECOVERY_ATTEMPT_MS + 10);
    await flush();
    const last = createdPeers[createdPeers.length - 1];
    if (last?.close.mock.calls.length && createdPeers.every((p) => p.closed)) {
      break;
    }
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetPeers();
  h = installGlobals();
  diagnosticLogs = [];
  vi.resetModules();
  webrtc = await import("../src/renderer/src/webrtc/index");
  ctrl = webrtc.createMediaController({
    sendSignal: h.sendSignal,
    requestMediaAccess: async () => ({ camera: true, microphone: true }),
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: [
          "turn:turn.example.test:3478?transport=udp",
          "turns:turn.example.test:443?transport=tcp",
        ],
        username: "test",
        credential: "test",
      },
    ],
    log: (level, message) => {
      diagnosticLogs.push({ level, message });
    },
  });
});

afterEach(() => {
  ctrl.closeAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("offer/answer setup", () => {
  it("initiateCall sends an offer and marks us the offerer", async () => {
    await ctrl.initiateCall(PEER);
    await flush();

    expect(createdPeers).toHaveLength(1);
    const offers = offersTo().filter((s) => s.kind === "offer");
    expect(offers).toHaveLength(1);
  });

  it("methods work when destructured off the controller (desktop usage)", async () => {
    // The desktop renderer does `const { initiateCall, closeAll } = controller`
    // and calls them free-standing — methods must keep their `this` binding.
    const { initiateCall, closeAll } = ctrl;
    await initiateCall(PEER);
    await flush();
    expect(createdPeers).toHaveLength(1);
    expect(() => closeAll()).not.toThrow();
  });
});

describe("ICE-restart rung", () => {
  it("restarts ICE on the same pc when the connection fails", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await connect(pc);

    pc._setConn("failed");
    await flush();

    // Same pc reused (no new construction), and the offer was an ICE restart.
    expect(createdPeers).toHaveLength(1);
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
    expect(pc.lastOfferWasRestart).toBe(true);
  });

  it("restarts up to 3 times before escalating to a full reconnect", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await connect(pc);

    // Fail, and let each restart attempt time out without connecting.
    for (let i = 0; i < 3; i++) {
      pc._setConn("failed");
      await flush();
      // Per-attempt timeout fires -> next rung.
      await vi.advanceTimersByTimeAsync(RECOVERY_ATTEMPT_MS + 10);
      await flush();
    }

    // 3 ICE restarts kept the original pc; the 4th attempt builds a fresh one.
    expect(createdPeers.length).toBeGreaterThanOrEqual(2);
    expect(pc.createOffer.mock.calls.filter((c) => c[0]?.iceRestart).length).toBe(3);
  });
});

describe("full-reconnect rung", () => {
  it("builds a fresh pc once ICE restarts are exhausted", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const first = createdPeers[0]!;
    await connect(first);

    // Drive through the 3 ICE restarts.
    for (let i = 0; i < 3; i++) {
      first._setConn("failed");
      await flush();
      await vi.advanceTimersByTimeAsync(RECOVERY_ATTEMPT_MS + 10);
      await flush();
    }

    const fresh = createdPeers[createdPeers.length - 1]!;
    expect(fresh).not.toBe(first);
    expect(first.close).toHaveBeenCalled();
    // The fresh pc is a plain (non-relay) reconnect on the first full attempt.
    expect(fresh.config.iceTransportPolicy).toBeUndefined();
  });

  it("forces relay-only on the second full reconnect", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const first = createdPeers[0]!;
    await connect(first);

    // Kick off the ladder, then let it self-drive: each per-attempt timeout
    // advances one rung. A full reconnect resets the ICE-restart rung for the
    // fresh pc, so the relay-only rung is reached only after both full
    // reconnects — well past a naive "5 steps". Pump generously.
    first._setConn("failed");
    await flush();
    await pumpLadder(15);

    const relayOnly = createdPeers.filter(
      (p) => p.config.iceTransportPolicy === "relay",
    );
    expect(relayOnly.length).toBeGreaterThanOrEqual(1);
  });

  it("closes the peer after the ladder is exhausted", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const first = createdPeers[0]!;
    await connect(first);

    first._setConn("failed");
    await flush();
    await pumpLadder(15);

    // Exhaustion closes the most recently built pc.
    const last = createdPeers[createdPeers.length - 1]!;
    expect(last.close).toHaveBeenCalled();
  });
});

describe("DTLS-stall watchdog", () => {
  it("recovers immediately when DTLS fails (fail-fast)", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await ctrl.handleSignal(PEER, {
      kind: "answer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });

    pc._setIce("connected"); // arms the watchdog
    pc._setDtls("failed"); // fail-fast trigger
    await flush();

    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
  });

  it("recovers when DTLS hangs past the backstop timer", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await ctrl.handleSignal(PEER, {
      kind: "answer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });

    pc._setIce("connected"); // arms the watchdog; DTLS never completes
    await flush();
    expect(pc.lastOfferWasRestart).toBe(false); // not yet

    await vi.advanceTimersByTimeAsync(DTLS_STALL_MS + 10);
    await flush();
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
  });

  it("does not recover when DTLS completes before the backstop", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await connect(pc); // reaches connected, clearing the watchdog
    const offersBefore = offersTo().length;

    await vi.advanceTimersByTimeAsync(DTLS_STALL_MS + 10);
    await flush();

    expect(offersTo().length).toBe(offersBefore); // no recovery offer
  });
});

describe("per-attempt recovery timeout (offerer wedge guard)", () => {
  it("advances the ladder when a restart answer never arrives", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await connect(pc);

    pc._setConn("failed");
    await flush();
    // Restart offer sent, but no answer comes back. Before the timeout, still
    // one pc; after it, the ladder advances (eventually a fresh pc).
    expect(createdPeers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECOVERY_ATTEMPT_MS + 10);
    await flush();
    // Second restart attempt fired on the same pc.
    expect(pc.createOffer.mock.calls.filter((c) => c[0]?.iceRestart).length).toBe(2);
  });
});

describe("recovery-offer routing by DTLS fingerprint", () => {
  it("applies a same-fingerprint offer to the existing pc (ICE restart)", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    // Accept the peer's answer carrying their fingerprint.
    await ctrl.handleSignal(PEER, {
      kind: "answer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    pc._setIce("connected");
    pc._setDtls("connected");
    pc._setConn("connected");
    await flush();

    // Remote sends a recovery offer with the SAME fingerprint = ICE restart.
    pc._setConn("failed"); // allow mid-call offer
    await flush();
    await ctrl.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    await flush();

    // No new pc — applied to the existing one, which produced an answer.
    expect(createdPeers).toHaveLength(1);
    expect(pc.createAnswer).toHaveBeenCalled();
  });

  it("rebuilds on a new-fingerprint offer (remote reload)", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await ctrl.handleSignal(PEER, {
      kind: "answer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    pc._setIce("connected");
    pc._setDtls("connected");
    pc._setConn("connected");
    await flush();

    pc._setConn("failed");
    await flush();
    // DIFFERENT fingerprint = remote rebuilt. Stale pc discarded, fresh accepts.
    await ctrl.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_NEW"),
    });
    await flush();

    expect(pc.close).toHaveBeenCalled();
    expect(createdPeers.length).toBeGreaterThanOrEqual(2);
    const fresh = createdPeers[createdPeers.length - 1]!;
    expect(fresh.createAnswer).toHaveBeenCalled();
  });
});

describe("acceptor give-up", () => {
  it("reaps the connection when no recovery offer arrives in time", async () => {
    // We are the acceptor: the peer initiates by sending us an offer.
    await ctrl.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    await flush();
    const pc = createdPeers[0]!;
    pc._setIce("connected");
    pc._setDtls("connected");
    pc._setConn("connected");
    await flush();

    // Connection fails; the acceptor cannot drive recovery, so it waits.
    pc._setConn("failed");
    await flush();
    expect(pc.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ACCEPTOR_GIVEUP_MS + 10);
    await flush();
    expect(pc.close).toHaveBeenCalled();
  });
});

describe("cleanup", () => {
  it("closePeer cancels timers so no recovery fires afterwards", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await connect(pc);

    pc._setConn("failed"); // arms the per-attempt timeout
    await flush();
    ctrl.closePeer(PEER);
    const peersAfterClose = createdPeers.length;

    await vi.advanceTimersByTimeAsync(RECOVERY_ATTEMPT_MS + DTLS_STALL_MS + 10);
    await flush();

    // No further pcs built, no further offers emitted post-close.
    expect(createdPeers.length).toBe(peersAfterClose);
  });
});

describe("microphone mute intent", () => {
  it("applies a pre-acquisition mute to the acquired audio track", async () => {
    // Muted before any media exists (e.g. on the pre-join screen). initiateCall
    // acquires local media without starting the self speaking detector.
    ctrl.setMuted(true);

    await ctrl.initiateCall(PEER);
    await flush();

    const stream = ctrl.getLocalStream();
    expect(stream).not.toBeNull();
    const audio = stream!.getAudioTracks();
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.every((t) => !t.enabled)).toBe(true);
  });
});

describe("setup failure cleanup", () => {
  it("tears down the peer when initiateCall fails, so a retry can rebuild", async () => {
    h.sendSignal.mockRejectedValueOnce(new Error("signal channel down"));

    await expect(ctrl.initiateCall(PEER)).rejects.toThrow("signal channel down");
    await flush();
    expect(createdPeers[0]!.close).toHaveBeenCalled();

    // The failed peer was removed, so the guard no longer short-circuits the retry.
    await ctrl.initiateCall(PEER);
    await flush();
    expect(createdPeers).toHaveLength(2);
  });
});

describe("recovery ICE generation gating", () => {
  it("buffers acceptor recovery candidates until the new remote description arrives", async () => {
    // We are the acceptor: the peer initiates by sending us an offer.
    await ctrl.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    await flush();
    const pc = createdPeers[0]!;
    pc._setIce("connected");
    pc._setDtls("connected");
    pc._setConn("connected");
    await flush();

    // Connection fails; the acceptor cannot drive recovery, so it waits for the
    // offerer's recovery offer while the dead session's remote description lingers.
    pc._setConn("failed");
    await flush();
    const addsBeforeOffer = pc.addIceCandidate.mock.calls.length;

    // A recovery ICE candidate races ahead of the recovery offer. It belongs to
    // the new generation and must be buffered, not applied to the dead description.
    await ctrl.handleSignal(PEER, {
      kind: "ice",
      candidate: JSON.stringify({ candidate: "x", sdpMid: "0", sdpMLineIndex: 0 }),
    });
    expect(pc.addIceCandidate.mock.calls.length).toBe(addsBeforeOffer);

    // The same-fingerprint recovery offer lands → ICE restart on the same pc,
    // which sets the new remote description and drains the buffered candidate.
    await ctrl.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    await flush();
    expect(pc.addIceCandidate.mock.calls.length).toBeGreaterThan(addsBeforeOffer);
  });
});

function diagnosticStatsSample(
  byteOffset: number,
): Map<string, Record<string, unknown>> {
  return new Map([
    [
      "transport",
      {
        id: "transport",
        type: "transport",
        selectedCandidatePairId: "pair",
      },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.025,
      },
    ],
    [
      "local",
      {
        id: "local",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "tcp",
      },
    ],
    [
      "remote",
      {
        id: "remote",
        type: "remote-candidate",
        candidateType: "host",
        protocol: "tcp",
      },
    ],
    [
      "inbound-audio",
      {
        id: "inbound-audio",
        type: "inbound-rtp",
        kind: "audio",
        bytesReceived: 1_000 + byteOffset,
        packetsReceived: 100 + byteOffset / 10,
        packetsLost: 2,
        jitter: 0.012,
        audioLevel: 0.25,
      },
    ],
    [
      "outbound-video",
      {
        id: "outbound-video",
        type: "outbound-rtp",
        kind: "video",
        bytesSent: 2_000 + byteOffset,
        packetsSent: 200 + byteOffset / 10,
        framesEncoded: 30 + byteOffset / 10,
      },
    ],
  ]);
}

describe("sanitized media diagnostics", () => {
  it("summarizes SDP and candidates without logging sensitive contents", async () => {
    const candidate = JSON.stringify({
      candidate:
        "candidate:1 1 udp 2122260223 192.0.2.77 45678 typ relay raddr 10.0.0.4 rport 5000",
      sdpMid: "audio",
      sdpMLineIndex: 0,
      usernameFragment: "ICE_SECRET",
    });
    await ctrl.handleSignal(PEER, { kind: "ice", candidate });
    await ctrl.handleSignal(PEER, { kind: "ice", candidate: "" });

    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 192.0.2.99",
      "a=fingerprint:sha-256 FP_REMOTE_SECRET",
      "a=ice-pwd:TURN_SECRET",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:audio",
      "a=sendrecv",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:video",
      "a=recvonly",
      "",
    ].join("\r\n");
    await ctrl.handleSignal(PEER, { kind: "offer", sdp });
    await flush();

    const output = diagnosticLogs.map((entry) => entry.message).join("\n");
    expect(output).toContain(
      "remote offer bytes=",
    );
    expect(output).toContain("audio(mid=audio,direction=sendrecv)");
    expect(output).toContain("video(mid=video,direction=recvonly)");
    expect(output).toContain(
      "remote ICE type=relay protocol=udp relayProtocol=unknown mid=audio buffering",
    );
    expect(output).toContain("remote ICE draining count=1");
    expect(output).toContain("remote ICE end-of-candidates draining");
    expect(output).not.toContain("FP_REMOTE_SECRET");
    expect(output).not.toContain("TURN_SECRET");
    expect(output).not.toContain("ICE_SECRET");
    expect(output).not.toContain("192.0.2.77");
    expect(output).not.toContain("45678");
  });

  it("does not interpolate a malformed sdpMLineIndex into diagnostics", async () => {
    // A remote peer controls the raw payload, so sdpMLineIndex may be anything.
    const candidate = JSON.stringify({
      candidate: "candidate:1 1 udp 2122260223 192.0.2.77 45678 typ relay",
      sdpMLineIndex: "0\nINJECTED_LINE",
    });
    await ctrl.handleSignal(PEER, { kind: "ice", candidate });

    const output = diagnosticLogs.map((entry) => entry.message).join("\n");
    expect(output).toContain("mline=unknown");
    expect(output).not.toContain("INJECTED_LINE");
  });

  it("logs permissions, state transitions, tracks, camera replacement, and teardown", async () => {
    await ctrl.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    const inbound = new MockMediaStreamTrack("video", "PRIVATE_TRACK_ID");
    pc._setSignaling("have-local-offer");
    pc._setGathering("gathering");
    pc._emitIce({
      candidate: "candidate:2 1 udp 1 198.51.100.44 55000 typ relay",
      protocol: "udp",
      relayProtocol: "tcp",
      sdpMid: "video",
      sdpMLineIndex: 1,
      type: "relay",
      toJSON: () => ({
        candidate: "candidate:2 1 udp 1 198.51.100.44 55000 typ relay",
        sdpMid: "video",
        sdpMLineIndex: 1,
      }),
    });
    pc._emitTrack(inbound);
    inbound._emit("mute");
    inbound._emit("unmute");
    inbound._emit("ended");
    pc._setIce("checking");
    pc._setDtls("connecting");
    pc._setConn("connecting");
    await ctrl.setCamMuted(true);
    await ctrl.setCamMuted(false);
    ctrl.closePeer(PEER);

    const output = diagnosticLogs.map((entry) => entry.message).join("\n");
    expect(output).toContain("local permissions camera=granted microphone=granted");
    expect(output).toContain(
      "peer connection created icePolicy=all stun=true turn=true",
    );
    expect(output).toContain("signaling -> have-local-offer");
    expect(output).toContain("ice gathering -> gathering");
    expect(output).toContain(
      "local ICE type=relay protocol=udp relayProtocol=tcp mid=video sending",
    );
    expect(output).toContain("inbound track attached kind=video");
    expect(output).toContain("inbound track muted kind=video");
    expect(output).toContain("inbound track unmuted kind=video");
    expect(output).toContain("inbound track ended kind=video");
    expect(output).toContain("dtls -> connecting");
    expect(output).toContain("outbound video track replaced with none");
    expect(output).toContain("outbound video track replaced with live track");
    expect(output).toContain("teardown");
    expect(output).not.toContain("PRIVATE_TRACK_ID");
    expect(output).not.toContain("198.51.100.44");
    expect(output).not.toContain("55000");
    expect(diagnosticLogs.some((entry) => entry.level === "debug")).toBe(true);
  });
});

describe("RTP diagnostics", () => {
  it("samples immediately and reports interval counter deltas", async () => {
    await ctrl.initiateCall(PEER);
    const pc = createdPeers[0]!;
    pc.getStats
      .mockResolvedValueOnce(diagnosticStatsSample(0))
      .mockResolvedValueOnce(diagnosticStatsSample(500));
    await connect(pc);

    expect(pc.getStats).toHaveBeenCalledTimes(1);
    let output = diagnosticLogs.map((entry) => entry.message).join("\n");
    expect(output).toContain(
      "stats path local=relay/udp remote=host/tcp relayProtocol=tcp rtt=25ms",
    );
    expect(output).toContain("inbound.audio bytes=1000(+initial)");
    expect(output).toContain("packets=100(+initial)");
    expect(output).toContain("lost=2 jitter=12ms");
    expect(output).toContain("audioLevel=0.250");

    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS);
    await flush();
    expect(pc.getStats).toHaveBeenCalledTimes(2);
    output = diagnosticLogs.map((entry) => entry.message).join("\n");
    expect(output).toContain("inbound.audio bytes=1500(+500)");
    expect(output).toContain("packets=150(+50)");
    expect(output).toContain("outbound.video bytes=2500(+500)");
  });

  it("does not overlap getStats polling", async () => {
    await ctrl.initiateCall(PEER);
    const pc = createdPeers[0]!;
    let resolveStats: (
      stats: Map<string, Record<string, unknown>>,
    ) => void = () => {};
    pc.getStats.mockImplementationOnce(
      async () =>
        new Promise<Map<string, Record<string, unknown>>>((resolve) => {
          resolveStats = resolve;
        }),
    );
    await connect(pc);

    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS * 2);
    expect(pc.getStats).toHaveBeenCalledTimes(1);
    expect(
      diagnosticLogs.some((entry) =>
        entry.message.includes("stats sample skipped; previous sample in flight"),
      ),
    ).toBe(true);

    resolveStats(diagnosticStatsSample(0));
    await flush();
    pc.getStats.mockResolvedValueOnce(diagnosticStatsSample(100));
    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS);
    await flush();
    expect(pc.getStats).toHaveBeenCalledTimes(2);
  });

  it("stops sampling on disconnect, replacement, and close", async () => {
    await ctrl.initiateCall(PEER);
    const first = createdPeers[0]!;
    first.getStats.mockResolvedValue(diagnosticStatsSample(0));
    await connect(first);
    expect(first.getStats).toHaveBeenCalledTimes(1);

    first._setConn("disconnected");
    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS * 2);
    expect(first.getStats).toHaveBeenCalledTimes(1);

    first._setConn("connected");
    await flush();
    expect(first.getStats).toHaveBeenCalledTimes(2);
    await ctrl.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_REPLACEMENT"),
    });
    await flush();
    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS * 2);
    expect(first.getStats).toHaveBeenCalledTimes(2);

    ctrl.closePeer(PEER);
    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS * 2);
    expect(first.getStats).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale pending getStats block a restarted sampler", async () => {
    await ctrl.initiateCall(PEER);
    const pc = createdPeers[0]!;
    let resolveStats: (
      stats: Map<string, Record<string, unknown>>,
    ) => void = () => {};
    pc.getStats.mockImplementationOnce(
      async () =>
        new Promise<Map<string, Record<string, unknown>>>((resolve) => {
          resolveStats = resolve;
        }),
    );
    await connect(pc);
    expect(pc.getStats).toHaveBeenCalledTimes(1);

    // The sampler stops while the first getStats is still pending, then restarts.
    pc._setConn("disconnected");
    await flush();
    pc.getStats.mockResolvedValue(diagnosticStatsSample(0));
    pc._setConn("connected");
    await flush();
    expect(pc.getStats).toHaveBeenCalledTimes(2);

    // The stale request settling must not disturb the restarted sampler either.
    resolveStats(diagnosticStatsSample(0));
    await flush();
    await vi.advanceTimersByTimeAsync(RTP_STATS_INTERVAL_MS);
    await flush();
    expect(pc.getStats).toHaveBeenCalledTimes(3);
  });
});
