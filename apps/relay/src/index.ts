import { readFileSync } from "node:fs";
import { isIP } from "node:net";

import { run, type RelayCertificate, type RelayConfig } from "@peerkit/relay";

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

// The WebRTC Direct transport takes "host:port" listen addresses and builds the
// /ip4|6/<host>/udp/<port>/webrtc-direct multiaddr itself. IPv6 needs brackets.
const LISTEN_ADDR = ipVersion === 6 ? `[${RELAY_HOST}]:${parsedPort}` : `${RELAY_HOST}:${parsedPort}`;

// Load a persisted WebRTC Direct certificate so the relay's certhash — and
// therefore its dialable multiaddrs — stay stable across restarts. RELAY_CERT_PATH
// points at a JSON file holding a RelayCertificate (see scripts/gen-cert.ts).
// When unset, libp2p mints an ephemeral certificate and the certhash changes on
// every restart, which breaks any peer that hardcoded the old certhash.
const certPath = process.env.RELAY_CERT_PATH ?? "";
let certificate: RelayCertificate | undefined;
if (certPath !== "") {
  try {
    certificate = JSON.parse(readFileSync(certPath, "utf8")) as RelayCertificate;
  } catch (err) {
    process.stderr.write(
      `relay: failed to read RELAY_CERT_PATH "${certPath}": ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
} else {
  process.stderr.write(
    "relay: RELAY_CERT_PATH unset — using an ephemeral certificate (certhash changes on restart)\n",
  );
}

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
  // When set, the relay announces a /ip4|6/<publicIp> multiaddr so peers behind
  // NAT dial the public address instead of the bind address.
  publicIp: process.env.RELAY_PUBLIC_IP,
  certificate,
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
