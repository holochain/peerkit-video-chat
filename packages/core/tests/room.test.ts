import { describe, it, expect, vi, beforeEach } from "vitest";

import { Room, normalizeRoomName, type RoomTransport, type RoomEvents } from "../src/room.js";
import { MsgType, type Envelope } from "../src/envelope.js";

const SELF = "self-agent";

function makeTransport(): RoomTransport & {
  broadcast: ReturnType<typeof vi.fn>;
  sendTo: ReturnType<typeof vi.fn>;
} {
  return {
    agentId: SELF,
    broadcast: vi.fn(async () => {}),
    sendTo: vi.fn(async () => {}),
  };
}

function makeEvents(): RoomEvents & {
  onState: ReturnType<typeof vi.fn>;
  onChat: ReturnType<typeof vi.fn>;
  onSignal: ReturnType<typeof vi.fn>;
} {
  return { onState: vi.fn(), onChat: vi.fn(), onSignal: vi.fn() };
}

describe("normalizeRoomName", () => {
  it("trims, collapses internal whitespace, and lowercases", () => {
    expect(normalizeRoomName("  My  Room\tName ")).toBe("my room name");
    expect(normalizeRoomName("LOBBY")).toBe("lobby");
    expect(normalizeRoomName("   ")).toBe("");
  });
});

describe("Room lifecycle", () => {
  let transport: ReturnType<typeof makeTransport>;
  let events: ReturnType<typeof makeEvents>;
  let room: Room;

  beforeEach(() => {
    transport = makeTransport();
    events = makeEvents();
    room = new Room(transport, events, "Me");
  });

  it("join enters the room, emits state with self, and broadcasts a join", async () => {
    await room.join("Lobby");
    expect(events.onState).toHaveBeenCalledWith({
      kind: "inRoom",
      room: "lobby",
      members: [{ agentId: SELF, displayName: "Me" }],
    });
    const env = transport.broadcast.mock.calls[0][0] as Envelope;
    expect(env).toMatchObject({ type: MsgType.RoomJoin, from: SELF, room: "lobby", displayName: "Me" });
  });

  it("rejects joining when already in a room", async () => {
    await room.join("lobby");
    await expect(room.join("other")).rejects.toThrow("already in a room");
  });

  it("rejects an empty room name", async () => {
    await expect(room.join("   ")).rejects.toThrow("room name cannot be empty");
  });

  it("leave from idle is a no-op", async () => {
    await room.leave();
    expect(transport.broadcast).not.toHaveBeenCalled();
    expect(events.onState).not.toHaveBeenCalled();
  });

  it("leave emits idle and broadcasts a leave", async () => {
    await room.join("lobby");
    transport.broadcast.mockClear();
    events.onState.mockClear();
    await room.leave();
    expect(events.onState).toHaveBeenCalledWith({ kind: "idle" });
    expect(transport.broadcast.mock.calls[0][0]).toMatchObject({
      type: MsgType.RoomLeave,
      from: SELF,
      room: "lobby",
    });
  });
});

describe("Room chat", () => {
  let transport: ReturnType<typeof makeTransport>;
  let events: ReturnType<typeof makeEvents>;
  let room: Room;

  beforeEach(async () => {
    transport = makeTransport();
    events = makeEvents();
    room = new Room(transport, events, "Me");
    await room.join("lobby");
    transport.broadcast.mockClear();
    events.onState.mockClear();
    events.onChat.mockClear();
  });

  it("sendChat echoes locally then broadcasts", async () => {
    await room.sendChat("hello");
    expect(events.onChat).toHaveBeenCalledWith(
      expect.objectContaining({ from: SELF, displayName: "Me", room: "lobby", body: "hello" }),
    );
    expect(transport.broadcast.mock.calls[0][0]).toMatchObject({
      type: MsgType.ChatMsg,
      from: SELF,
      body: "hello",
    });
  });

  it("sendChat throws when not in a room", async () => {
    await room.leave();
    await expect(room.sendChat("x")).rejects.toThrow("not in a room");
  });
});

