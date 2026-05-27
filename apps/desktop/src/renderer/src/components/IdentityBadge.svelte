<script lang="ts">
  import Identicon from './Identicon.svelte';
  import { shortId } from '../lib/helpers.js';

  let {
    agentId,
    username,
    onclick,
  }: {
    agentId: string;
    username: string;
    onclick: () => void;
  } = $props();
</script>

<button
  class="idbadge"
  onclick={onclick}
  title="View your agent identity"
  type="button"
>
  <span class="idbadge-avatar">
    <Identicon {agentId} size={18} />
  </span>
  <span class="idbadge-name">{username}</span>
  <span class="idbadge-key font-mono">{shortId(agentId)}</span>
</button>
