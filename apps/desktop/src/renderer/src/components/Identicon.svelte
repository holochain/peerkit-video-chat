<script lang="ts">
  import { identiconCells, peerColorFromId } from '../lib/identicon.js';

  let { agentId, size = 22 }: { agentId: string; size?: number } = $props();

  const cells = $derived(identiconCells(agentId));
  const color = $derived(peerColorFromId(agentId));
</script>

<svg
  viewBox="0 0 5 5"
  width={size}
  height={size}
  shape-rendering="crispEdges"
  preserveAspectRatio="xMidYMid slice"
  style="display:block"
>
  {#each cells as cell (cell.x + ',' + cell.y)}
    <rect x={cell.x} y={cell.y} width="1.02" height="1.02" fill={color} />
  {/each}
</svg>
