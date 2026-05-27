<script lang="ts">
  import { formatRelative } from '../lib/helpers.js';
  import AvatarMini from '../components/AvatarMini.svelte';

  interface SavedRoom {
    name: string;
    lastUsed: number;
  }

  interface ActiveRoom {
    name: string;
    members: Array<{ agentId: string; displayName: string }>;
  }

  let {
    selfName,
    savedRooms,
    activeRooms = [],
    onJoin,
    onCreate,
    onRemoveSaved,
  }: {
    selfName: string;
    savedRooms: SavedRoom[];
    activeRooms?: ActiveRoom[];
    onJoin: (roomName: string) => void;
    onCreate: (roomName: string) => void;
    onRemoveSaved: (roomName: string) => void;
  } = $props();

  let draft = $state('');

  function submit(e?: SubmitEvent) {
    e?.preventDefault();
    const name = sanitize(draft.trim());
    if (!name || !name.replace(/-/g, '')) return;
    onCreate(name);
    draft = '';
  }

  function sanitize(val: string): string {
    return val.replace(/\s+/g, '-');
  }

  const savedNames = $derived(new Set(savedRooms.map(r => r.name)));

  // Live rooms sorted: saved ones first, then by member count desc
  const liveRoomsSorted = $derived(
    [...activeRooms].sort((a, b) => {
      const aS = savedNames.has(a.name) ? 0 : 1;
      const bS = savedNames.has(b.name) ? 0 : 1;
      if (aS !== bS) return aS - bS;
      return b.members.length - a.members.length;
    })
  );

  // Saved rooms that aren't currently live (de-dup)
  const liveNames = $derived(new Set(activeRooms.map(r => r.name)));
  const savedRoomsOffline = $derived(savedRooms.filter(r => !liveNames.has(r.name)));

  const eyebrow = $derived(
    `${activeRooms.length} live ${activeRooms.length === 1 ? 'room' : 'rooms'} · ${savedRooms.length} saved`
  );
</script>

<div class="lobby" data-layout="cards">
  <div class="lobby-head">
    <div class="center-col">
      <div class="lobby-eyebrow">
        <span style="color:var(--accent)">●</span>
        {eyebrow}
      </div>
      <h1 class="font-display">Hey {selfName} — where to?</h1>
      <div class="lobby-sub">Join a room someone's already in, or spin up a new one.</div>
    </div>
  </div>

  <div class="lobby-body">
    <div class="center-col">
      <form class="create-row" onsubmit={submit}>
        <span class="create-prefix">#</span>
        <input
          class="field"
          type="text"
          placeholder="new-room-name"
          value={draft}
          oninput={(e) => { draft = sanitize((e.target as HTMLInputElement).value); }}
          autocomplete="off"
          spellcheck={false}
          maxlength={48}
        />
        <button class="btn primary" type="submit" disabled={!draft.trim()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Create room
        </button>
      </form>

      <!-- ── Live now ──────────────────────────────────────── -->
      <div class="section-head">
        <div class="section-title">
          {#if liveRoomsSorted.length > 0}
            <span class="live-dot"></span>
          {/if}
          Live now <span class="count">{liveRoomsSorted.length}</span>
        </div>
        <div class="section-rule"></div>
      </div>

      <div class="room-list">
        {#each liveRoomsSorted as room (room.name)}
          {@const isSaved = savedNames.has(room.name)}
          {@const shown = room.members.slice(0, 4)}
          {@const extra = room.members.length - shown.length}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="room"
            onclick={() => onJoin(room.name)}
            role="button"
            tabindex={0}
            onkeydown={(e) => { if (e.key === 'Enter') onJoin(room.name); }}
          >
            <div class="room-info">
              <div class="row1">
                <span class="room-name">#{room.name}</span>
                {#if isSaved}
                  <span class="been-here">saved</span>
                {/if}
              </div>
              <div class="room-meta">
                <span>{room.members.length} {room.members.length === 1 ? 'participant' : 'participants'}</span>
                {#if room.members.length > 0}
                  <span class="sep">·</span>
                  <div class="avatar-stack">
                    {#each shown as m}
                      <AvatarMini agentId={m.agentId} size={22} title={m.displayName} />
                    {/each}
                    {#if extra > 0}
                      <div class="avatar-mini more" style="width:22px;height:22px">+{extra}</div>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
            <div class="room-footer">
              <button
                class="btn sm"
                onclick={(e) => { e.stopPropagation(); onJoin(room.name); }}
                type="button"
              >
                Join
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </div>
        {:else}
          <div style="padding:18px;color:var(--fg-3);font-size:13px;font-style:italic">
            No one's in a room right now.
          </div>
        {/each}
      </div>

      <!-- ── Saved rooms ───────────────────────────────────── -->
      <div class="section-head" style="margin-top:28px">
        <div class="section-title">
          Your saved rooms <span class="count">{savedRoomsOffline.length}</span>
        </div>
        <div class="section-rule"></div>
      </div>

      <div class="room-list">
        {#each savedRoomsOffline as room (room.name)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="room"
            onclick={() => onJoin(room.name)}
            role="button"
            tabindex={0}
            onkeydown={(e) => { if (e.key === 'Enter') onJoin(room.name); }}
          >
            <div class="room-info">
              <div class="row1">
                <span class="room-name">#{room.name}</span>
              </div>
              <div class="room-meta">
                <span style="color:var(--fg-3)">empty</span>
                <span class="sep">·</span>
                <span>last visited {formatRelative(room.lastUsed)}</span>
              </div>
            </div>
            <div class="room-footer">
              <div style="display:flex;align-items:center;gap:6px">
                <button
                  class="room-remove"
                  title="Remove from saved"
                  onclick={(e) => { e.stopPropagation(); onRemoveSaved(room.name); }}
                  aria-label="Remove from saved rooms"
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                </button>
                <button
                  class="btn sm"
                  onclick={(e) => { e.stopPropagation(); onJoin(room.name); }}
                  type="button"
                >
                  Join
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        {:else}
          <div style="padding:18px;color:var(--fg-3);font-size:13px;font-style:italic">
            Nothing here. Rooms you've joined will show up here.
          </div>
        {/each}
      </div>

      <div class="lobby-footer">
        <!-- svelte-ignore a11y_invalid_attribute -->
        <a href="#" onclick={(e) => e.preventDefault()}>peerkit.dev</a>
        <span class="dot">·</span>
        <!-- svelte-ignore a11y_invalid_attribute -->
        <a href="#" onclick={(e) => e.preventDefault()}>Report an issue</a>
        <span class="dot">·</span>
        <!-- svelte-ignore a11y_invalid_attribute -->
        <a href="#" onclick={(e) => e.preventDefault()}>What's new</a>
        <span style="flex:1"></span>
        <span class="ver">v0.4.2</span>
      </div>
    </div>
  </div>
</div>
