import type { AgentId, RelayAddress } from "@peerkit/api";
import type { WebRtcSignal } from "./envelope.js";
import { PeerkitNodeBuilder, type PeerkitNode } from "@peerkit/peerkit";

import { decode, encode, MsgType, type Envelope } from "./envelope.js";
import { Room, type RoomEvents, type RoomStateView, type RoomTransport } from "./room.js";
import type { RosterEntry } from "./envelope.js";

export interface NetworkRoomEntry {
  name: string;
  members: RosterEntry[];
}

export interface ChatNodeOptions {
  id?: string;
  bootstrapRelays: RelayAddress[];
  displayName: string;
  events: RoomEvents;
  /** Called whenever the observed set of active network rooms changes. */
  onNetworkRooms?: (rooms: NetworkRoomEntry[]) => void;
}

export interface ChatNode {
  readonly agentId: AgentId;
  readonly room: Room;
  setDisplayName(name: string): void;
  sendSignal(toAgent: AgentId, signal: WebRtcSignal): Promise<void>;
  shutDown(): Promise<void>;
}

export async function startChatNode(
  options: ChatNodeOptions,
): Promise<ChatNode> {
  const roomRef: { current: Room | undefined } = { current: undefined };

  // ── Network room tracker ──────────────────────────────────────────────────
  // Tracks membership of every room we observe on the network, including our
  // own.  Keyed by normalised room name; values are agentId → displayName.
  const networkRooms = new Map<string, Map<AgentId, string>>();
  let currentDisplayName = options.displayName;
  // Resolved after the peerkit node is built; safe in async callbacks.
  let selfAgentId: AgentId = "";
  let selfRoom: string | undefined;

  function emitNetworkRooms(): void {
    if (!options.onNetworkRooms) return;
    const rooms: NetworkRoomEntry[] = [];
    for (const [name, members] of networkRooms) {
      rooms.push({
        name,
        members: Array.from(members.entries()).map(([agentId, displayName]) => ({
          agentId,
          displayName,
        })),
      });
    }
    options.onNetworkRooms(rooms);
  }

  function networkTrackIncoming(env: Envelope): void {
    switch (env.type) {
      case MsgType.RoomJoin: {
        const map = networkRooms.get(env.room) ?? new Map<AgentId, string>();
        map.set(env.from, env.displayName);
        networkRooms.set(env.room, map);
        emitNetworkRooms();
        break;
      }
      case MsgType.RoomLeave: {
        const map = networkRooms.get(env.room);
        if (map?.has(env.from)) {
          map.delete(env.from);
          if (map.size === 0) networkRooms.delete(env.room);
          emitNetworkRooms();
        }
        break;
      }
      case MsgType.RoomRoster: {
        // Received when we join a room — gives us the full current member list.
        const map = networkRooms.get(env.room) ?? new Map<AgentId, string>();
        for (const m of env.members) map.set(m.agentId, m.displayName);
        networkRooms.set(env.room, map);
        emitNetworkRooms();
        break;
      }
      default:
        break;
    }
  }

  function networkTrackOwnState(view: RoomStateView): void {
    if (selfAgentId === "") return; // node not yet built
    if (view.kind === "inRoom") {
      if (selfRoom && selfRoom !== view.room) {
        // Shouldn't happen (leave-then-join), but clean up the old room.
        networkRooms.get(selfRoom)?.delete(selfAgentId);
        if (networkRooms.get(selfRoom)?.size === 0) networkRooms.delete(selfRoom);
      }
      const map = networkRooms.get(view.room) ?? new Map<AgentId, string>();
      map.set(selfAgentId, currentDisplayName);
      networkRooms.set(view.room, map);
      selfRoom = view.room;
    } else {
      if (selfRoom) {
        const map = networkRooms.get(selfRoom);
        if (map) {
          map.delete(selfAgentId);
          if (map.size === 0) networkRooms.delete(selfRoom);
        }
        selfRoom = undefined;
      }
    }
    emitNetworkRooms();
  }

  // Wrap onState so we can track our own room membership.
  const wrappedEvents: RoomEvents = {
    onState(view) {
      networkTrackOwnState(view);
      options.events.onState(view);
    },
    onChat: options.events.onChat,
    onSignal: options.events.onSignal,
  };

  // ─────────────────────────────────────────────────────────────────────────

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
      // Update network room tracker before the per-room filter in Room.
      if (env.from === fromAgent) networkTrackIncoming(env);
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
      // Remove disconnected peer from all tracked rooms.
      let changed = false;
      for (const [roomName, members] of networkRooms) {
        if (members.has(agentId)) {
          members.delete(agentId);
          if (members.size === 0) networkRooms.delete(roomName);
          changed = true;
        }
      }
      if (changed) emitNetworkRooms();
      roomRef.current?.onPeerDisconnected(agentId);
    });

  if (options.id !== undefined) {
    builder.withId(options.id);
  }

  const node = await builder.build();
  nodeRef = node;
  selfAgentId = node.keyPair.agentId();

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

  const room = new Room(transport, wrappedEvents, options.displayName);
  roomRef.current = room;

  return {
    agentId: node.keyPair.agentId(),
    room,
    setDisplayName(name: string) {
      currentDisplayName = name;
      room.setDisplayName(name);
    },
    async sendSignal(toAgent: AgentId, signal: WebRtcSignal) {
      await room.sendSignal(toAgent, signal);
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
