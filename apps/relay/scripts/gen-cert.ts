/**
 * @fileoverview Generate a persisted WebRTC Direct certificate for the relay.
 *
 * Writes the full RelayCertificate as JSON — consumed at runtime via the
 * RELAY_CERT_PATH env variable — plus the certhash as plain text, which is
 * copied into peers' dial multiaddrs (e.g. mobile's expo.extra.relayMultiaddr).
 * Output lands in a gitignored folder so the private key stays local.
 *
 * The certificate is self-minted here rather than via @peerkit's
 * generateRelayCertificate() because that helper hardcodes a 14-day validity,
 * which would expire the persisted certhash (and break every peer that pinned
 * it) two weeks after generation. WebRTC Direct authenticates peers by matching
 * the certhash fingerprint in the SDP, not by the certificate's notAfter, so a
 * long validity on the relay side is safe and keeps the certhash stable. The
 * keypair, signing algorithm, extensions and certhash derivation mirror the
 * upstream helper exactly — only the validity window differs.
 */

import "reflect-metadata";

import { webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as x509 from "@peculiar/x509";
import type { RelayCertificate } from "@peerkit/relay";
import { base64url } from "multiformats/bases/base64";
import { sha256 } from "multiformats/hashes/sha2";

const CERT_VALIDITY_YEARS = 5;

async function generateRelayCertificate(): Promise<RelayCertificate> {
  // x509's provider is a process-global singleton; pin it to Node's WebCrypto so
  // the keypair and the signer share one CryptoKey implementation.
  x509.cryptoProvider.set(webcrypto);

  // WebRTC Direct requires ECDSA on the P-256 curve.
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;

  const notBefore = new Date();
  notBefore.setMilliseconds(0);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notBefore.getFullYear() + CERT_VALIDITY_YEARS);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    // Serial uniqueness is satisfied by the fresh keypair, not this value.
    serialNumber: "01",
    name: "CN=peerkit-relay",
    notBefore,
    notAfter,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: keyPair,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });

  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const certhash = base64url.encode((await sha256.digest(new Uint8Array(cert.rawData))).bytes);

  return {
    privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
    certificatePem: cert.toString("pem"),
    certhash,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const certDir = join(here, "..", "certs");
const certPath = join(certDir, "relay-cert.json");
const certhashPath = join(certDir, "certhash.txt");

const certificate = await generateRelayCertificate();

// relay-cert.json holds privateKeyPem — lock the directory and the file down to
// the owner so a permissive umask can't leave the private key world-readable.
mkdirSync(certDir, { recursive: true, mode: 0o700 });
writeFileSync(certPath, `${JSON.stringify(certificate, null, 2)}\n`, { mode: 0o600 });
writeFileSync(certhashPath, `${certificate.certhash}\n`);

process.stdout.write(`relay certificate written to ${certPath}\n`);
process.stdout.write(`certhash: ${certificate.certhash}\n`);
