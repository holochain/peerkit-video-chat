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
    relayConnected,
    peerStats,
    themePref,
    onSetTheme,
    deviceIds,
    onSetDevice,
  }: {
    selfName: string;
    selfAgentId: string;
    relayAddr: string;
    relayConnected: boolean;
    peerStats: PeerStats | null;
    themePref: 'system' | 'light' | 'dark';
    onSetTheme: (pref: 'system' | 'light' | 'dark') => void;
    deviceIds: Record<DeviceKind, string>;
    onSetDevice: (kind: DeviceKind, id: string) => void;
  } = $props();

  const relayDisplay = $derived(relayAddr ? shortRelayAddr(relayAddr) : '…');

  let settingsOpen = $state(false);
  let idOpen = $state(false);
  let peersOpen = $state(false);

  function toggleSettings() {
    settingsOpen = !settingsOpen;
    if (settingsOpen) { idOpen = false; peersOpen = false; }
  }

  function toggleId() {
    idOpen = !idOpen;
    if (idOpen) { settingsOpen = false; peersOpen = false; }
  }

  let peersEl = $state<HTMLDivElement | null>(null);

  function togglePeers() {
    peersOpen = !peersOpen;
    if (peersOpen) { settingsOpen = false; idOpen = false; }
  }

  $effect(() => {
    if (!peersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (peersEl && !peersEl.contains(e.target as Node)) peersOpen = false;
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
    };
  });

  // Connected peers first, then by name (falling back to agentId).
  const sortedPeers = $derived(
    [...(peerStats?.peers ?? [])].sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected) ||
        (a.displayName ?? a.agentId).localeCompare(b.displayName ?? b.agentId),
    ),
  );

  function peerStatus(p: { connected: boolean; direct: boolean }): string {
    if (!p.connected) return 'discovered';
    return p.direct ? 'direct' : 'relayed';
  }

  // Count every peer we currently know exists — connected or merely discovered
  // via the agent store. A connected peer is online by definition, so this never
  // shows fewer "online" than "connected" (the agent store can lack a record for
  // a peer we are still connected to, e.g. after its TTL expired).
  const onlineCount = $derived(peerStats?.peers.length ?? 0);
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
    <div style="position:relative" bind:this={peersEl}>
      <button
        class="peers"
        onclick={togglePeers}
        aria-label="{onlineCount} peers online — show details"
        aria-expanded={peersOpen}
        type="button"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span class="peers-count">{onlineCount}</span>
        <span class="peers-label">online</span>
      </button>
      {#if peersOpen}
        <div class="peers-panel" role="dialog" aria-label="Peers">
          <div class="peers-panel-head">
            <span><strong>{peerStats.connected}</strong> connected</span>
            <span class="peers-panel-sub">{peerStats.direct} direct · {peerStats.relayed} relayed</span>
            <span class="peers-panel-sub">{peerStats.discovered} in agent store</span>
          </div>
          <ul class="peers-list">
            {#each sortedPeers as p (p.agentId)}
              <li class="peer-row">
                <span class="peer-dot peer-dot--{peerStatus(p)}"></span>
                <span class="peer-id-block">
                  <span class="peer-name">{p.displayName ?? 'unknown'}</span>
                  <span class="peer-id" title={p.agentId}>{p.agentId.slice(0, 16)}</span>
                </span>
                <span class="peer-badge peer-badge--{peerStatus(p)}">{peerStatus(p)}</span>
              </li>
            {:else}
              <li class="peers-empty">No peers yet</li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}

  <div class="net-status">
    <span class="pulse" class:pulse--off={!relayConnected}></span>
    {#if !relayAddr}
      <span>disconnected</span>
    {:else if relayConnected}
      <span>connected · {relayDisplay}</span>
    {:else}
      <span>connecting · {relayDisplay}</span>
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
