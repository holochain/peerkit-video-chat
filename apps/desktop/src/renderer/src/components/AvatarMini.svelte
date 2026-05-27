<script lang="ts">
  import Identicon from './Identicon.svelte';

  let {
    agentId,
    size = 22,
    withBorder = true,
    title = '',
  }: {
    agentId: string;
    size?: number;
    withBorder?: boolean;
    title?: string;
  } = $props();
</script>

<div
  class="avatar-mini"
  style="width:{size}px;height:{size}px;{withBorder ? '' : 'border:0'}"
  {title}
>
  <Identicon {agentId} {size} />
</div>
