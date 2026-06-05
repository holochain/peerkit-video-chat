const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');
const peerkitRoot = path.resolve(repoRoot, '../peerkit');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [
  repoRoot,
  peerkitRoot,
];

config.resolver.unstable_enablePackageExports = true;
config.resolver.nodeModulesPaths = [
  path.resolve(repoRoot, 'node_modules'),
  path.resolve(peerkitRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  buffer: require.resolve('buffer'),
  crypto: require.resolve('react-native-quick-crypto'),
  events: require.resolve('events'),
  process: require.resolve('process'),
  stream: require.resolve('stream-browserify'),
  // libp2p's @libp2p/utils reaches for `os` (network-interface enumeration);
  // irrelevant on a dial-only RN client. Stub it so the bundle resolves.
  os: require.resolve('./shims/os.js'),
};

// Dedupe singletons to this app's node_modules. The sibling `peerkit` repo
// (linked via the file: transport dep and watched above) pins its own copies of
// react-native, @react-native/*, and the native modules. Without this, metro's
// upward resolution pulls React Native core from peerkit's copy (a different
// version than the Expo-matched one here), which breaks codegen at bundle time
// and causes two native libwebrtc / audio sessions at runtime. Forcing these to
// resolve from the app's node_modules keeps exactly one copy of each.
const appModules = path.resolve(repoRoot, 'node_modules');
const FORCE_APP_COPY = new Set([
  'react',
  'react-dom',
  'scheduler',
  'react-native',
  'react-native-webrtc',
  'react-native-quick-crypto',
  'react-native-get-random-values',
  'react-native-permissions',
  '@react-native-async-storage/async-storage',
]);
const FORCE_APP_SCOPES = ['@react-native/'];

function packageRoot(moduleName) {
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/');
    return `${parts[0]}/${parts[1]}`;
  }
  return moduleName.split('/')[0];
}

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Rewrite `node:` builtins to bare specifiers so the extraNodeModules shims
  // above can satisfy them (metro's exports resolver doesn't map the prefix).
  if (moduleName.startsWith('node:')) {
    const resolve = defaultResolveRequest ?? context.resolveRequest;
    return resolve(context, moduleName.slice('node:'.length), platform);
  }
  const root = packageRoot(moduleName);
  const forced =
    FORCE_APP_COPY.has(root) || FORCE_APP_SCOPES.some((scope) => moduleName.startsWith(scope));
  const ctx =
    forced && !context.originModulePath.startsWith(appModules)
      ? { ...context, originModulePath: path.join(appModules, 'metro-dedupe.js') }
      : context;
  const resolve = defaultResolveRequest ?? ctx.resolveRequest;
  return resolve(ctx, moduleName, platform);
};

module.exports = config;
