const { withInfoPlist, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// libp2p reaches the relay and LAN peers over cleartext WebSocket (`/ws`, not
// `/wss`). iOS App Transport Security and Android's default network policy both
// block cleartext, so those dials fail and the node never gets a circuit
// reservation or a direct peer link.
//
// Release builds get a host-scoped exception for the public demo relay only —
// NOT a blanket allow. Replace it with a secure `wss` relay before shipping to
// production. Debug builds additionally permit cleartext to any host, because
// local development dials LAN peers/relays on rotating private IPs (e.g.
// 192.168.x.x) that a host allowlist cannot enumerate. This mirrors iOS, where
// `NSAllowsLocalNetworking` already permits LAN cleartext, and React Native's
// own debug manifest, which sets `usesCleartextTraffic="true"`.
const CLEARTEXT_HOST = 'peerkit-video-chat-demo.holochain.org';

// Release: only the demo relay host may use cleartext.
const RELEASE_NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">${CLEARTEXT_HOST}</domain>
  </domain-config>
</network-security-config>
`;

// Debug: any host may use cleartext (LAN peers, local relay, Metro).
const DEBUG_NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

const withIosCleartextException = (config) =>
  withInfoPlist(config, (cfg) => {
    const ats = cfg.modResults.NSAppTransportSecurity ?? {};
    const exceptionDomains = ats.NSExceptionDomains ?? {};
    exceptionDomains[CLEARTEXT_HOST] = {
      NSExceptionAllowsInsecureHTTPLoads: true,
      NSIncludesSubdomains: false,
    };
    cfg.modResults.NSAppTransportSecurity = {
      ...ats,
      // Permit cleartext to LAN hosts (private IPs, .local) so a relay run on
      // the local network during development is reachable without a per-IP
      // exception. Mirrors the Android debug blanket-cleartext config.
      NSAllowsLocalNetworking: true,
      NSExceptionDomains: exceptionDomains,
    };
    return cfg;
  });

const writeNetworkSecurityConfig = (platformProjectRoot, variant, contents) => {
  const xmlDir = path.join(platformProjectRoot, 'app', 'src', variant, 'res', 'xml');
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), contents);
};

const withAndroidNetworkSecurityFile = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const { platformProjectRoot } = cfg.modRequest;
      // The debug resource shadows the main one in debug builds, so debug gets
      // blanket cleartext while release keeps the host-scoped allowlist.
      writeNetworkSecurityConfig(platformProjectRoot, 'main', RELEASE_NETWORK_SECURITY_CONFIG);
      writeNetworkSecurityConfig(platformProjectRoot, 'debug', DEBUG_NETWORK_SECURITY_CONFIG);
      return cfg;
    },
  ]);

const withAndroidNetworkSecurityManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application !== undefined) {
      application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return cfg;
  });

const withRelayCleartext = (config) =>
  withAndroidNetworkSecurityManifest(
    withAndroidNetworkSecurityFile(withIosCleartextException(config)),
  );

module.exports = withRelayCleartext;
