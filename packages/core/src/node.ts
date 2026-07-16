import type {
  AgentId,
  IAgentKeyStore,
  NodeAddress,
  RelayDialAddress,
} from "@peerkit/api";
import type { WebRtcSignal } from "./envelope.js";
import {
  CODE_P2P_CIRCUIT,
  CODE_WEBRTC,
  multiaddr,
} from "@multiformats/multiaddr";
import {
  PeerkitNodeBuilder,
  type PeerkitNode,
  type PeerkitNodeTransportFactory,
} from "@peerkit/peerkit";

import { decode, encode, MsgType, type Envelope } from "./envelope.js";
import { Room, type RoomEvents, type RoomStateView, type RoomTransport } from "./room.js";
import type { RosterEntry } from "./envelope.js";

// Strip control characters from peer-supplied strings (e.g. display names)
// before logging them, so a crafted value can't forge extra log lines.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const sanitizeForLog = (s: string): string => s.replace(CONTROL_CHARS, " ");

export interface NetworkRoomEntry {
  name: string;
  members: RosterEntry[];
}

/**
 * One peer as seen by this node, for identifying who is online/connected rather
 * than just counting. `displayName` is resolved from any room we have observed
 * the peer announce in (the agent store carries no name), so it is undefined for
 * a peer we have never seen join a room.
 */
export interface PeerInfo {
  agentId: AgentId;
  displayName?: string;
  /** True if there is an active transport link to this peer right now. */
  connected: boolean;
  /** True if the link is direct (not via a relay). Only meaningful when connected. */
  direct: boolean;
}

/**
 * Live peer connectivity, surfaced so the UI can show whether the node is
 * actually reaching anyone. `discovered` counts agents known via the agent
 * store (peers seen online); `connected` counts active transport links, split
 * into `direct` and `relayed` (via PeerKit's {@link PeerkitNode.isDirectConnection}).
 * `peers` lists the same set by identity (union of connected and discovered).
 */
export interface PeerStats {
  discovered: number;
  connected: number;
  direct: number;
  relayed: number;
  peers: PeerInfo[];
}

export interface ChatNodeOptions {
  id?: string;
  bootstrapRelays: RelayDialAddress[];
  displayName: string;
  agentKeyStore: IAgentKeyStore;
  events: RoomEvents;
  transportFactory?: PeerkitNodeTransportFactory;
  /** Explicit PeerKit listen and advertised addresses. */
  listenAddresses?: NodeAddress[];
  /** Restrict PeerKit listening, advertising, and outbound dialing to circuits. */
  relayOnly?: boolean;
  /** Called whenever the observed set of active network rooms changes. */
  onNetworkRooms?: (rooms: NetworkRoomEntry[]) => void;
  /** Called whenever peer connectivity changes (discovered/connected counts). */
  onPeerStats?: (stats: PeerStats) => void;
  /**
   * Called when the node establishes (or re-establishes) a connection to a
   * bootstrap relay. PeerKit emits no matching disconnect event, so this only
   * ever transitions the relay status to connected, never back. (Upstream gap.)
   */
  onRelayConnected?: (address: string) => void;
}

export interface ChatNode {
  readonly agentId: AgentId;
  readonly room: Room;
  setDisplayName(name: string): void;
  setCameraState(on: boolean): void;
  sendSignal(toAgent: AgentId, signal: WebRtcSignal): Promise<void>;
  getPeerStats(): PeerStats;
  shutDown(): Promise<void>;
}

