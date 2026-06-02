/**
 * Recovery-ladder tests for the renderer WebRTC layer (webrtc.ts).
 *
 * Drives the module black-box: initiateCall / handleSignal / closePeer against a
 * MockPeerConnection, firing lifecycle transitions by hand and asserting on the
 * signals emitted via window.app.sendSignal. Fake timers exercise the DTLS
 * watchdog, the per-attempt recovery timeout, and the acceptor give-up timer.
 *
 * Globals and the module are (re)installed per test so module-level recovery
 * state never leaks between cases. TURN is configured via the __TURN_*__ build
 * constants (see vitest.config.ts `define`) so the relay-only rung is active.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCEPTOR_GIVEUP_MS,
  DTLS_STALL_MS,
  RECOVERY_ATTEMPT_MS,
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
// Re-imported per test so module state (peers, recovery maps) starts clean.
let webrtc: typeof import("../src/renderer/src/webrtc");

/** Bring a freshly-initiated offerer connection up to fully connected. */
async function connect(pc: MockPeerConnection): Promise<void> {
  // Answer the initial offer, then walk the transports to connected.
  await webrtc.handleSignal(PEER, {
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
  vi.resetModules();
  webrtc = await import("../src/renderer/src/webrtc");
});

afterEach(() => {
  webrtc.closeAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("offer/answer setup", () => {
  it("initiateCall sends an offer and marks us the offerer", async () => {
    await webrtc.initiateCall(PEER);
    await flush();

    expect(createdPeers).toHaveLength(1);
    const offers = offersTo().filter((s) => s.kind === "offer");
    expect(offers).toHaveLength(1);
  });
});

describe("ICE-restart rung", () => {
  it("restarts ICE on the same pc when the connection fails", async () => {
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await webrtc.handleSignal(PEER, {
      kind: "answer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });

    pc._setIce("connected"); // arms the watchdog
    pc._setDtls("failed"); // fail-fast trigger
    await flush();

    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
  });

  it("recovers when DTLS hangs past the backstop timer", async () => {
    await webrtc.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await webrtc.handleSignal(PEER, {
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
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
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
    await webrtc.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    // Accept the peer's answer carrying their fingerprint.
    await webrtc.handleSignal(PEER, {
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
    await webrtc.handleSignal(PEER, {
      kind: "offer",
      sdp: sdpWithFingerprint("FP_REMOTE_0"),
    });
    await flush();

    // No new pc — applied to the existing one, which produced an answer.
    expect(createdPeers).toHaveLength(1);
    expect(pc.createAnswer).toHaveBeenCalled();
  });

  it("rebuilds on a new-fingerprint offer (remote reload)", async () => {
    await webrtc.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await webrtc.handleSignal(PEER, {
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
    await webrtc.handleSignal(PEER, {
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
    await webrtc.handleSignal(PEER, {
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
    await webrtc.initiateCall(PEER);
    await flush();
    const pc = createdPeers[0]!;
    await connect(pc);

    pc._setConn("failed"); // arms the per-attempt timeout
    await flush();
    webrtc.closePeer(PEER);
    const peersAfterClose = createdPeers.length;

    await vi.advanceTimersByTimeAsync(RECOVERY_ATTEMPT_MS + DTLS_STALL_MS + 10);
    await flush();

    // No further pcs built, no further offers emitted post-close.
    expect(createdPeers.length).toBe(peersAfterClose);
  });
});
