// Mesh-topology call sizing. Kept dependency-free so the browser/renderer can
// import it without pulling in the Node-only PeerKit transport via the package
// barrel.

// Mesh topology has a comfortable ceiling: every participant sends and receives
// N-1 media streams, so call quality degrades as the room grows. ~8 participants
// is the practical limit with simulcast and adaptive bitrate (see
// docs/architecture.md § Media topology). The UI warns once a room reaches it.
export const MESH_RECOMMENDED_MAX = 8;

/**
 * True when a room of `memberCount` participants has reached the comfortable
 * mesh ceiling, so the UI should recommend staying within it.
 */
export function exceedsMeshRecommendation(memberCount: number): boolean {
  return memberCount >= MESH_RECOMMENDED_MAX;
}
