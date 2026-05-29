import type { AgentId } from "@peerkit/api";

import {
  MsgType,
  type ChatMsg,
  type Envelope,
  type RoomJoinMsg,
  type RoomLeaveMsg,
  type RoomRosterMsg,
  type RosterEntry,
  type WebRtcIceMsg,
  type WebRtcOfferMsg,
  type WebRtcAnswerMsg,
  type WebRtcSignal,
} from "./envelope.js";

export type RoomStateView =
  | { kind: "idle" }
  | { kind: "inRoom"; room: string; members: RosterEntry[] };

export interface IncomingChat {
  from: AgentId;
  displayName: string;
  room: string;
  body: string;
  ts: number;
}

export interface RoomTransport {
  readonly agentId: AgentId;
  broadcast(envelope: Envelope): Promise<void>;
  sendTo(agentId: AgentId, envelope: Envelope): Promise<void>;
}

export interface RoomEvents {
  onState(view: RoomStateView): void;
  onChat(chat: IncomingChat): void;
  onSignal(fromAgent: AgentId, signal: WebRtcSignal): void;
}

export function normalizeRoomName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

type State =
  | { kind: "idle" }
  | { kind: "inRoom"; room: string; members: Map<AgentId, string> };

export class Room {
  private state: State = { kind: "idle" };
  private displayName: string;

  constructor(
    private readonly transport: RoomTransport,
    private readonly events: RoomEvents,
    initialDisplayName: string,
  ) {
    this.displayName = initialDisplayName;
  }

  setDisplayName(name: string): void {
    this.displayName = name;
    if (this.state.kind === "inRoom") {
      // Re-announce so peers update their roster entry for us.
      void this.broadcastJoin(this.state.room);
      this.state.members.set(this.transport.agentId, name);
      this.emitState();
    }
  }

  async join(rawRoomName: string): Promise<void> {
    if (this.state.kind === "inRoom") {
      throw new Error("already in a room; leave first");
    }
    const room = normalizeRoomName(rawRoomName);
    if (room === "") {
      throw new Error("room name cannot be empty");
    }
    const members = new Map<AgentId, string>();
    members.set(this.transport.agentId, this.displayName);
    this.state = { kind: "inRoom", room, members };
    this.emitState();
    await this.broadcastJoin(room);
  }

  async leave(): Promise<void> {
    if (this.state.kind !== "inRoom") return;
    // Transition locally first so the UI and onIncoming() stop treating us as
    // in-room immediately; the RoomLeave broadcast is best effort.
    const room = this.state.room;
    this.state = { kind: "idle" };
    this.emitState();
    const env: RoomLeaveMsg = {
      v: 1,
      type: MsgType.RoomLeave,
      from: this.transport.agentId,
      room,
      ts: Date.now(),
    };
    await this.transport.broadcast(env);
  }

  async sendChat(body: string): Promise<void> {
    if (this.state.kind !== "inRoom") {
      throw new Error("not in a room");
    }
    const room = this.state.room;
    const ts = Date.now();
    const env: ChatMsg = {
      v: 1,
      type: MsgType.ChatMsg,
      from: this.transport.agentId,
      room,
      ts,
      body,
    };
    // Echo locally first so the sender sees their own message immediately,
    // regardless of how slow (or failed) the fan-out to peers is.
    this.events.onChat({
      from: this.transport.agentId,
      displayName: this.displayName,
      room,
      body,
      ts,
    });
    await this.transport.broadcast(env);
  }

  onIncoming(env: Envelope, fromAgent: AgentId): void {
    if (env.from !== fromAgent) return;
    if (fromAgent === this.transport.agentId) return;
    if (this.state.kind !== "inRoom") return;
    if (env.room !== this.state.room) return;

    switch (env.type) {
      case MsgType.RoomJoin:
        this.handleJoin(env);
        break;
      case MsgType.RoomLeave:
        this.handleLeave(env);
        break;
      case MsgType.RoomRoster:
        this.handleRoster(env);
        break;
      case MsgType.ChatMsg:
        this.handleChat(env);
        break;
      case MsgType.WebRtcOffer:
        this.events.onSignal(env.from, { kind: "offer", sdp: env.sdp });
        break;
      case MsgType.WebRtcAnswer:
        this.events.onSignal(env.from, { kind: "answer", sdp: env.sdp });
        break;
      case MsgType.WebRtcIce:
        this.events.onSignal(env.from, { kind: "ice", candidate: env.candidate });
        break;
    }
  }

