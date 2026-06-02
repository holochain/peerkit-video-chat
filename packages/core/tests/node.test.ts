import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared capture point for the mocked builder. vi.hoisted runs before the
// vi.mock factory and the module import, so the factory can write into it and
// the tests can read what startChatNode wired up.
const h = vi.hoisted(() => ({
  builderOpts: undefined as { messageHandler: (from: string, data: Uint8Array) => Promise<void> } | undefined,
  observers: {} as Record<string, (...args: unknown[]) => void>,
  withIdCalled: undefined as string | undefined,
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
import { encode, MsgType } from "../src/envelope.js";

interface FakeNode {
  keyPair: { agentId: () => string };
  agentStore: { get: (id: string) => unknown; getAll: () => Array<{ agentId: string }> };
  getConnectedAgents: () => string[];
  isConnected: (id: string) => boolean;
  isDirectConnection: (id: string) => boolean;
  transport: { connect: (addr: string) => Promise<void> };
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

const noopEvents = () => ({ onState: () => {}, onChat: () => {}, onSignal: () => {} });

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
    expect(chat.getPeerStats()).toEqual({ discovered: 3, connected: 3, direct: 1, relayed: 2 });
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
