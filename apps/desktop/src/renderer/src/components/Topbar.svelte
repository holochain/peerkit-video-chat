<script lang="ts">
  import IdentityBadge from './IdentityBadge.svelte';
  import IdentityPopover from './IdentityPopover.svelte';
  import SettingsPopover from './SettingsPopover.svelte';

  let {
    selfName,
    selfAgentId,
    themePref,
    onSetTheme,
  }: {
    selfName: string;
    selfAgentId: string;
    themePref: 'system' | 'light' | 'dark';
    onSetTheme: (pref: 'system' | 'light' | 'dark') => void;
  } = $props();

  let settingsOpen = $state(false);
  let idOpen = $state(false);

  function toggleSettings() {
    settingsOpen = !settingsOpen;
    if (settingsOpen) idOpen = false;
  }

  function toggleId() {
    idOpen = !idOpen;
    if (idOpen) settingsOpen = false;
  }
</script>

<div class="topbar">
  <div class="brand">
    <span class="brand-dot"></span>
    <span class="brand-name">peerkit</span>
    <span class="brand-slash">/</span>
    <span>video-chat</span>
  </div>

  <div class="topbar-spacer"></div>

  <div class="net-status">
    <span class="pulse"></span>
    <span>connected · disc.peerkit.dev</span>
  </div>

  <div style="position:relative">
    <button
      class="topbar-btn"
      onclick={toggleSettings}
      aria-label="Settings"
      title="Settings"
      type="button"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.55V3a2 2 0 0 1 4 0v.09A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.27.6.83 1 1.55 1.03H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1.03z" />
      </svg>
    </button>
    {#if settingsOpen}
      <SettingsPopover
        {themePref}
        onSetTheme={onSetTheme}
        onClose={() => { settingsOpen = false; }}
      />
    {/if}
  </div>

  <div style="position:relative">
    <IdentityBadge
      agentId={selfAgentId}
      username={selfName}
      onclick={toggleId}
    />
    {#if idOpen}
      <IdentityPopover
        agentId={selfAgentId}
        onClose={() => { idOpen = false; }}
      />
    {/if}
  </div>
</div>
