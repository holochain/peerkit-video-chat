import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared capture point for the mocked builder. vi.hoisted runs before the
// vi.mock factory and the module import, so the factory can write into it and
// the tests can read what startChatNode wired up.
const h = vi.hoisted(() => ({
  builderOpts: undefined as { messageHandler: (from: string, data: Uint8Array) => Promise<void> } | undefined,
  observers: {} as Record<string, (...args: unknown[]) => void>,
  withIdCalled: undefined as string | undefined,
  addresses: undefined as string[] | undefined,
  bootstrap: undefined as unknown,
  node: undefined as unknown,
}));

vi.mock("@peerkit/peerkit", () => {
  class PeerkitNodeBuilder {
    constructor(opts: unknown) {
      h.builderOpts = opts as typeof h.builderOpts;
    }
    withBootstrapRelays(relays: unknown) {
      h.bootstrap = relays;
      return this;
    }
    withId(id: string) {
      h.withIdCalled = id;
      return this;
    }
    withAddresses(addresses: string[]) {
      h.addresses = addresses;
      return this;
    }
    withAgentsReceivedObserver(fn: (...a: unknown[]) => void) {
      h.observers.agentsReceived = fn;
      return this;
    }
    withPeerConnectedObserver(fn: (...a: unknown[]) => void) {
      h.observers.peerConnected = fn;
      return this;
    }
    withPeerDisconnectedObserver(fn: (...a: unknown[]) => void) {
      h.observers.peerDisconnected = fn;
      return this;
    }
    withRelayConnectedObserver(fn: (...a: unknown[]) => void) {
      h.observers.relayConnected = fn;
      return this;
    }
    async build() {
      return h.node;
    }
  }
  return { PeerkitNodeBuilder };
});

import { startChatNode, type ChatNodeOptions } from "../src/node.js";
import { decode, encode, MsgType } from "../src/envelope.js";

interface FakeNode {
  keyPair: { agentId: () => string };
  agentStore: { get: (id: string) => unknown; getAll: () => Array<{ agentId: string }> };
  getConnectedAgents: () => string[];
  isConnected: (id: string) => boolean;
  isDirectConnection: (id: string) => boolean;
  transport: { connect: (addresses: string[]) => Promise<void> };
  send: (id: string, bytes: Uint8Array) => Promise<void>;
  shutDown: () => Promise<void>;
}

function makeNode(overrides: Partial<FakeNode> = {}): FakeNode {
  return {
    keyPair: { agentId: () => "self" },
    agentStore: { get: () => undefined, getAll: () => [] },
    getConnectedAgents: () => [],
    isConnected: () => false,
    isDirectConnection: () => false,
    transport: { connect: async () => {} },
    send: async () => {},
    shutDown: async () => {},
    ...overrides,
  };
}

const noopEvents = () => ({
  onState: () => {},
  onChat: () => {},
  onSignal: () => {},
  onMediaState: () => {},
});

function baseOptions(over: Partial<ChatNodeOptions> = {}): ChatNodeOptions {
  return {
    bootstrapRelays: ["/dns4/relay/tcp/9000/ws"],
    displayName: "Me",
    events: noopEvents(),
    ...over,
  };
}

beforeEach(() => {
  h.builderOpts = undefined;
  h.observers = {};
  h.withIdCalled = undefined;
  h.addresses = undefined;
  h.bootstrap = undefined;
  h.node = makeNode();
});

describe("startChatNode wiring", () => {
  it("forwards bootstrap relays and omits withId when no id is given", async () => {
    const chat = await startChatNode(baseOptions());
    expect(h.bootstrap).toEqual(["/dns4/relay/tcp/9000/ws"]);
    expect(h.withIdCalled).toBeUndefined();
    await chat.shutDown();
  });

  it("passes a configured id to the builder", async () => {
    const chat = await startChatNode(baseOptions({ id: "node-x" }));
    expect(h.withIdCalled).toBe("node-x");
    await chat.shutDown();
  });

  it("leaves builder addresses unset by default", async () => {
    const chat = await startChatNode(baseOptions());
    expect(h.addresses).toBeUndefined();
    await chat.shutDown();
  });

  it("forwards explicit listen addresses", async () => {
    const addresses = ["/ip4/127.0.0.1/tcp/4001", "/ip6/::1/tcp/4002"];
    const chat = await startChatNode(baseOptions({ listenAddresses: addresses }));
    expect(h.addresses).toEqual(addresses);
    await chat.shutDown();
  });

  it("uses only the circuit listen address in relay-only mode", async () => {
    const chat = await startChatNode(baseOptions({ relayOnly: true }));
    expect(h.addresses).toEqual(["/p2p-circuit"]);
    await chat.shutDown();
  });

  it("rejects relay-only combined with explicit listen addresses", async () => {
    await expect(
      startChatNode(
        baseOptions({
          relayOnly: true,
          listenAddresses: ["/ip4/127.0.0.1/tcp/4001"],
        }),
      ),
    ).rejects.toThrow(
      "relayOnly cannot be combined with explicit listenAddresses",
    );
  });
});

