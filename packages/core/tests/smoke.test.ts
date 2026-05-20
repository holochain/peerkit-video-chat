import { expect, test } from "vitest";
import { startPeer } from "../src/index.js";

test("starts a PeerKit peer and returns an agentId", async () => {
  const peer = await startPeer({
    id: "smoke",
    listenAddress: "/ip4/127.0.0.1/tcp/0",
  });
  try {
    expect(peer.agentId).toBeTruthy();
  } finally {
    await peer.shutDown();
  }
});