  async sendSignal(toAgent: AgentId, signal: WebRtcSignal): Promise<void> {
    if (this.state.kind !== "inRoom") {
      throw new Error("not in a room");
    }
    const base = {
      v: 1 as const,
      from: this.transport.agentId,
      room: this.state.room,
      ts: Date.now(),
    };
    let env: WebRtcOfferMsg | WebRtcAnswerMsg | WebRtcIceMsg;
    if (signal.kind === "offer") {
      env = { ...base, type: MsgType.WebRtcOffer, sdp: signal.sdp };
    } else if (signal.kind === "answer") {
      env = { ...base, type: MsgType.WebRtcAnswer, sdp: signal.sdp };
    } else {
      env = { ...base, type: MsgType.WebRtcIce, candidate: signal.candidate };
    }
    await this.transport.sendTo(toAgent, env);
  }

  reannounce(): void {
    if (this.state.kind !== "inRoom") return;
    void this.broadcastJoin(this.state.room);
  }

  /**
   * Current room membership as a snapshot. Lets a freshly (re)loaded UI learn
   * it is already in a room — e.g. after the renderer reloads on laptop wake
   * while the node kept running — without waiting for the next state event.
   */
  getStateView(): RoomStateView {
    if (this.state.kind === "idle") return { kind: "idle" };
    return {
      kind: "inRoom",
      room: this.state.room,
      members: this.rosterEntries(),
    };
  }

  onPeerDisconnected(agentId: AgentId): void {
    if (this.state.kind !== "inRoom") return;
    if (this.state.members.delete(agentId)) {
      this.emitState();
    }
  }

  private async broadcastJoin(room: string): Promise<void> {
    const env: RoomJoinMsg = {
      v: 1,
      type: MsgType.RoomJoin,
      from: this.transport.agentId,
      room,
      ts: Date.now(),
      displayName: this.displayName,
    };
    await this.transport.broadcast(env);
  }

  private handleJoin(env: RoomJoinMsg): void {
    if (this.state.kind !== "inRoom") return;
    this.state.members.set(env.from, env.displayName);
    this.emitState();

    const reply: RoomRosterMsg = {
      v: 1,
      type: MsgType.RoomRoster,
      from: this.transport.agentId,
      room: this.state.room,
      ts: Date.now(),
      members: this.rosterEntries(),
    };
    void this.transport.sendTo(env.from, reply);
  }

  private handleLeave(env: RoomLeaveMsg): void {
    if (this.state.kind !== "inRoom") return;
    if (this.state.members.delete(env.from)) {
      this.emitState();
    }
  }

  private handleRoster(env: RoomRosterMsg): void {
    if (this.state.kind !== "inRoom") return;
    let changed = false;
    for (const entry of env.members) {
      if (entry.agentId === this.transport.agentId) continue;
      if (this.state.members.get(entry.agentId) !== entry.displayName) {
        this.state.members.set(entry.agentId, entry.displayName);
        changed = true;
      }
    }
    if (changed) this.emitState();
  }

  private handleChat(env: ChatMsg): void {
    if (this.state.kind !== "inRoom") return;
    const displayName =
      this.state.members.get(env.from) ?? env.from.slice(0, 12);
    this.events.onChat({
      from: env.from,
      displayName,
      room: env.room,
      body: env.body,
      ts: env.ts,
    });
  }

  private rosterEntries(): RosterEntry[] {
    if (this.state.kind !== "inRoom") return [];
    return [...this.state.members.entries()].map(([agentId, displayName]) => ({
      agentId,
      displayName,
    }));
  }

  private emitState(): void {
    if (this.state.kind === "idle") {
      this.events.onState({ kind: "idle" });
      return;
    }
    this.events.onState({
      kind: "inRoom",
      room: this.state.room,
      members: this.rosterEntries(),
    });
  }
}
