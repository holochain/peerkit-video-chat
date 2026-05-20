import type { AgentId, RelayAddress } from "@peerkit/api";
import { PeerkitNodeBuilder, type PeerkitNode } from "@peerkit/peerkit";

import { decode, encode, type Envelope } from "./envelope.js";
import { Room, type RoomEvents, type RoomTransport } from "./room.js";

export interface ChatNodeOptions {
  id?: string;
  bootstrapRelays: RelayAddress[];
  displayName: string;
  events: RoomEvents;
}

export interface ChatNode {
  readonly agentId: AgentId;
  readonly room: Room;
  setDisplayName(name: string): void;
  shutDown(): Promise<void>;
}

export async function startChatNode(
  options: ChatNodeOptions,
): Promise<ChatNode> {
  const roomRef: { current: Room | undefined } = { current: undefined };

  const tryDial = async (node: PeerkitNode, agentId: AgentId): Promise<void> => {
    if (agentId === node.keyPair.agentId()) return;
    if (node.isConnected(agentId)) return;
    const info = node.agentStore.get(agentId);
    if (info === undefined) return;
    for (const addr of info.addresses) {
      try {
        await node.transport.connect(addr);
        if (node.isConnected(agentId)) return;
      } catch (err) {
        console.warn(
          `chat-node: dial ${agentId.slice(0, 12)} via ${addr} failed: ${(err as Error).message}`,
        );
      }
    }
  };

  let nodeRef: PeerkitNode | undefined;

  const builder = new PeerkitNodeBuilder({
    networkAccessHandler: async () => true,
    messageHandler: async (fromAgent, data) => {
      const env = decode(data);
      if (env === null) {
        console.warn(
          `chat-node: drop malformed message from ${fromAgent.slice(0, 12)}`,
        );
        return;
      }
      roomRef.current?.onIncoming(env, fromAgent);
    },
  })
    .withBootstrapRelays(options.bootstrapRelays)
    .withAgentsReceivedObserver((agentIds) => {
      const node = nodeRef;
      if (node === undefined) return;
      for (const id of agentIds) void tryDial(node, id);
    })
    .withPeerConnectedObserver(() => {
      // New peer connection: re-announce so they learn we're in the room.
      // Roster reconciliation happens via their roster reply (if they're also in the room).
      roomRef.current?.reannounce();
    })
    .withPeerDisconnectedObserver((agentId) => {
      roomRef.current?.onPeerDisconnected(agentId);
    });

  if (options.id !== undefined) {
    builder.withId(options.id);
  }

  const node = await builder.build();
  nodeRef = node;

  const transport: RoomTransport = {
    agentId: node.keyPair.agentId(),
    async broadcast(envelope: Envelope) {
      const bytes = encode(envelope);
      const self = node.keyPair.agentId();
      const targets = node.getConnectedAgents().filter((a) => a !== self);
      await Promise.all(
        targets.map((a) =>
          node.send(a, bytes).catch((err) => {
            console.warn(
              `chat-node: broadcast to ${a.slice(0, 12)} failed: ${(err as Error).message}`,
            );
          }),
        ),
      );
    },
    async sendTo(agentId: AgentId, envelope: Envelope) {
      if (!node.isConnected(agentId)) {
        console.warn(
          `chat-node: sendTo ${agentId.slice(0, 12)} dropped (not connected)`,
        );
        return;
      }
      try {
        await node.send(agentId, encode(envelope));
      } catch (err) {
        console.warn(
          `chat-node: sendTo ${agentId.slice(0, 12)} failed: ${(err as Error).message}`,
        );
      }
    },
  };

  const room = new Room(transport, options.events, options.displayName);
  roomRef.current = room;

  return {
    agentId: node.keyPair.agentId(),
    room,
    setDisplayName(name: string) {
      room.setDisplayName(name);
    },
    async shutDown() {
      try {
        await room.leave();
      } catch {
        // best effort
      }
      await node.shutDown();
    },
  };
}
