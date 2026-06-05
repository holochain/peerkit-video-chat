import { isIP } from "net";

import { run, type RelayConfig } from "@peerkit/relay";

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

const LISTEN_ADDR = `/ip${ipVersion}/${RELAY_HOST}/tcp/${parsedPort}/ws`;

// Optional OTLP export — only enabled when an endpoint is configured, so local
// dev stays dependency-free while deployed relays emit metrics.
const otlpEndpoint = process.env.RELAY_OTLP_ENDPOINT;

const config: RelayConfig = {
  id: "peerkit-video-chat",
  logLevel: process.env.RELAY_LOG_LEVEL ?? "info",
  listenAddrs: [LISTEN_ADDR],
  // Accept every peer: this is a public rendezvous relay with no allow-list.
  // The token is a single zero byte, not empty: an empty Uint8Array makes the
  // handshake-response send a no-op, so initiators hang until their access
  // handshake times out. The always-true handler below grants regardless.
  networkAccessBytes: new Uint8Array([0]),
  networkAccessHandler: async () => true,
  // When set, the relay announces a /dns4/<host> multiaddr so peers dial the
  // public name instead of the bind address.
  publicHost: process.env.RELAY_PUBLIC_HOST,
  otel: otlpEndpoint
    ? { otlpEndpoint, serviceVersion: process.env.RELAY_VERSION ?? "unknown" }
    : undefined,
};

// run() wires logging, metrics, the agent store and SIGINT/SIGTERM shutdown,
// then keeps the process alive via the libp2p listeners.
run(config).catch((err) => {
  process.stderr.write(`relay failed to start: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
