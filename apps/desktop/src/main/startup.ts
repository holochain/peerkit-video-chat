import type {NodeAddress} from '@peerkit/api';

/** Desktop-only PeerKit startup controls parsed from Electron arguments. */
export interface DesktopStartupOptions {
  listenAddresses?: NodeAddress[];
  relayOnly?: boolean;
}

/**
 * Parses PeerKit-specific command-line options while ignoring Electron and
 * Chromium arguments.
 */
export function parseStartupOptions(args: readonly string[]): DesktopStartupOptions {
  const listenAddresses: NodeAddress[] = [];
  let relayOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--relay-only') {
      relayOnly = true;
      continue;
    }
    if (arg === '--listen-address') {
      const rawValue = args[index + 1];
      const value = rawValue?.trim();
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--listen-address requires a non-empty multiaddr');
      }
      listenAddresses.push(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--listen-address=')) {
      const value = arg.slice('--listen-address='.length).trim();
      if (value === '') {
        throw new Error('--listen-address requires a non-empty multiaddr');
      }
      listenAddresses.push(value);
    }
  }

  if (relayOnly && listenAddresses.length > 0) {
    throw new Error('--relay-only cannot be combined with --listen-address');
  }

  return {
    ...(listenAddresses.length > 0 ? {listenAddresses} : {}),
    ...(relayOnly ? {relayOnly: true} : {}),
  };
}
