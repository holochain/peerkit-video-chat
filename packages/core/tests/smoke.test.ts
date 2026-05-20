import { expect, test } from "vitest";

import { MsgType, decode, encode, type Envelope } from "../src/index.js";

test("envelope round-trip preserves all fields", () => {
  const env: Envelope = {
    v: 1,
    type: MsgType.ChatMsg,
    from: "abc123",
    room: "standup",
    ts: 1_700_000_000_000,
    body: "hello world",
  };
  const decoded = decode(encode(env));
  expect(decoded).toEqual(env);
});

test("decode rejects malformed bytes", () => {
  expect(decode(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
});

test("decode rejects an unknown message type discriminator", () => {
  const bogus = { v: 1, type: 99, from: "abc", room: "r", ts: 1 };
  const bytes = encode(bogus as unknown as Envelope);
  expect(decode(bytes)).toBeNull();
});
