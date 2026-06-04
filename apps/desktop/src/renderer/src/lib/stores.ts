import { writable } from 'svelte/store';

/** Remote peer streams keyed by agentId */
export const remoteStreams = writable(new Map<string, MediaStream>());

/** Set of agentIds currently speaking */
export const speakingPeers = writable(new Set<string>());

/**
 * Set of agentIds whose remote video track is currently producing frames.
 * A peer turning its camera off replaces its outbound track with null, which
 * mutes the remote track (it is not removed), so the stream still reports a
 * video track. This tracks the live/muted state so the tile can fall back to a
 * placeholder instead of freezing on the last frame.
 */
export const remoteVideoLive = writable(new Set<string>());
