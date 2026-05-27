<script lang="ts">
  let {
    onContinue,
  }: {
    onContinue: (name: string) => void;
  } = $props();

  let name = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  const canContinue = $derived(name.trim().length > 0);

  $effect(() => {
    inputEl?.focus();
  });

  function submit(e?: SubmitEvent) {
    e?.preventDefault();
    if (canContinue) onContinue(name.trim());
  }
</script>

<div class="identity">
  <form class="identity-card" onsubmit={submit}>
    <div class="identity-eyebrow">
      <span class="dot"></span>
      <span>peerkit-video-chat · first run</span>
    </div>
    <h1 class="font-display">Pick a name to show your peers.</h1>
    <div class="identity-sub">
      Your username is broadcast over peerkit so peers can recognize you.
      It doesn't have to be unique — your agent identity is unique and shown in the app.
    </div>

    <label class="field-label" for="username-input">Username</label>
    <input
      id="username-input"
      bind:this={inputEl}
      class="field"
      type="text"
      placeholder="e.g. mira"
      bind:value={name}
      autocomplete="off"
      spellcheck={false}
      maxlength={32}
    />

    <div class="identity-actions">
      <button
        class="btn primary"
        type="submit"
        disabled={!canContinue}
        style="flex:1"
      >
        Continue
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  </form>
</div>
