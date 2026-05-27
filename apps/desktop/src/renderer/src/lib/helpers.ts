// helpers.ts — utility functions for the UI

/** Returns a short version of an agentId: first 6 chars + "…" + last 4 chars */
export function shortId(agentId: string): string {
  if (agentId.length <= 10) return agentId;
  return agentId.slice(0, 6) + '…' + agentId.slice(-4);
}

/** Formats a timestamp as "3:45pm" */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

/** Formats a timestamp relative to now: "just now", "5m ago", "2h ago", etc. */
export function formatRelative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return 'just now';
  if (dt < 60 * M) return Math.floor(dt / M) + 'm ago';
  if (dt < 24 * H) return Math.floor(dt / H) + 'h ago';
  if (dt < 7 * D) return Math.floor(dt / D) + 'd ago';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Generates initials from a name: "MR" from "mira" or "Maria R" */
export function makeInitials(name: string): string {
  const parts = name.trim().split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
