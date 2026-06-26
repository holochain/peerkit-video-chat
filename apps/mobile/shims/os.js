// Minimal `os` shim for React Native. libp2p's @libp2p/utils imports `node:os`
// to enumerate network interfaces ("thin-waist" address computation) for
// listening sockets. A React Native client only dials, so this never runs — but
// the module is bundled eagerly, so it must resolve. Provide harmless stubs.
module.exports = {
  networkInterfaces: () => ({}),
  hostname: () => 'localhost',
  platform: () => 'react-native',
  arch: () => 'arm64',
  release: () => '',
  type: () => 'React Native',
  cpus: () => [],
  totalmem: () => 0,
  freemem: () => 0,
  EOL: '\n',
};
