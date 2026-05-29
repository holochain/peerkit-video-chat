<script lang="ts">
  import IdentityBadge from './IdentityBadge.svelte';
  import IdentityPopover from './IdentityPopover.svelte';
  import SettingsPopover from './SettingsPopover.svelte';
  import { shortRelayAddr } from '../lib/helpers.js';
  import type { PeerStats } from '@peerkit-video-chat/core';

  type DeviceKind = 'camera' | 'microphone' | 'speaker';

  let {
    selfName,
    selfAgentId,
    relayAddr,
    peerStats,
    themePref,
    onSetTheme,
    deviceIds,
    onSetDevice,
  }: {
    selfName: string;
    selfAgentId: string;
    relayAddr: string;
    peerStats: PeerStats | null;
    themePref: 'system' | 'light' | 'dark';
    onSetTheme: (pref: 'system' | 'light' | 'dark') => void;
    deviceIds: Record<DeviceKind, string>;
    onSetDevice: (kind: DeviceKind, id: string) => void;
  } = $props();

  const relayDisplay = $derived(relayAddr ? shortRelayAddr(relayAddr) : '…');

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

  {#if peerStats}
    <div class="peers" tabindex="0" role="status" aria-label="{peerStats.discovered} peers online">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span class="peers-count">{peerStats.discovered}</span>
      <span class="peers-label">online</span>
      <div class="peers-tip" role="tooltip">
        <div class="peers-tip-row"><strong>{peerStats.discovered}</strong> discovered</div>
        <div class="peers-tip-row"><strong>{peerStats.connected}</strong> connected</div>
        <div class="peers-tip-sub">{peerStats.direct} direct · {peerStats.relayed} relayed</div>
      </div>
    </div>
  {/if}

  <div class="net-status">
    <span class="pulse" class:pulse--off={!relayAddr}></span>
    {#if relayAddr}
      <span>connected · {relayDisplay}</span>
    {:else}
      <span>disconnected</span>
    {/if}
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
        {deviceIds}
        {onSetDevice}
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
