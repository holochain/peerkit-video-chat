import { afterEach, describe, expect, test } from "vitest";

import {
  lastState,
  startTestPeer,
  startTestRelay,
  waitFor,
  type TestPeer,
  type TestRelay,
} from "./helpers.js";

const TEST_TIMEOUT_MS = 30_000;

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  // Tear down in reverse order: peers before relay.
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      await fn?.();
    } catch (err) {
      // Best-effort cleanup; don't fail other tests.
      console.warn("cleanup error:", (err as Error).message);
    }
  }
});

async function setupRelay(): Promise<TestRelay> {
  const relay = await startTestRelay();
  cleanup.push(() => relay.shutDown());
  return relay;
}

async function setupPeer(
  relayAddress: string,
  displayName: string,
): Promise<TestPeer> {
  const peer = await startTestPeer(relayAddress, displayName);
  cleanup.push(() => peer.shutDown());
  return peer;
}

describe("rooms + chat over real PeerKit", () => {
  test(
    "two peers in the same normalized room see each other in the roster",
    async () => {
      const relay = await setupRelay();
      const alice = await setupPeer(relay.address, "Alice");
      const bob = await setupPeer(relay.address, "Bob");

      // Different casing / whitespace must normalize to the same room.
      await alice.node.room.join("Standup");
      await bob.node.room.join("  STANDUP  ");

      await waitFor(
        () => {
          const a = lastState(alice);
          const b = lastState(bob);
          return (
            a.kind === "inRoom" &&
            a.members.length === 2 &&
            b.kind === "inRoom" &&
            b.members.length === 2
          );
        },
        { timeoutMs: 10_000, label: "rosters converge to size 2" },
      );

      const aState = lastState(alice);
      const bState = lastState(bob);
      expect(aState.kind).toBe("inRoom");
      expect(bState.kind).toBe("inRoom");
      if (aState.kind !== "inRoom" || bState.kind !== "inRoom") return;

      expect(aState.room).toBe("standup");
      expect(bState.room).toBe("standup");

      const aMembers = aState.members
        .map((m) => m.displayName)
        .sort();
      expect(aMembers).toEqual(["Alice", "Bob"]);

      const bMembers = bState.members
        .map((m) => m.displayName)
        .sort();
      expect(bMembers).toEqual(["Alice", "Bob"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "chat from one peer is received by the other with correct displayName",
    async () => {
      const relay = await setupRelay();
      const alice = await setupPeer(relay.address, "Alice");
      const bob = await setupPeer(relay.address, "Bob");

      await alice.node.room.join("hello");
      await bob.node.room.join("hello");

      await waitFor(
        () => {
          const a = lastState(alice);
          const b = lastState(bob);
          return (
            a.kind === "inRoom" &&
            a.members.length === 2 &&
            b.kind === "inRoom" &&
            b.members.length === 2
          );
        },
        { timeoutMs: 10_000, label: "rosters converge before chat" },
      );

      await alice.node.room.sendChat("hi there");

      await waitFor(
        () => bob.chats.length >= 1,
        { timeoutMs: 5_000, label: "bob receives chat" },
      );

      const received = bob.chats[bob.chats.length - 1];
      expect(received).toBeDefined();
      if (received === undefined) return;
      expect(received.body).toBe("hi there");
      expect(received.displayName).toBe("Alice");
      expect(received.from).toBe(alice.node.agentId);
      expect(received.room).toBe("hello");

      // Alice should also see her own send echoed locally.
      const aliceLast = alice.chats[alice.chats.length - 1];
      expect(aliceLast?.body).toBe("hi there");
      expect(aliceLast?.from).toBe(alice.node.agentId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "explicit leave removes the leaver from the remaining peer's roster",
    async () => {
      const relay = await setupRelay();
      const alice = await setupPeer(relay.address, "Alice");
      const bob = await setupPeer(relay.address, "Bob");

      await alice.node.room.join("standup");
      await bob.node.room.join("standup");

      await waitFor(
        () => {
          const a = lastState(alice);
          return a.kind === "inRoom" && a.members.length === 2;
        },
        { timeoutMs: 10_000, label: "alice sees bob in roster" },
      );

      await bob.node.room.leave();

      await waitFor(
        () => {
          const a = lastState(alice);
          return a.kind === "inRoom" && a.members.length === 1;
        },
        { timeoutMs: 5_000, label: "alice's roster drops bob after leave" },
      );

      const a = lastState(alice);
      if (a.kind !== "inRoom") throw new Error("alice not in room");
      expect(a.members.map((m) => m.displayName)).toEqual(["Alice"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "disconnect without leave still drops the peer from the roster",
    async () => {
      const relay = await setupRelay();
      const alice = await setupPeer(relay.address, "Alice");
      const bob = await setupPeer(relay.address, "Bob");

      await alice.node.room.join("standup");
      await bob.node.room.join("standup");

      await waitFor(
        () => {
          const a = lastState(alice);
          return a.kind === "inRoom" && a.members.length === 2;
        },
        { timeoutMs: 10_000, label: "alice sees bob" },
      );

      // Hard shutdown — no chance for bob to broadcast a RoomLeave.
      await bob.node.shutDown();

      await waitFor(
        () => {
          const a = lastState(alice);
          return a.kind === "inRoom" && a.members.length === 1;
        },
        {
          timeoutMs: 10_000,
          label: "alice's roster drops bob via peerDisconnected",
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "three peers all see each other in the roster",
    async () => {
      const relay = await setupRelay();
      const alice = await setupPeer(relay.address, "Alice");
      const bob = await setupPeer(relay.address, "Bob");
      const carol = await setupPeer(relay.address, "Carol");

      await alice.node.room.join("group");
      await bob.node.room.join("group");
      await carol.node.room.join("group");

      await waitFor(
        () => {
          const a = lastState(alice);
          const b = lastState(bob);
          const c = lastState(carol);
          return (
            a.kind === "inRoom" &&
            a.members.length === 3 &&
            b.kind === "inRoom" &&
            b.members.length === 3 &&
            c.kind === "inRoom" &&
            c.members.length === 3
          );
        },
        { timeoutMs: 15_000, label: "three rosters converge" },
      );

      for (const peer of [alice, bob, carol]) {
        const s = lastState(peer);
        if (s.kind !== "inRoom") throw new Error("peer not in room");
        expect(s.members.map((m) => m.displayName).sort()).toEqual([
          "Alice",
          "Bob",
          "Carol",
        ]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
