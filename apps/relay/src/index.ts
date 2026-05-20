import { PeerkitRelayBuilder } from "@peerkit/peerkit";
import { createRelay } from "@peerkit/transport-libp2p-nodejs";

const LISTEN_ADDR = "/ip4/127.0.0.1/tcp/9000";

async function main(): Promise<void> {
  const relay = await new PeerkitRelayBuilder(async () => true)
    .withId("dev-relay")
    .withAddresses([LISTEN_ADDR])
    .withTransportFactory(createRelay)
    .build();

  const nodeId = relay.transport.getNodeId();
  const fullAddress = `${LISTEN_ADDR}/p2p/${nodeId}`;

  process.stdout.write(
    `peerkit dev relay listening\n  address: ${fullAddress}\n` +
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
