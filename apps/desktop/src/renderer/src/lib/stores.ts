import { writable } from 'svelte/store';

/** Remote peer streams keyed by agentId */
export const remoteStreams = writable(new Map<string, MediaStream>());

/** Set of agentIds currently speaking */
export const speakingPeers = writable(new Set<string>());