describe("Room.onIncoming filtering", () => {
  let transport: ReturnType<typeof makeTransport>;
  let events: ReturnType<typeof makeEvents>;
  let room: Room;

  beforeEach(async () => {
    transport = makeTransport();
    events = makeEvents();
    room = new Room(transport, events, "Me");
    await room.join("lobby");
    transport.broadcast.mockClear();
    transport.sendTo.mockClear();
    events.onState.mockClear();
    events.onChat.mockClear();
  });

  const chat = (from: string, room = "lobby"): Envelope => ({
    v: 1,
    type: MsgType.ChatMsg,
    from,
    room,
    ts: 1,
    body: "hi",
  });

  it("drops a spoofed envelope where from != fromAgent", () => {
    room.onIncoming(chat("peerX"), "peerY");
    expect(events.onChat).not.toHaveBeenCalled();
  });

  it("drops our own echoed envelope", () => {
    room.onIncoming(chat(SELF), SELF);
    expect(events.onChat).not.toHaveBeenCalled();
  });

  it("drops envelopes for a different room", () => {
    room.onIncoming(chat("peer1", "other"), "peer1");
    expect(events.onChat).not.toHaveBeenCalled();
  });

  it("drops everything when idle", async () => {
    await room.leave();
    events.onChat.mockClear();
    room.onIncoming(chat("peer1"), "peer1");
    expect(events.onChat).not.toHaveBeenCalled();
  });

  it("a peer join adds them and replies with the roster", () => {
    room.onIncoming(
      { v: 1, type: MsgType.RoomJoin, from: "peer1", room: "lobby", ts: 1, displayName: "Peer" },
      "peer1",
    );
    expect(events.onState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        members: expect.arrayContaining([{ agentId: "peer1", displayName: "Peer" }]),
      }),
    );
    const [target, reply] = transport.sendTo.mock.calls[0];
    expect(target).toBe("peer1");
    expect(reply).toMatchObject({ type: MsgType.RoomRoster, room: "lobby" });
  });

  it("a peer leave removes them", () => {
    room.onIncoming(
      { v: 1, type: MsgType.RoomJoin, from: "peer1", room: "lobby", ts: 1, displayName: "Peer" },
      "peer1",
    );
    events.onState.mockClear();
    room.onIncoming({ v: 1, type: MsgType.RoomLeave, from: "peer1", room: "lobby", ts: 2 }, "peer1");
    const view = events.onState.mock.lastCall?.[0];
    expect(view.members.map((m: { agentId: string }) => m.agentId)).not.toContain("peer1");
  });

  it("a roster merges members but skips our own entry", () => {
    room.onIncoming(
      {
        v: 1,
        type: MsgType.RoomRoster,
        from: "peer1",
        room: "lobby",
        ts: 1,
        members: [
          { agentId: SELF, displayName: "STALE-SELF" },
          { agentId: "peer1", displayName: "Peer One" },
        ],
      },
      "peer1",
    );
    const view = events.onState.mock.lastCall?.[0];
    const self = view.members.find((m: { agentId: string }) => m.agentId === SELF);
    expect(self.displayName).toBe("Me");
    expect(view.members).toContainEqual({ agentId: "peer1", displayName: "Peer One" });
  });

  it("a chat from a known member uses their display name", () => {
    room.onIncoming(
      { v: 1, type: MsgType.RoomJoin, from: "peer1", room: "lobby", ts: 1, displayName: "Peer" },
      "peer1",
    );
    room.onIncoming(chat("peer1"), "peer1");
    expect(events.onChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: "peer1", displayName: "Peer", body: "hi" }),
    );
  });

  it("a chat from an unknown member falls back to a truncated id", () => {
    room.onIncoming(chat("0123456789abcdefXYZ"), "0123456789abcdefXYZ");
    expect(events.onChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ displayName: "0123456789ab" }),
    );
  });

  it.each([
    [MsgType.WebRtcOffer, { sdp: "o" }, { kind: "offer", sdp: "o" }],
    [MsgType.WebRtcAnswer, { sdp: "a" }, { kind: "answer", sdp: "a" }],
    [MsgType.WebRtcIce, { candidate: "c" }, { kind: "ice", candidate: "c" }],
  ])("routes WebRTC signal type %s to onSignal", (type, extra, expected) => {
    room.onIncoming(
      { v: 1, type, from: "peer1", room: "lobby", ts: 1, ...extra } as Envelope,
      "peer1",
    );
    expect(events.onSignal).toHaveBeenCalledWith("peer1", expected);
  });
});

describe("Room.sendSignal", () => {
  let transport: ReturnType<typeof makeTransport>;
  let room: Room;

  beforeEach(async () => {
    transport = makeTransport();
    room = new Room(transport, makeEvents(), "Me");
    await room.join("lobby");
    transport.sendTo.mockClear();
  });

  it("throws when not in a room", async () => {
    await room.leave();
    await expect(room.sendSignal("peer1", { kind: "offer", sdp: "x" })).rejects.toThrow("not in a room");
  });

  it.each([
    [{ kind: "offer", sdp: "o" } as const, MsgType.WebRtcOffer, { sdp: "o" }],
    [{ kind: "answer", sdp: "a" } as const, MsgType.WebRtcAnswer, { sdp: "a" }],
    [{ kind: "ice", candidate: "c" } as const, MsgType.WebRtcIce, { candidate: "c" }],
  ])("sends %s as the matching envelope type", async (signal, type, fields) => {
    await room.sendSignal("peer1", signal);
    const [target, env] = transport.sendTo.mock.calls[0];
    expect(target).toBe("peer1");
    expect(env).toMatchObject({ type, from: SELF, room: "lobby", ...fields });
  });
});

