import './shims/hermes-polyfills';
import '@peerkit/transport-libp2p-react-native/polyfills';
import { configure, getConsoleSink } from '@logtape/logtape';
import { AppRegistry } from 'react-native';
import App from './src/App';

// Surface peerkit transport logs (relay dial, handshakes, peer connects) to the
// Metro console. Without a configured sink, LogTape drops every record, so relay
// failures are otherwise invisible in development.
configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: ['peerkit'], lowestLevel: 'debug', sinks: ['console'] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
  ],
}).catch((error) => {
  console.warn('LogTape configuration failed', error);
});

AppRegistry.registerComponent('main', () => App);
