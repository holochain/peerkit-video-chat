/**
 * @fileoverview Generate a persisted WebRTC Direct certificate for the relay.
 *
 * Writes the full RelayCertificate as JSON — consumed at runtime via the
 * RELAY_CERT_PATH env variable — plus the certhash as plain text, which is
 * copied into peers' dial multiaddrs (e.g. mobile's expo.extra.relayMultiaddr).
 * Output lands in a gitignored folder so the private key stays local.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateRelayCertificate } from "@peerkit/relay";

const here = dirname(fileURLToPath(import.meta.url));
const certDir = join(here, "..", "certs");
const certPath = join(certDir, "relay-cert.json");
const certhashPath = join(certDir, "certhash.txt");

const certificate = await generateRelayCertificate();

mkdirSync(certDir, { recursive: true });
writeFileSync(certPath, `${JSON.stringify(certificate, null, 2)}\n`);
writeFileSync(certhashPath, `${certificate.certhash}\n`);

process.stdout.write(`relay certificate written to ${certPath}\n`);
process.stdout.write(`certhash: ${certificate.certhash}\n`);
