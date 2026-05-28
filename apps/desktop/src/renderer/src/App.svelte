<script lang="ts">
  import Topbar from './components/Topbar.svelte';
  import ToastStack from './components/ToastStack.svelte';
  import type { Toast } from './components/ToastStack.svelte';
  import IdentityScreen from './screens/IdentityScreen.svelte';
  import LobbyScreen from './screens/LobbyScreen.svelte';
  import PreJoinScreen from './screens/PreJoinScreen.svelte';
  import CallScreen from './screens/CallScreen.svelte';
  import {
    setStreamCallback,
    setSpeakingCallback,
    setMuted,
    setCamMuted,
    handleSignal,
    initiateCall,
    closeAll,
  } from './webrtc.js';
  import { remoteStreams, speakingPeers } from './lib/stores.js';

  declare const __APP_VERSION__: string;

  type Screen = 'identity' | 'lobby' | 'prejoin' | 'call';
  type ThemePref = 'system' | 'light' | 'dark';
  type ThemeResolved = 'dark' | 'light';

  interface SavedRoom {
    name: string;
    lastUsed: number;
  }

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

  // ── State ───────────────────────────────────────────────────────

  let screen = $state<Screen>('identity');
  let selfName = $state('');
  let selfAgentId = $state('');
  let relayAddr = $state('');
  let currentRoom = $state<string | null>(null);
  let joinTime = $state(0);
  let selfMic = $state(true);
  let selfCam = $state(true);
  interface ActiveRoom {
    name: string;
    members: Array<{ agentId: string; displayName: string }>;
  }

  let roomMembers = $state<RoomMember[]>([]);
  let chatMessages = $state<ChatMessage[]>([]);
  let savedRooms = $state<SavedRoom[]>(loadSavedRooms());
  let activeRooms = $state<ActiveRoom[]>([]);

  // Toasts
  let toasts = $state<Toast[]>([]);

  function pushToast(message: string, kind: Toast['kind'] = 'error') {
    const id = String(Date.now() + Math.random());
    toasts = [...toasts, { id, message, kind }];
    setTimeout(() => { toasts = toasts.filter(t => t.id !== id); }, 5000);
  }

  function dismissToast(id: string) {
    toasts = toasts.filter(t => t.id !== id);
  }

  function toastMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return 'An unexpected error occurred';
  }

  // Theme
  let themePref = $state<ThemePref>(
    (localStorage.getItem('pkvc:theme') as ThemePref) || 'system'
  );
  let systemDark = $state(
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  );
  const themeResolved = $derived<ThemeResolved>(
    themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref
  );

  // ── Persistence helpers ─────────────────────────────────────────

  function loadSavedRooms(): SavedRoom[] {
    try {
      return JSON.parse(localStorage.getItem('pkvc:savedRooms') ?? '[]') as SavedRoom[];
    } catch {
      return [];
    }
  }

  function persistSavedRooms(rooms: SavedRoom[]) {
    localStorage.setItem('pkvc:savedRooms', JSON.stringify(rooms));
  }

  // ── Theme setup ─────────────────────────────────────────────────

  $effect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => { systemDark = mq.matches; };
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  });

  // ── WebRTC callbacks ────────────────────────────────────────────

  $effect(() => {
    setStreamCallback((agentId, stream) => {
      if (stream === null) {
        remoteStreams.update(m => {
          const n = new Map(m);
          n.delete(agentId);
          return n;
        });
      } else {
        remoteStreams.update(m => {
          const n = new Map(m);
          n.set(agentId, stream);
          return n;
        });
      }
    });

    setSpeakingCallback((agentId, speaking) => {
      speakingPeers.update(s => {
        const n = new Set(s);
        if (speaking) n.add(agentId); else n.delete(agentId);
        return n;
      });
    });
  });

  // ── WebRTC call initiation ──────────────────────────────────────
  // Peers we have already initiated or accepted a call with this session.
  // Plain Set (not $state) — used only for deduplication, not for rendering.
  let knownPeers = new Set<string>();

  $effect(() => {
    if (screen !== 'call') {
      knownPeers = new Set();
      return;
    }
    for (const m of roomMembers) {
      if (m.agentId === selfAgentId) continue;
      if (!knownPeers.has(m.agentId)) {
        knownPeers.add(m.agentId);
        // Lower agent ID is the offerer — prevents both sides calling simultaneously.
        if (selfAgentId < m.agentId) {
          initiateCall(m.agentId).catch((err: unknown) => {
            pushToast(toastMessage(err));
          });
        }
      }
    }
  });

  // ── IPC event handlers ──────────────────────────────────────────

  $effect(() => {
    const unsubState = window.app.onState((view) => {
      if (view.kind === 'inRoom') {
        roomMembers = view.members.map(m => ({
          agentId: m.agentId,
          displayName: m.displayName,
        }));
      } else {
        roomMembers = [];
      }
    });

    const unsubNetworkRooms = window.app.onNetworkRooms((rooms) => {
      activeRooms = rooms;
    });

    const unsubChat = window.app.onChat((incoming) => {
      // skip echo of own messages — we add them optimistically in onSendChat
      if (incoming.from === selfAgentId) return;
      chatMessages = [
        ...chatMessages,
        {
          id: 'chat-' + Date.now() + '-' + Math.random(),
          agentId: incoming.from,
          displayName: incoming.displayName,
          body: incoming.body,
          t: incoming.ts,
        },
      ];
    });

    const unsubSignal = window.app.onSignal((fromAgent, signal) => {
      handleSignal(fromAgent, signal).catch((err: unknown) => {
        console.warn('handleSignal error:', err);
      });
    });

    return () => {
      unsubState();
      unsubNetworkRooms();
      unsubChat();
      unsubSignal();
    };
  });

  // ── State machine handlers ──────────────────────────────────────

  async function onSetUsername(name: string) {
    selfName = name;
    try {
      const result = await window.app.init(name);
      selfAgentId = result.agentId;
      relayAddr = result.relayAddr;
      screen = 'lobby';
    } catch (err) {
      pushToast(toastMessage(err));
    }
  }

  function onJoinRoom(roomName: string) {
    const normalized = roomName.trim().toLowerCase();
    // Bump or add saved room
    const existing = savedRooms.find(r => r.name === normalized);
    if (existing) {
      savedRooms = [
        { ...existing, lastUsed: Date.now() },
        ...savedRooms.filter(r => r.name !== normalized),
      ];
    } else {
      savedRooms = [{ name: normalized, lastUsed: Date.now() }, ...savedRooms];
    }
    persistSavedRooms(savedRooms);
    currentRoom = normalized;
    screen = 'prejoin';
  }

  function onCreateRoom(roomName: string) {
    onJoinRoom(roomName);
  }

  function onRemoveSaved(name: string) {
    savedRooms = savedRooms.filter(r => r.name !== name);
    persistSavedRooms(savedRooms);
  }

  async function onConfirmJoin(audio: boolean, video: boolean) {
    selfMic = audio;
    selfCam = video;
    setMuted(!audio);
    try {
      await setCamMuted(!video);
      await window.app.joinRoom(currentRoom!);
      joinTime = Date.now();
      screen = 'call';
    } catch (err) {
      pushToast(toastMessage(err));
    }
  }

  async function onLeave() {
    try {
      await window.app.leaveRoom();
    } catch (err) {
      pushToast(toastMessage(err), 'warn');
    }
    closeAll();
    currentRoom = null;
    chatMessages = [];
    screen = 'lobby';
  }

  function onToggleMic() {
    setMuted(selfMic);
    selfMic = !selfMic;
  }

  async function onToggleCam() {
    try {
      await setCamMuted(selfCam);
      selfCam = !selfCam;
    } catch (err) {
      pushToast(toastMessage(err));
    }
  }

  async function onSendChat(body: string) {
    try {
      await window.app.sendChat(body);
      // Also show in our own chat immediately (optimistic)
      chatMessages = [
        ...chatMessages,
        {
          id: 'self-chat-' + Date.now(),
          agentId: selfAgentId,
          displayName: selfName,
          body,
          t: Date.now(),
        },
      ];
    } catch (err) {
      pushToast(toastMessage(err), 'warn');
    }
  }

  function onSetTheme(pref: ThemePref) {
    themePref = pref;
    localStorage.setItem('pkvc:theme', pref);
  }
