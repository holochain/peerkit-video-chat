import { PeerkitRelayBuilder, type PeerkitRelay } from "@peerkit/peerkit";
import { createRelay } from "@peerkit/transport-libp2p-nodejs";

import { startChatNode, type ChatNode } from "../../src/index.js";
import type {
  IncomingChat,
  RoomStateView,
} from "../../src/index.js";

export interface TestRelay {
  address: string;
  shutDown(): Promise<void>;
}

export async function startTestRelay(): Promise<TestRelay> {
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withAddresses(["/ip4/127.0.0.1/tcp/0"])
    .withTransportFactory(createRelay)
    .build();

  const nodeId = relay.transport.getNodeId();
  const listenAddr = pickListenAddress(relay);

  return {
    address: `${listenAddr}/p2p/${nodeId}`,
    async shutDown() {
      await relay.shutDown();
    },
  };
}

function pickListenAddress(relay: PeerkitRelay): string {
  // The public ITransport surface does not expose listen addresses, so reach
  // into the underlying libp2p instance from the transport-libp2p-nodejs
  // factory. Confined to test code.
  const transportAny = relay.transport as unknown as {
    libp2p: { getMultiaddrs(): { toString(): string }[] };
  };
  const addrs = transportAny.libp2p
    .getMultiaddrs()
    .map((a) => a.toString())
    .filter((s) => s.startsWith("/ip4/127.0.0.1/tcp/"));
  const first = addrs[0];
  if (first === undefined) {
    throw new Error(
      "Relay produced no /ip4/127.0.0.1/tcp/... listen address; got: " +
        JSON.stringify(
          transportAny.libp2p.getMultiaddrs().map((a) => a.toString()),
        ),
    );
  }
  // Strip a trailing /p2p/<peerId> if libp2p included one.
  return first.replace(/\/p2p\/[^/]+$/, "");
}

export interface TestPeer {
  node: ChatNode;
  states: RoomStateView[];
  chats: IncomingChat[];
  shutDown(): Promise<void>;
}

export async function startTestPeer(
  relayAddress: string,
  displayName: string,
): Promise<TestPeer> {
  const states: RoomStateView[] = [];
  const chats: IncomingChat[] = [];

  let relayConnectedResolve: () => void = () => {};
  const relayConnected = new Promise<void>((resolve) => {
    relayConnectedResolve = resolve;
  });

  const node = await startChatNode({
    bootstrapRelays: [relayAddress],
    displayName,
    events: {
      onState: (view) => states.push(view),
      onChat: (chat) => chats.push(chat),
    },
    onRelayConnected: () => relayConnectedResolve(),
  });

  // Wait until our own agent info has been registered with the relay.
  // Otherwise a sibling peer that connects right after us may not learn about
  // us when the relay broadcasts its current agent list.
  await Promise.race([
    relayConnected,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("relay-connected handshake timed out")),
        10_000,
      ),
    ),
  ]);

  return {
    node,
    states,
    chats,
    async shutDown() {
      await node.shutDown();
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${opts.label !== undefined ? `: ${opts.label}` : ""}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function lastState(peer: TestPeer): RoomStateView {
  const s = peer.states[peer.states.length - 1];
  if (s === undefined) {
    throw new Error("peer has not emitted any state yet");
  }
  return s;
}
