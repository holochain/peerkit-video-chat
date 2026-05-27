// identicon.ts — deterministic 5×5 identicon algorithm
// FNV-1a hash → LCG bitstream → 5×5 cells (vertically symmetric)

export interface IdenticonCell {
  x: number;
  y: number;
}

export function identiconCells(key: string): IdenticonCell[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const cells: IdenticonCell[] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      if (((h >> 16) & 1) === 1) {
        cells.push({ x: c, y: r });
        if (c < 2) cells.push({ x: 4 - c, y: r }); // mirror
      }
    }
  }
  return cells;
}

const PEER_COLORS = [
  '#e67dbe', // magenta
  '#7d8ce5', // periwinkle
  '#5ec9d4', // teal nebula
  '#e57d6f', // coral
  '#9d7df0', // soft violet
  '#7dc99b', // aurora green
  '#6ea4dd', // cosmic blue
  '#dc7d8e', // rose
  '#d4b85a', // amber
  '#c08ae5', // orchid
];

export function peerColorFromId(agentId: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (h ^ agentId.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PEER_COLORS[h % PEER_COLORS.length];
}

const identiconCache = new Map<string, IdenticonCell[]>();

export function getCachedIdenticonCells(key: string): IdenticonCell[] {
  if (!identiconCache.has(key)) {
    identiconCache.set(key, identiconCells(key));
  }
  return identiconCache.get(key)!;
}
