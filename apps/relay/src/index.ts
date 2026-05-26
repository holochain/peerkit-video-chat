import { isIP } from "net";

import { PeerkitRelayBuilder } from "@peerkit/peerkit";
import { createRelay } from "@peerkit/transport-libp2p-nodejs";

const RELAY_HOST = process.env.RELAY_HOST ?? "127.0.0.1";

const rawPort = process.env.RELAY_PORT ?? "9000";
const parsedPort = parseInt(rawPort, 10);
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  process.stderr.write(`relay: invalid RELAY_PORT "${rawPort}" — must be 1–65535\n`);
  process.exit(1);
}

const ipVersion = isIP(RELAY_HOST);
if (ipVersion === 0) {
  process.stderr.write(`relay: invalid RELAY_HOST "${RELAY_HOST}"\n`);
  process.exit(1);
}

const LISTEN_ADDR = `/ip${ipVersion}/${RELAY_HOST}/tcp/${parsedPort}`;

async function main(): Promise<void> {
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("peerkit-video-chat")
    .withAddresses([LISTEN_ADDR])
    .withTransportFactory(createRelay)
    .build();

  const nodeId = relay.transport.getNodeId();
  const fullAddress = `${LISTEN_ADDR}/p2p/${nodeId}`;

  process.stdout.write(
    `peerkit relay listening\n  address: ${fullAddress}\n` +
      `  start a desktop window with: PEERKIT_RELAY_ADDR=${fullAddress} npm run dev:desktop\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nreceived ${signal}, shutting down\n`);
    await relay.shutDown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`relay failed to start: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