describe("relay-only dialing", () => {
  it("dials circuit addresses reached through WebRTC Direct", async () => {
    const connectedWith: string[][] = [];
    let connected = false;
    h.node = makeNode({
      isConnected: () => connected,
      agentStore: {
        get: () => ({
          agentId: "peer",
          addresses: [
            "/ip4/203.0.113.10/tcp/4001",
            "/ip4/203.0.113.11/tcp/4002/p2p-circuit",
            "/ip4/203.0.113.12/udp/4003/webrtc/p2p-circuit",
            "/ip4/203.0.113.13/udp/4004/webrtc-direct/p2p-circuit",
            "not-a-multiaddr",
          ],
        }),
        getAll: () => [],
      },
      transport: {
        connect: async (addresses: string[]) => {
          connectedWith.push(addresses);
          connected = true;
        },
      },
    });
    const chat = await startChatNode(baseOptions({ relayOnly: true }));
    h.observers.agentsReceived!(["peer"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectedWith).toEqual([
      [
        "/ip4/203.0.113.11/tcp/4002/p2p-circuit",
        "/ip4/203.0.113.13/udp/4004/webrtc-direct/p2p-circuit",
      ],
    ]);
    await chat.shutDown();
  });

  it("skips a peer with no usable circuit address", async () => {
    const connect = vi.fn(async () => {});
    h.node = makeNode({
      agentStore: {
        get: () => ({
          agentId: "peer",
          addresses: [
            "/ip4/203.0.113.10/tcp/4001",
            "not-a-multiaddr",
          ],
        }),
        getAll: () => [],
      },
      transport: { connect },
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const chat = await startChatNode(baseOptions({ relayOnly: true }));
    h.observers.agentsReceived!(["peer"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("has no relayed address — skipping dial"),
    );
    info.mockRestore();
    await chat.shutDown();
  });
});

describe("computePeerStats", () => {
  it("splits connected peers into direct and relayed and counts discovered", async () => {
    h.node = makeNode({
      getConnectedAgents: () => ["self", "a", "b", "c"],
      isDirectConnection: (id) => id === "a",
      agentStore: {
        get: () => undefined,
        getAll: () => [{ agentId: "self" }, { agentId: "a" }, { agentId: "b" }, { agentId: "d" }],
      },
    });
    const chat = await startChatNode(baseOptions());
    expect(chat.getPeerStats()).toEqual({
      discovered: 3,
      connected: 3,
      direct: 1,
      relayed: 2,
      peers: [
        { agentId: "a", displayName: undefined, connected: true, direct: true },
        { agentId: "b", displayName: undefined, connected: true, direct: false },
        { agentId: "c", displayName: undefined, connected: true, direct: false },
        { agentId: "d", displayName: undefined, connected: false, direct: false },
      ],
    });
    await chat.shutDown();
  });

  it("identifies a peer by display name once seen in a room", async () => {
    h.node = makeNode({
      getConnectedAgents: () => ["self", "a"],
      isDirectConnection: () => true,
      agentStore: { get: () => undefined, getAll: () => [{ agentId: "a" }] },
    });
    const chat = await startChatNode(baseOptions());
    // Learn "a"'s display name via an observed RoomJoin.
    await h.builderOpts!.messageHandler(
      "a",
      encode({ v: 1, type: MsgType.RoomJoin, from: "a", room: "lobby", ts: 1, displayName: "Ada" }),
    );
    expect(chat.getPeerStats().peers).toContainEqual({
      agentId: "a",
      displayName: "Ada",
      connected: true,
      direct: true,
    });
    await chat.shutDown();
  });
});

describe("NO_RESERVATION dial suppression", () => {
  it("stops dialing a peer after a NO_RESERVATION failure", async () => {
    let connects = 0;
    h.node = makeNode({
      isConnected: () => false,
      agentStore: {
        get: () => ({ agentId: "ghost", addresses: ["/relay/p2p-circuit/webrtc"] }),
        getAll: () => [],
      },
      transport: {
        connect: async () => {
          connects++;
          throw new Error(
            "failed to connect via relay with status NO_RESERVATION",
          );
        },
      },
    });
    const chat = await startChatNode(baseOptions());
    h.observers.agentsReceived!(["ghost"]);
    await new Promise((r) => setTimeout(r, 0)); // flush the dial microtasks
    h.observers.agentsReceived!(["ghost"]); // second gossip must not redial
    await new Promise((r) => setTimeout(r, 0));
    expect(connects).toBe(1);
    await chat.shutDown();
  });

  it("re-probes a NO_RESERVATION peer after the cooldown elapses", async () => {
    vi.useFakeTimers();
    try {
      let connects = 0;
      h.node = makeNode({
        isConnected: () => false,
        agentStore: {
          get: () => ({ agentId: "ghost", addresses: ["/relay/p2p-circuit/webrtc"] }),
          getAll: () => [],
        },
        transport: {
          connect: async () => {
            connects++;
            throw new Error(
              "failed to connect via relay with status NO_RESERVATION",
            );
          },
        },
      });
      const chat = await startChatNode(baseOptions());
      h.observers.agentsReceived!(["ghost"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(connects).toBe(1); // first dial, now paused
      // Still within the cooldown: no redial.
      await vi.advanceTimersByTimeAsync(30_000);
      h.observers.agentsReceived!(["ghost"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(connects).toBe(1);
      // Past the 60s cooldown: one re-probe is allowed.
      await vi.advanceTimersByTimeAsync(31_000);
      h.observers.agentsReceived!(["ghost"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(connects).toBe(2);
      await chat.shutDown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not suppress on an unrelated dial failure", async () => {
    let connects = 0;
    h.node = makeNode({
      isConnected: () => false,
      agentStore: {
        get: () => ({ agentId: "peer", addresses: ["/addr"] }),
        getAll: () => [],
      },
      transport: {
        connect: async () => {
          connects++;
          throw new Error("connection refused");
        },
      },
    });
    const chat = await startChatNode(baseOptions());
    h.observers.agentsReceived!(["peer"]);
    await new Promise((r) => setTimeout(r, 0));
    h.observers.agentsReceived!(["peer"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(connects).toBeGreaterThan(1);
    await chat.shutDown();
  });
});

describe("peer-connect announce", () => {
  it("sends a targeted RoomJoin to a peer that connects while we are in a room", async () => {
    const sent: Array<{ to: string; bytes: Uint8Array }> = [];
    h.node = makeNode({
      isConnected: () => true,
      send: async (to, bytes) => {
        sent.push({ to, bytes });
      },
    });
    const chat = await startChatNode(baseOptions());
    await chat.room.join("lobby");
    sent.length = 0; // ignore the join broadcast
    h.observers.peerConnected!("late-peer");
    const targeted = sent.find((s) => s.to === "late-peer");
    expect(targeted).toBeDefined();
    const env = decode(targeted!.bytes);
    expect(env?.type).toBe(MsgType.RoomJoin);
    expect(env?.room).toBe("lobby");
    await chat.shutDown();
  });
});

describe("relay-connected status", () => {
  it("invokes onRelayConnected with the relay address when the observer fires", async () => {
    const seen: string[] = [];
    const chat = await startChatNode(baseOptions({ onRelayConnected: (addr) => seen.push(addr) }));
    expect(h.observers.relayConnected).toBeTypeOf("function");
    h.observers.relayConnected("/dns4/relay/tcp/9000/ws");
    expect(seen).toEqual(["/dns4/relay/tcp/9000/ws"]);
    await chat.shutDown();
  });
});

describe("network room tracking", () => {
  it("surfaces a room from an incoming RoomJoin message", async () => {
    const rooms: Array<Array<{ name: string; members: Array<{ agentId: string }> }>> = [];
    const chat = await startChatNode(baseOptions({ onNetworkRooms: (r) => rooms.push(r) }));
    const env = encode({
      v: 1,
      type: MsgType.RoomJoin,
      from: "peer1",
      room: "lobby",
      ts: 1,
      displayName: "Peer One",
    });
    await h.builderOpts!.messageHandler("peer1", env);
    expect(rooms.at(-1)).toContainEqual({
      name: "lobby",
      members: [{ agentId: "peer1", displayName: "Peer One" }],
    });
    await chat.shutDown();
  });

  it("ignores a malformed inbound message without throwing", async () => {
    const chat = await startChatNode(baseOptions());
    await expect(
      h.builderOpts!.messageHandler("peer1", new Uint8Array([0xff, 0xff])),
    ).resolves.toBeUndefined();
    await chat.shutDown();
  });
});

describe("peer-stats polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits on a 3s interval and stops after shutdown", async () => {
    const stats: unknown[] = [];
    const chat = await startChatNode(baseOptions({ onPeerStats: (s) => stats.push(s) }));
    const initial = stats.length; // one emit at startup
    vi.advanceTimersByTime(9000);
    expect(stats.length).toBe(initial + 3);
    await chat.shutDown();
    const afterShutdown = stats.length;
    vi.advanceTimersByTime(9000);
    expect(stats.length).toBe(afterShutdown);
  });
});
