<script lang="ts">
  let {
    agentId,
    onClose,
  }: {
    agentId: string;
    onClose: () => void;
  } = $props();

  let copied = $state(false);
  let popEl = $state<HTMLDivElement | null>(null);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(agentId);
      copied = true;
      setTimeout(() => { copied = false; }, 1400);
    } catch (_) {}
  }

  $effect(() => {
    const onDown = (e: MouseEvent) => {
      if (popEl && !popEl.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
    };
  });
</script>

<div class="id-pop" bind:this={popEl}>
  <div class="id-pop-title">Your agent identity</div>
  <div class="id-pop-key">{agentId}</div>
  <div class="id-pop-foot">
    <span>created locally · owned by you</span>
    <button
      class="id-pop-copy {copied ? 'ok' : ''}"
      onclick={copy}
      type="button"
    >
      {#if copied}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12l5 5L20 6" />
        </svg>
        copied
      {:else}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        copy
      {/if}
    </button>
  </div>
</div>
