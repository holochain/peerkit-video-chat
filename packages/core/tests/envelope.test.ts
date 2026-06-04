import { describe, it, expect } from "vitest";
import { Encoder } from "cbor-x";

import {
  encode,
  decode,
  MsgType,
  type Envelope,
} from "../src/envelope.js";

// Raw encoder matching the module's settings, used to craft frames the public
// encode() would never produce (wrong version, missing fields, bad shapes).
const raw = new Encoder({ useRecords: false });

describe("envelope round-trip", () => {
  const cases: Envelope[] = [
    { v: 1, type: MsgType.RoomJoin, from: "a", room: "lobby", ts: 1, displayName: "Alice" },
    { v: 1, type: MsgType.RoomLeave, from: "a", room: "lobby", ts: 2 },
    {
      v: 1,
      type: MsgType.RoomRoster,
      from: "a",
      room: "lobby",
      ts: 3,
      members: [
        { agentId: "a", displayName: "Alice" },
        { agentId: "b", displayName: "Bob" },
      ],
    },
    { v: 1, type: MsgType.ChatMsg, from: "a", room: "lobby", ts: 4, body: "hi" },
    { v: 1, type: MsgType.MediaState, from: "a", room: "lobby", ts: 8, camera: false },
    { v: 1, type: MsgType.WebRtcOffer, from: "a", room: "lobby", ts: 5, sdp: "o" },
    { v: 1, type: MsgType.WebRtcAnswer, from: "a", room: "lobby", ts: 6, sdp: "x" },
    { v: 1, type: MsgType.WebRtcIce, from: "a", room: "lobby", ts: 7, candidate: "c" },
  ];

  for (const env of cases) {
    it(`survives encode→decode for type ${env.type}`, () => {
      expect(decode(encode(env))).toEqual(env);
    });
  }
});

describe("decode validation", () => {
  it("rejects an oversized frame before decoding", () => {
    const body = "x".repeat(64 * 1024 + 1);
    const env: Envelope = { v: 1, type: MsgType.ChatMsg, from: "a", room: "r", ts: 1, body };
    const bytes = encode(env);
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    expect(decode(bytes)).toBeNull();
  });

  it("returns null on undecodable bytes", () => {
    expect(decode(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeNull();
  });

  it("returns null on a non-object payload", () => {
    expect(decode(raw.encode(42))).toBeNull();
    expect(decode(raw.encode(null))).toBeNull();
    expect(decode(raw.encode("string"))).toBeNull();
  });

  it("rejects a wrong protocol version", () => {
    expect(
      decode(raw.encode({ v: 2, type: MsgType.RoomLeave, from: "a", room: "r", ts: 1 })),
    ).toBeNull();
  });

  it("rejects missing or mistyped base fields", () => {
    expect(decode(raw.encode({ v: 1, type: MsgType.RoomLeave, room: "r", ts: 1 }))).toBeNull();
    expect(decode(raw.encode({ v: 1, type: MsgType.RoomLeave, from: 1, room: "r", ts: 1 }))).toBeNull();
    expect(decode(raw.encode({ v: 1, type: MsgType.RoomLeave, from: "a", room: 1, ts: 1 }))).toBeNull();
    expect(decode(raw.encode({ v: 1, type: MsgType.RoomLeave, from: "a", room: "r", ts: "x" }))).toBeNull();
  });

  it("rejects an unknown message type", () => {
    expect(decode(raw.encode({ v: 1, type: 99, from: "a", room: "r", ts: 1 }))).toBeNull();
  });

  it("rejects per-type required fields that are missing or wrong", () => {
    const base = { v: 1, from: "a", room: "r", ts: 1 };
    expect(decode(raw.encode({ ...base, type: MsgType.RoomJoin }))).toBeNull();
    expect(decode(raw.encode({ ...base, type: MsgType.ChatMsg }))).toBeNull();
    expect(decode(raw.encode({ ...base, type: MsgType.WebRtcOffer }))).toBeNull();
    expect(decode(raw.encode({ ...base, type: MsgType.WebRtcAnswer }))).toBeNull();
    expect(decode(raw.encode({ ...base, type: MsgType.WebRtcIce }))).toBeNull();
    expect(decode(raw.encode({ ...base, type: MsgType.MediaState }))).toBeNull();
    expect(
      decode(raw.encode({ ...base, type: MsgType.MediaState, camera: "yes" })),
    ).toBeNull();
  });

  it("rejects a roster whose members are malformed", () => {
    const base = { v: 1, from: "a", room: "r", ts: 1, type: MsgType.RoomRoster };
    expect(decode(raw.encode({ ...base, members: "nope" }))).toBeNull();
    expect(decode(raw.encode({ ...base, members: [null] }))).toBeNull();
    expect(decode(raw.encode({ ...base, members: [{ agentId: "a" }] }))).toBeNull();
    expect(decode(raw.encode({ ...base, members: [{ displayName: "x" }] }))).toBeNull();
  });

  it("accepts a roster with an empty member list", () => {
    const env: Envelope = { v: 1, type: MsgType.RoomRoster, from: "a", room: "r", ts: 1, members: [] };
    expect(decode(encode(env))).toEqual(env);
  });
});
