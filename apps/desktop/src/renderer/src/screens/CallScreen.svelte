<script lang="ts">
  import { onDestroy } from 'svelte';
  import AvatarMini from '../components/AvatarMini.svelte';
  import ChatOverlay from '../components/ChatOverlay.svelte';
  import { get } from 'svelte/store';
  import { remoteStreams, speakingPeers } from '../lib/stores.js';
  import { shortId, makeInitials } from '../lib/helpers.js';
  import { getLocalStream } from '../webrtc.js';

  interface RoomMember {
    agentId: string;
    displayName: string;
  }

  interface ChatMessage {
    id: string;
    agentId: string;
    displayName: string;
    body: string;
    t: number;
  }

  let {
    selfAgentId,
    selfName,
    selfMic,
    selfCam,
    currentRoom,
    roomMembers,
    joinTime,
    chatMessages,
    onToggleMic,
    onToggleCam,
    onLeave,
    onSendChat,
  }: {
    selfAgentId: string;
    selfName: string;
    selfMic: boolean;
    selfCam: boolean;
    currentRoom: string | null;
    roomMembers: RoomMember[];
    joinTime: number;
    chatMessages: ChatMessage[];
    onToggleMic: () => void;
    onToggleCam: () => void;
    onLeave: () => void;
    onSendChat: (body: string) => void;
  } = $props();

  let chatOpen = $state(false);
  let unread = $state(0);
  let now = $state(Date.now());
  let gridContainerEl = $state<HTMLDivElement | null>(null);
  let gridDims = $state({ w: 0, h: 0 });
  let lastSeenCount = $state(0);

  // Clock tick
  const clockInterval = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(clockInterval));

  // Resize observer for grid container
  $effect(() => {
    const el = gridContainerEl;
    if (!el) return;
    const update = () => { gridDims = { w: el.clientWidth, h: el.clientHeight }; };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Reset unread when chat opens
  $effect(() => {
    if (chatOpen) unread = 0;
  });

  // Track new chat messages when chat is closed
  $effect(() => {
    const count = chatMessages.length;
    if (!chatOpen && count > lastSeenCount) {
      unread += count - lastSeenCount;
    }
    lastSeenCount = count;
  });

  // Build all tiles: self first, then remote members
  const allTiles = $derived(
    [
      { agentId: selfAgentId, displayName: selfName, isSelf: true },
      ...roomMembers
        .filter(m => m.agentId !== selfAgentId)
        .map(m => ({ agentId: m.agentId, displayName: m.displayName, isSelf: false })),
    ]
  );

  // Equal grid layout style
  const gridStyle = $derived(() => {
    const n = allTiles.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    const gap = 14;
    if (gridDims.w === 0) return '';
    const maxByW = (gridDims.w - (cols - 1) * gap) / cols;
    const maxByH = ((gridDims.h - (rows - 1) * gap) / rows) * (16 / 9);
    const tileW = Math.max(80, Math.floor(Math.min(maxByW, maxByH)));
    const tileH = Math.floor(tileW * 9 / 16);
    return `grid-template-columns:repeat(${cols},${tileW}px);grid-auto-rows:${tileH}px;gap:${gap}px;justify-content:center;align-content:center`;
  });

  // Timer string
  const timerStr = $derived(() => {
    const e = Math.max(0, Math.floor((now - joinTime) / 1000));
    const mm = String(Math.floor(e % 3600 / 60)).padStart(2, '0');
    const ss = String(e % 60).padStart(2, '0');
    const hh = e >= 3600 ? String(Math.floor(e / 3600)).padStart(2, '0') + ':' : '';
    return `${hh}${mm}:${ss}`;
  });

  // Svelte action to bind video srcObject reactively
  function videoSrc(el: HTMLVideoElement, agentId: string) {
    function setStream() {
      if (agentId === selfAgentId) {
        el.srcObject = getLocalStream();
      } else {
        const streams = get(remoteStreams);
        el.srcObject = streams.get(agentId) ?? null;
      }
    }
    setStream();

    const unsub = remoteStreams.subscribe(() => {
      setStream();
    });

    return {
      update(newAgentId: string) {
        agentId = newAgentId;
        setStream();
      },
      destroy() {
        unsub();
        el.srcObject = null;
      },
    };
  }
</script>

<div class="call">
  <div class="call-head">
    <div class="room-label">
      <span class="label">In room</span>
      <span class="name">{currentRoom}</span>
    </div>
    <span class="timer">{timerStr()}</span>
    <div class="roster">
      <div style="display:inline-flex;align-items:center">
        {#each allTiles.slice(0, 6) as tile (tile.agentId)}
          <AvatarMini agentId={tile.agentId} size={22} title={tile.displayName} />
        {/each}
      </div>
      <span>{allTiles.length} {allTiles.length === 1 ? 'participant' : 'participants'}</span>
    </div>
  </div>

  <div class="stage">
    <div
      class="grid-equal"
      bind:this={gridContainerEl}
      style={gridStyle()}
    >
      {#each allTiles as tile (tile.agentId)}
        {@const isSelf = tile.isSelf}
        {@const speaking = $speakingPeers.has(tile.agentId)}
        {@const hasMic = isSelf ? selfMic : true}
        {@const hasCam = isSelf ? selfCam : ($remoteStreams.has(tile.agentId) && $remoteStreams.get(tile.agentId)!.getVideoTracks().length > 0)}
        <div
          class="tile {speaking ? 'speaking' : ''}"
          data-indicator="wave"
        >
          <div class="tile-content {(isSelf && !selfCam) ? 'cam-off' : (!isSelf && !hasCam) ? 'cam-off' : ''}">
            {#if isSelf && selfCam}
              <video
                autoplay
                muted
                playsinline
                style="width:100%;height:100%;object-fit:cover;display:block;transform:scaleX(-1)"
                use:videoSrc={tile.agentId}
              ></video>
            {:else if !isSelf && hasCam}
              <video
                autoplay
                playsinline
                style="width:100%;height:100%;object-fit:cover;display:block"
                use:videoSrc={tile.agentId}
              ></video>
            {:else}
              <span class="initials">{makeInitials(tile.displayName)}</span>
            {/if}
          </div>

          <!-- Speaking indicators -->
          <div class="tile-speak-ring"></div>
          <div class="tile-speak-glow"></div>
          <div class="tile-speak-wave">
            <svg class="wave-svg" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true">
              <path class="wave-back"  d="M-50 22 Q-25 14 0 22 T50 22 T100 22 T150 22 T200 22 T250 22 T300 22 T350 22 T400 22 T450 22 L450 40 L-50 40 Z" />
              <path class="wave-front" d="M-75 28 Q-50 22 -25 28 T25 28 T75 28 T125 28 T175 28 T225 28 T275 28 T325 28 T375 28 T425 28 L425 40 L-75 40 Z" />
            </svg>
          </div>

          <div class="tile-state">
            {#if !hasMic}
              <span class="badge off" title="muted">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 3l18 18" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <path d="M15 12V6a3 3 0 0 0-6 0v1" />
                  <path d="M19 11a7 7 0 0 1-.78 3.2" />
                  <path d="M12 18v3" />
                  <path d="M5 11a7 7 0 0 0 10.42 6.12" />
                </svg>
              </span>
            {/if}
          </div>

          <div class="tile-meta">
            <AvatarMini agentId={tile.agentId} size={18} withBorder={false} />
            <span class="name">{tile.displayName}</span>
            {#if isSelf}
              <span class="self-tag">you</span>
            {:else}
              <span class="key font-mono">{shortId(tile.agentId)}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="call-controls">
    <div class="cc-group">
      <button
        class="cc-btn"
        data-on={selfMic ? 'true' : 'false'}
        onclick={onToggleMic}
        aria-label={selfMic ? 'Mute mic' : 'Unmute mic'}
        type="button"
      >
        {#if selfMic}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3" />
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3l18 18" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
            <path d="M15 12V6a3 3 0 0 0-6 0v1" />
            <path d="M19 11a7 7 0 0 1-.78 3.2" />
            <path d="M12 18v3" />
            <path d="M5 11a7 7 0 0 0 10.42 6.12" />
          </svg>
        {/if}
        <span class="cc-label">{selfMic ? 'Mute' : 'Unmute'}</span>
      </button>

      <button
        class="cc-btn"
        data-on={selfCam ? 'true' : 'false'}
        onclick={onToggleCam}
        aria-label={selfCam ? 'Stop video' : 'Start video'}
        type="button"
      >
        {#if selfCam}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="6" width="13" height="12" rx="2" />
            <path d="M16 10l5-3v10l-5-3z" />
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3l18 18" />
            <path d="M16 16H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
            <path d="M11 6h3a2 2 0 0 1 2 2v2.5" />
            <path d="M16 10l5-3v10l-3-1.8" />
          </svg>
        {/if}
        <span class="cc-label">{selfCam ? 'Stop video' : 'Start video'}</span>
      </button>

      <div class="cc-divider"></div>

      <button
        class="cc-btn"
        onclick={() => { chatOpen = !chatOpen; }}
        aria-label="Chat"
        type="button"
        style={chatOpen ? 'background:var(--accent-tint);color:var(--accent)' : ''}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a8 8 0 0 1-12.3 6.74L4 20l1.26-4.7A8 8 0 1 1 21 12z" />
        </svg>
        {#if unread > 0 && !chatOpen}
          <span class="badge-dot"></span>
        {/if}
        <span class="cc-label">Chat{unread > 0 ? ` · ${unread} new` : ''}</span>
      </button>

      <div class="cc-divider"></div>

      <button
        class="cc-btn leave"
        onclick={onLeave}
        aria-label="Leave"
        type="button"
        style="width:auto;padding:0 18px;border-radius:999px;gap:8px;display:inline-flex;font-weight:600"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        Leave
      </button>
    </div>

    {#if chatOpen}
      <ChatOverlay
        messages={chatMessages}
        selfAgentId={selfAgentId}
        onSend={onSendChat}
        onClose={() => { chatOpen = false; }}
      />
    {/if}
  </div>
</div>