describe("Room membership edges", () => {
  let transport: ReturnType<typeof makeTransport>;
  let events: ReturnType<typeof makeEvents>;
  let room: Room;

  beforeEach(async () => {
    transport = makeTransport();
    events = makeEvents();
    room = new Room(transport, events, "Me");
    await room.join("lobby");
    room.onIncoming(
      { v: 1, type: MsgType.RoomJoin, from: "peer1", room: "lobby", ts: 1, displayName: "Peer" },
      "peer1",
    );
    transport.broadcast.mockClear();
    events.onState.mockClear();
  });

  it("onPeerDisconnected removes a member and emits", () => {
    room.onPeerDisconnected("peer1");
    expect(events.onState).toHaveBeenCalledOnce();
    const view = events.onState.mock.lastCall?.[0];
    expect(view.members.map((m: { agentId: string }) => m.agentId)).not.toContain("peer1");
  });

  it("onPeerDisconnected for an unknown agent is a no-op", () => {
    room.onPeerDisconnected("ghost");
    expect(events.onState).not.toHaveBeenCalled();
  });

  it("setDisplayName re-announces and updates our own entry", () => {
    room.setDisplayName("Renamed");
    expect(transport.broadcast.mock.calls[0][0]).toMatchObject({
      type: MsgType.RoomJoin,
      displayName: "Renamed",
    });
    const view = events.onState.mock.lastCall?.[0];
    expect(view.members).toContainEqual({ agentId: SELF, displayName: "Renamed" });
  });

  it("reannounce broadcasts a fresh join while in a room", () => {
    room.reannounce();
    expect(transport.broadcast.mock.calls[0][0]).toMatchObject({ type: MsgType.RoomJoin });
  });

  it("getStateView reflects idle and in-room snapshots", async () => {
    expect(room.getStateView()).toMatchObject({ kind: "inRoom", room: "lobby" });
    await room.leave();
    expect(room.getStateView()).toEqual({ kind: "idle" });
  });
});

describe("Room convergence edges", () => {
  let transport: ReturnType<typeof makeTransport>;
  let events: ReturnType<typeof makeEvents>;
  let room: Room;

  beforeEach(async () => {
    transport = makeTransport();
    events = makeEvents();
    room = new Room(transport, events, "Me");
    await room.join("lobby");
    transport.broadcast.mockClear();
    transport.sendTo.mockClear();
    events.onState.mockClear();
    events.onSignal.mockClear();
  });

  const join = (from: string, displayName: string, roomName = "lobby"): Envelope => ({
    v: 1,
    type: MsgType.RoomJoin,
    from,
    room: roomName,
    ts: 1,
    displayName,
  });

  it("a peer re-joining updates its name without duplicating the roster entry", () => {
    room.onIncoming(join("peer1", "Peer"), "peer1");
    room.onIncoming(join("peer1", "Peer Renamed"), "peer1");
    const view = events.onState.mock.lastCall?.[0];
    const peer1 = view.members.filter((m: { agentId: string }) => m.agentId === "peer1");
    expect(peer1).toEqual([{ agentId: "peer1", displayName: "Peer Renamed" }]);
  });

  it("a roster that adds nothing new does not re-emit state", () => {
    room.onIncoming(join("peer1", "Peer"), "peer1");
    events.onState.mockClear();
    room.onIncoming(
      {
        v: 1,
        type: MsgType.RoomRoster,
        from: "peer1",
        room: "lobby",
        ts: 2,
        members: [
          { agentId: SELF, displayName: "Me" },
          { agentId: "peer1", displayName: "Peer" },
        ],
      },
      "peer1",
    );
    expect(events.onState).not.toHaveBeenCalled();
  });

  it("drops a WebRTC signal addressed to a different room", () => {
    room.onIncoming(
      { v: 1, type: MsgType.WebRtcOffer, from: "peer1", room: "other", ts: 1, sdp: "o" },
      "peer1",
    );
    expect(events.onSignal).not.toHaveBeenCalled();
  });

  it("ignores a leave for a peer that never joined", () => {
    room.onIncoming({ v: 1, type: MsgType.RoomLeave, from: "ghost", room: "lobby", ts: 1 }, "ghost");
    expect(events.onState).not.toHaveBeenCalled();
  });
});
