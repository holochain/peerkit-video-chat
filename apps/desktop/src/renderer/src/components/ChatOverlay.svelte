<script lang="ts">
  import { peerColorFromId } from '../lib/identicon.js';
  import { shortId, formatClock } from '../lib/helpers.js';

  interface ChatMessage {
    id: string;
    agentId: string;
    displayName: string;
    body: string;
    t: number;
  }

  let {
    messages,
    selfAgentId,
    onSend,
    onClose,
  }: {
    messages: ChatMessage[];
    selfAgentId: string;
    onSend: (body: string) => void;
    onClose: () => void;
  } = $props();

  let draft = $state('');
  const SIZES = ['s', 'm', 'l'] as const;
  const storedSize = localStorage.getItem('pkvc:chatSize');
  let size = $state<'s' | 'm' | 'l'>(
    SIZES.includes(storedSize as 's' | 'm' | 'l') ? (storedSize as 's' | 'm' | 'l') : 'm'
  );
  let streamEl = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  const nextSize: Record<string, 's' | 'm' | 'l'> = { s: 'm', m: 'l', l: 's' };

  function cycleSize() {
    size = nextSize[size] || 'm';
    localStorage.setItem('pkvc:chatSize', size);
  }

  $effect(() => {
    // scroll to bottom when messages change
    const _ = messages.length;
    if (streamEl) {
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  });

  $effect(() => {
    inputEl?.focus();
  });

  function submit(e?: SubmitEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    draft = '';
  }
</script>

<div
  class="chat-overlay"
  data-size={size}
  onclick={(e) => e.stopPropagation()}
  role="dialog"
  aria-label="Room chat"
>
  <div class="chat-head">
    <div>
      <div class="title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a8 8 0 0 1-12.3 6.74L4 20l1.26-4.7A8 8 0 1 1 21 12z" />
        </svg>
        Room chat
      </div>
      <div class="meta">Sent to everyone here</div>
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <button
        class="x"
        onclick={cycleSize}
        aria-label="Resize chat"
        title="Resize chat"
        type="button"
      >
        {#if size === 'l'}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        {:else}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9V3h6" />
            <path d="M21 15v6h-6" />
            <path d="M3 3l7 7" />
            <path d="M21 21l-7-7" />
          </svg>
        {/if}
      </button>
      <button class="x" onclick={onClose} aria-label="Close chat" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </div>

  <div class="chat-notice">
    Messages are live only — nothing here from before you joined, and nothing
    kept after you leave.
  </div>

  <div class="chat-stream" bind:this={streamEl}>
    {#each messages as msg (msg.id)}
      {@const isSelf = msg.agentId === selfAgentId}
      {@const color = peerColorFromId(msg.agentId)}
      <div class="chat-msg {isSelf ? 'self' : ''}">
        <div class="chat-msg-head">
          <span class="name">
            <span class="who-dot" style="background:{color}"></span>
            {msg.displayName}
            {#if isSelf}
              <span style="color:var(--fg-3);font-size:10px;font-family:'JetBrains Mono',monospace;margin-left:4px">you</span>
            {/if}
          </span>
          <span class="key font-mono">{shortId(msg.agentId)}</span>
          <span class="time">{formatClock(msg.t)}</span>
        </div>
        <p class="chat-msg-body">{msg.body}</p>
      </div>
    {/each}
  </div>

  <form class="chat-input" onsubmit={submit}>
    <input
      bind:this={inputEl}
      type="text"
      placeholder="Send to everyone…"
      bind:value={draft}
      maxlength={500}
    />
    <button
      class="chat-send"
      type="submit"
      disabled={!draft.trim()}
      aria-label="Send"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5" />
        <path d="M6 11l6-6 6 6" />
      </svg>
    </button>
  </form>
</div>