</script>

<div class="app" data-theme={themeResolved} data-density="spacious">
  {#if screen !== 'identity'}
    <Topbar
      {selfName}
      {selfAgentId}
      {relayAddr}
      {themePref}
      {onSetTheme}
    />
  {/if}
  <div class="page">
    {#if screen === 'identity'}
      <IdentityScreen onContinue={onSetUsername} />
    {:else if screen === 'lobby'}
      <LobbyScreen
        {selfName}
        {savedRooms}
        {activeRooms}
        appVersion={__APP_VERSION__}
        onJoin={onJoinRoom}
        onCreate={onCreateRoom}
        {onRemoveSaved}
      />
    {:else if screen === 'prejoin'}
      <PreJoinScreen
        {selfAgentId}
        {selfName}
        {currentRoom}
        {selfMic}
        {selfCam}
        activeMembers={activeRooms.find(r => r.name === currentRoom)?.members ?? []}
        onToggleAudio={onToggleMic}
        onToggleVideo={onToggleCam}
        onJoin={onConfirmJoin}
        onBack={() => { currentRoom = null; screen = 'lobby'; }}
        onError={(err) => pushToast(toastMessage(err))}
      />
    {:else if screen === 'call'}
      <CallScreen
        {selfAgentId}
        {selfName}
        {selfMic}
        {selfCam}
        {currentRoom}
        {roomMembers}
        {joinTime}
        {chatMessages}
        {onToggleMic}
        {onToggleCam}
        {onLeave}
        onSendChat={onSendChat}
      />
    {/if}
  </div>
  <ToastStack {toasts} onDismiss={dismissToast} />
</div>
