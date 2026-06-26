export interface IdenticonCell {
  x: number;
  y: number;
}

export function identiconCells(key: string): IdenticonCell[] {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash ^ key.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const cells: IdenticonCell[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      hash = (Math.imul(hash, 1103515245) + 12345) >>> 0;
      if (((hash >> 16) & 1) === 1) {
        cells.push({ x: col, y: row });
        if (col < 2) cells.push({ x: 4 - col, y: row });
      }
    }
  }
  return cells;
}

const PEER_COLORS = [
  "#e67dbe",
  "#7d8ce5",
  "#5ec9d4",
  "#e57d6f",
  "#9d7df0",
  "#7dc99b",
  "#6ea4dd",
  "#dc7d8e",
  "#d4b85a",
  "#c08ae5",
];

export function peerColorFromId(agentId: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < agentId.length; index++) {
    hash = (hash ^ agentId.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return PEER_COLORS[hash % PEER_COLORS.length] ?? PEER_COLORS[0]!;
}

export function shortId(agentId: string): string {
  return agentId.length <= 12 ? agentId : `${agentId.slice(0, 6)}...${agentId.slice(-4)}`;
}

export function makeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return initials.join("") || "?";
}