export async function startChatNode(
  options: ChatNodeOptions,
): Promise<ChatNode> {
  if (options.relayOnly === true && options.listenAddresses !== undefined) {
    throw new Error("relayOnly cannot be combined with explicit listenAddresses");
  }

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
      if (view.kind === "inRoom") {
        const roster = view.members
          .map((m) => `${sanitizeForLog(m.displayName)} (${m.agentId.slice(0, 12)})`)
          .join(", ");
        console.info(
          `chat-node: room "${view.room}" roster (${view.members.length}): ${roster}`,
        );
      } else {
        console.info("chat-node: left room");
      }
      options.events.onState(view);
    },
    onChat: options.events.onChat,
    onSignal: options.events.onSignal,
    onMediaState: options.events.onMediaState,
  };

  // ─────────────────────────────────────────────────────────────────────────

  // ── TEMPORARY: NO_RESERVATION dial cooldown ───────────────────────────────
  // The agent store can advertise peers the relay has no circuit reservation
  // for — e.g. a peer that left but whose signed AgentInfo has not yet expired.
  // Dialing them fails with "NO_RESERVATION", and because we redial on every
  // agent-store gossip this otherwise spams the relay indefinitely.
  //
  // Back off rather than ban: after a NO_RESERVATION, pause dials to that peer
  // for a cooldown. We don't schedule our own retry timer — the re-probe is the
  // next agent-store gossip after the cooldown lapses. PeerKit emits those
  // continuously while connected to the relay (they are what drives the dial
  // loop in the first place), so a paused peer is retried within a gossip
  // interval of the cooldown expiring; if it fails again the cooldown re-arms.
  // (If gossip stops entirely the relay link is down and there is nothing to
  // dial anyway.) This caps the storm at ~one dial per cooldown while still
  // recovering on its own from a transient relay blip — a hard ban would lock
  // out a peer that briefly lost its reservation if it never dials us inbound. A
  // peer that does connect inbound clears the cooldown immediately (see
  // peerConnectedObserver). Cooldowns are in-memory, so they also reset across
  // restarts (when agent ids change anyway).
  //
  // Remove this whole block (and its call sites) once PeerKit prunes
  // reservation-less peers.
  const NO_RESERVATION_COOLDOWN_MS = 60_000;
  const noReservationUntil = new Map<AgentId, number>();
  const isNoReservation = (err: unknown): boolean =>
    err instanceof Error && err.message.includes("NO_RESERVATION");
  const dialPaused = (agentId: AgentId): boolean =>
    (noReservationUntil.get(agentId) ?? 0) > Date.now();
  // ──────────────────────────────────────────────────────────────────────────

  function relayDialAddresses(
    agentId: AgentId,
    addresses: NodeAddress[],
  ): NodeAddress[] {
    const relayed: NodeAddress[] = [];
    for (const address of addresses) {
      try {
        const components = multiaddr(address).getComponents();
        // WebRTC Direct may be the transport used to reach the relay itself.
        // The circuit component still guarantees that the peer hop is relayed.
        if (
          components.some((component) => component.code === CODE_P2P_CIRCUIT) &&
          components.every((component) => component.code !== CODE_WEBRTC)
        ) {
          relayed.push(address);
        }
      } catch {
        console.warn(
          `chat-node: ${peerLabel(agentId)} advertised a malformed address — skipping it`,
        );
      }
    }
    return relayed;
  }

  const tryDial = async (
    node: PeerkitNode,
    agentId: AgentId,
  ): Promise<boolean> => {
    if (agentId === node.keyPair.agentId()) return false;
    if (node.isConnected(agentId)) return false;
    if (dialPaused(agentId)) return false; // TEMPORARY: see block above
    const info = node.agentStore.get(agentId);
    if (info === undefined) return false;
    const addresses = options.relayOnly
      ? relayDialAddresses(agentId, info.addresses)
      : info.addresses;
    if (addresses.length === 0) {
      console.info(
        `chat-node: ${peerLabel(agentId)} has no ${options.relayOnly ? "relayed" : "dialable"} address — skipping dial`,
      );
      return false;
    }
    try {
      // connect() takes the peer's full address list and tries each itself.
      await node.transport.connect(addresses);
    } catch (err) {
      // TEMPORARY: pause dials to a peer the relay won't reserve for.
      if (isNoReservation(err)) {
        noReservationUntil.set(agentId, Date.now() + NO_RESERVATION_COOLDOWN_MS);
        console.info(
          `chat-node: ${peerLabel(agentId)} has no relay reservation — pausing dials for ${NO_RESERVATION_COOLDOWN_MS / 1000}s`,
        );
        return false;
      }
      console.warn(
        `chat-node: dial ${agentId.slice(0, 12)} failed: ${(err as Error).message}`,
      );
    }
    return true;
  };

  const tryDialWithRetry = async (node: PeerkitNode, agentId: AgentId): Promise<void> => {
    if (dialPaused(agentId)) return; // TEMPORARY: see block above
    if (!(await tryDial(node, agentId))) return;
    for (const delay of [1000, 2000, 4000]) {
      if (node.isConnected(agentId)) return;
      if (dialPaused(agentId)) return; // TEMPORARY: paused mid-retry
      await new Promise<void>((r) => setTimeout(r, delay));
      if (!(await tryDial(node, agentId))) return;
    }
  };

  let nodeRef: PeerkitNode | undefined;

  // The agent store carries only agentId + addresses, never a display name. Names
  // are learned solely from room join/roster traffic, tracked in networkRooms;
  // resolve from there so connected/discovered peers can be identified by name.
  function resolveDisplayName(agentId: AgentId): string | undefined {
    for (const members of networkRooms.values()) {
      const name = members.get(agentId);
      if (name !== undefined) return name;
    }
    return undefined;
  }

  // Human-readable peer tag for logs: "name (abc123def456)" when the name is
  // known, otherwise just the short agentId. Display names are peer-supplied, so
  // strip control chars to stop a crafted name forging extra log lines.
  function peerLabel(agentId: AgentId): string {
    const name = resolveDisplayName(agentId);
    const short = agentId.slice(0, 12);
    return name !== undefined ? `${sanitizeForLog(name)} (${short})` : short;
  }

  function computePeerStats(node: PeerkitNode): PeerStats {
    const self = node.keyPair.agentId();
    const connected = node.getConnectedAgents().filter((a) => a !== self);
    const peers: PeerInfo[] = [];
    const seen = new Set<AgentId>();
    let direct = 0;
    for (const a of connected) {
      const isDirect = node.isDirectConnection(a);
      if (isDirect) direct++;
      peers.push({
        agentId: a,
        displayName: resolveDisplayName(a),
        connected: true,
        direct: isDirect,
      });
      seen.add(a);
    }
    // `discovered` stays a raw count of live agent-store records (minus self), so
    // it tracks PeerKit's TTL/renewal behaviour exactly. Add any discovered-but-
    // not-connected agents to the identity list too.
    const discovered = new Set<AgentId>();
    for (const info of node.agentStore.getAll()) {
      if (info.agentId === self) continue;
      discovered.add(info.agentId);
      if (!seen.has(info.agentId)) {
        peers.push({
          agentId: info.agentId,
          displayName: resolveDisplayName(info.agentId),
          connected: false,
          direct: false,
        });
        seen.add(info.agentId);
      }
    }
    return {
      discovered: discovered.size,
      connected: connected.length,
      direct,
      relayed: connected.length - direct,
      peers,
    };
  }

  function emitPeerStats(): void {
    const node = nodeRef;
    if (node === undefined || options.onPeerStats === undefined) return;
    options.onPeerStats(computePeerStats(node));
  }

  const builder = new PeerkitNodeBuilder({
    agentKeyStore: options.agentKeyStore,
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
      emitPeerStats();
      for (const id of agentIds) void tryDialWithRetry(node, id);
    })
    .withPeerConnectedObserver((agentId) => {
      // New peer connection: announce our room membership directly to *this* peer
      // (not a broadcast — that races the connected-set bookkeeping and can miss
      // the very peer that just connected). Roster reconciliation happens via
      // their roster reply (if they're also in the room).
      noReservationUntil.delete(agentId); // TEMPORARY: peer is reachable again
      const live = nodeRef ? computePeerStats(nodeRef).connected : 0;
      console.info(
        `chat-node: peer connected ${peerLabel(agentId)} (${live} connected)`,
      );
      emitPeerStats();
      roomRef.current?.announceTo(agentId);
    })
    .withPeerDisconnectedObserver((agentId) => {
      console.info(`chat-node: peer disconnected ${peerLabel(agentId)}`);
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
      emitPeerStats();
      roomRef.current?.onPeerDisconnected(agentId);
    })
    .withRelayConnectedObserver((address) => {
      options.onRelayConnected?.(String(address));
    });

  if (options.id !== undefined) {
    builder.withId(options.id);
  }
  if (options.relayOnly === true) {
    builder.withAddresses(["/p2p-circuit"]);
  } else if (options.listenAddresses !== undefined) {
    builder.withAddresses(options.listenAddresses);
  }
  if (options.transportFactory !== undefined) {
    builder.withTransportFactory(options.transportFactory);
  }

  const node = await builder.build();
  nodeRef = node;
  selfAgentId = node.keyPair.agentId();

  // PeerKit emits no event when a relayed connection upgrades to a direct one,
  // nor when agent-store records expire by TTL, so poll to keep the
  // direct/relayed split and the discovered count fresh. (Upstream gap.)
  const statsTimer = setInterval(emitPeerStats, 3000);
  emitPeerStats();

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
    setCameraState(on: boolean) {
      room.setCameraState(on);
    },
    async sendSignal(toAgent: AgentId, signal: WebRtcSignal) {
      await room.sendSignal(toAgent, signal);
    },
    getPeerStats() {
      return computePeerStats(node);
    },
    async shutDown() {
      clearInterval(statsTimer);
      try {
        await room.leave();
      } catch {
        // best effort
      }
      await node.shutDown();
    },
  };
}
